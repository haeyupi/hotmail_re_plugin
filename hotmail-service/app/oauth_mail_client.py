from __future__ import annotations

import email
import imaplib
import re
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timezone
from email.header import decode_header
from email.message import Message
from email.utils import parsedate_to_datetime
from typing import Iterable

import requests

from .accounts import Account
from .code_extractor import extract_code, make_preview, normalize_text
from .models import FetchResult

GRAPH_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
IMAP_TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token"
AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
IMAP_SERVER_NEW = "outlook.live.com"
IMAP_SERVER_OLD = "outlook.office365.com"
IMAP_PORT = 993
GRAPH_MESSAGE_SCAN_LIMIT = 8
OAUTH_SCOPES = [
    "offline_access",
    "https://graph.microsoft.com/Mail.Read",
    "https://graph.microsoft.com/User.Read",
    "https://outlook.office.com/IMAP.AccessAsUser.All",
]


@dataclass(slots=True, frozen=True)
class MailMessage:
    folder: str
    subject: str | None
    sender: str | None
    received_at: str | None
    received_at_ms: int | None
    preview: str | None
    body: str | None


def normalize_access_method(value: str | None) -> str:
    normalized = (value or "auto").strip().lower()
    if normalized in {"graph", "imap_new", "imap_old", "playwright", "auto"}:
        return normalized
    return "auto"


def get_oauth_authorize_url(client_id: str, redirect_uri: str) -> str:
    params = {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "response_mode": "query",
        "scope": " ".join(OAUTH_SCOPES),
    }
    return f"{AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"


def exchange_authorization_code(client_id: str, redirect_uri: str, code: str) -> dict:
    response = requests.post(
        GRAPH_TOKEN_URL,
        data={
            "client_id": client_id,
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "scope": " ".join(OAUTH_SCOPES),
        },
        timeout=30,
    )
    payload = response.json() if response.content else {}
    if response.status_code != 200:
        detail = payload.get("error_description") or payload or response.text
        raise ValueError(f"Token exchange failed: {detail}")
    return payload


def extract_code_from_callback_url(callback_url: str) -> str:
    parsed = urllib.parse.urlparse(callback_url)
    query = urllib.parse.parse_qs(parsed.query)
    code_values = query.get("code")
    if not code_values or not code_values[0]:
        raise ValueError("Authorization code was not found in callback_url.")
    return code_values[0]


def can_use_oauth(account: Account) -> bool:
    return bool(account.client_id and account.refresh_token)


def fetch_code_via_oauth(
    account: Account,
    *,
    max_wait_seconds: int,
    poll_interval_seconds: int,
    min_created_at_ms: int | None = None,
    exclude_codes: Iterable[str] | None = None,
) -> FetchResult:
    method = normalize_access_method(account.access_method)
    if not can_use_oauth(account):
        return FetchResult(status="mailbox_load_failed", source="oauth", reason="Missing client_id or refresh_token.")

    excluded_codes = {code.strip() for code in (exclude_codes or []) if code and code.strip()}
    methods = _resolve_attempt_order(method)
    deadline = datetime.now(tz=timezone.utc).timestamp() + max_wait_seconds
    last_failure_reason = "No mailbox reader method produced a verification code."

    while datetime.now(tz=timezone.utc).timestamp() <= deadline:
      results: list[FetchResult] = []
      for reader_method in methods:
          reader_result = _fetch_once(account, reader_method)
          if isinstance(reader_result, FetchResult):
              if reader_result.status != "ok":
                  last_failure_reason = reader_result.reason or last_failure_reason
                  continue
              results.append(
                  _accept_fetch_result(
                      reader_result,
                      min_created_at_ms=min_created_at_ms,
                      exclude_codes=excluded_codes,
                  )
              )
          else:
              for candidate in reader_result:
                  code, matched_regex = extract_code(
                      "\n".join(part for part in (candidate.subject, candidate.sender, candidate.preview, candidate.body) if part)
                  )
                  if not code:
                      continue
                  result = FetchResult(
                      status="ok",
                      source=reader_method,
                      folder=candidate.folder,
                      subject=candidate.subject,
                      sender=candidate.sender,
                      received_at=candidate.received_at,
                      received_at_ms=candidate.received_at_ms,
                      code=code,
                      matched_regex=matched_regex,
                      preview=candidate.preview,
                  )
                  accepted = _accept_fetch_result(
                      result,
                      min_created_at_ms=min_created_at_ms,
                      exclude_codes=excluded_codes,
                  )
                  if accepted.status == "ok":
                      results.append(accepted)
                  else:
                      last_failure_reason = accepted.reason or last_failure_reason

      best = _pick_best_result(results)
      if best is not None:
          return best

      if datetime.now(tz=timezone.utc).timestamp() + poll_interval_seconds > deadline:
          break
      import time
      time.sleep(poll_interval_seconds)

    return FetchResult(status="no_code_found", source=method, reason=last_failure_reason)


def list_messages_via_oauth(account: Account) -> tuple[str, list[MailMessage]]:
    method = normalize_access_method(account.access_method)
    if not can_use_oauth(account):
        raise ValueError("Missing client_id or refresh_token.")

    last_failure_reason = "No mailbox reader method produced a message list."
    for reader_method in _resolve_attempt_order(method):
        reader_result = _fetch_once(account, reader_method)
        if isinstance(reader_result, FetchResult):
            last_failure_reason = reader_result.reason or last_failure_reason
            continue
        messages = sorted(
            reader_result,
            key=lambda item: (item.received_at_ms or 0, 1 if item.folder == "Inbox" else 0),
            reverse=True,
        )
        return reader_method, messages

    raise RuntimeError(last_failure_reason)


def _resolve_attempt_order(method: str) -> list[str]:
    if method == "graph":
        return ["graph"]
    if method == "imap_new":
        return ["imap_new"]
    if method == "imap_old":
        return ["imap_old"]
    return ["graph", "imap_new", "imap_old"]


def _accept_fetch_result(
    result: FetchResult,
    *,
    min_created_at_ms: int | None,
    exclude_codes: set[str],
) -> FetchResult:
    if result.code and result.code in exclude_codes:
        return FetchResult(status="no_code_found", source=result.source, reason="Found only excluded verification codes.")
    if min_created_at_ms and result.received_at_ms and result.received_at_ms <= min_created_at_ms:
        return FetchResult(status="no_code_found", source=result.source, reason="Found only old verification emails.")
    return result


def _pick_best_result(results: list[FetchResult]) -> FetchResult | None:
    if not results:
        return None

    def sort_key(item: FetchResult):
        folder_priority = 1 if item.folder == "Inbox" else 0
        timestamp = item.received_at_ms or 0
        return (timestamp, folder_priority)

    return max(results, key=sort_key)


def _fetch_once(account: Account, method: str) -> list[MailMessage] | FetchResult:
    try:
        if method == "graph":
            return _fetch_graph_messages(account)
        if method == "imap_new":
            return _fetch_imap_messages(account, IMAP_SERVER_NEW)
        if method == "imap_old":
            return _fetch_imap_messages(account, IMAP_SERVER_OLD)
        return FetchResult(status="mailbox_load_failed", source=method, reason=f"Unsupported oauth method: {method}")
    except ValueError as exc:
        return FetchResult(status="login_failed", source=method, reason=str(exc))
    except Exception as exc:
        return FetchResult(status="mailbox_load_failed", source=method, reason=str(exc))


def _fetch_graph_messages(account: Account) -> list[MailMessage]:
    access_token = _exchange_graph_access_token(account.client_id, account.refresh_token)
    messages: list[MailMessage] = []
    for folder, folder_name in (("Inbox", "inbox"), ("Junk Email", "junkemail")):
        response = requests.get(
            f"https://graph.microsoft.com/v1.0/me/mailFolders/{folder_name}/messages",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Prefer": "outlook.body-content-type='text'",
            },
            params={
                "$top": GRAPH_MESSAGE_SCAN_LIMIT,
                "$select": "id,subject,from,receivedDateTime,bodyPreview",
                "$orderby": "receivedDateTime desc",
            },
            timeout=30,
        )
        payload = response.json() if response.content else {}
        if response.status_code != 200:
            detail = payload.get("error", {}).get("message") or payload or response.text
            raise RuntimeError(f"Graph mailbox request failed for {folder_name}: {detail}")
        for item in payload.get("value", []):
            sender = (
                item.get("from", {})
                .get("emailAddress", {})
                .get("address")
            )
            received_at = item.get("receivedDateTime")
            messages.append(
                MailMessage(
                    folder=folder,
                    subject=normalize_text(item.get("subject")),
                    sender=normalize_text(sender),
                    received_at=received_at,
                    received_at_ms=_parse_iso_datetime_ms(received_at),
                    preview=make_preview(item.get("bodyPreview")),
                    body=normalize_text(item.get("bodyPreview")),
                )
            )
    return messages


def _fetch_imap_messages(account: Account, server: str) -> list[MailMessage]:
    access_token = _exchange_imap_access_token(account.client_id, account.refresh_token)
    connection = imaplib.IMAP4_SSL(server, IMAP_PORT)
    auth_string = f"user={account.email}\1auth=Bearer {access_token}\1\1".encode("utf-8")
    try:
        connection.authenticate("XOAUTH2", lambda _: auth_string)
        messages: list[MailMessage] = []
        for folder, folder_options in (
            ("Inbox", ['"INBOX"', "INBOX"]),
            ("Junk Email", ['"Junk"', '"Junk Email"', "Junk", '"垃圾邮件"']),
        ):
            selected = False
            for folder_name in folder_options:
                try:
                    status, _ = connection.select(folder_name, readonly=True)
                    if status == "OK":
                        selected = True
                        break
                except Exception:
                    continue
            if not selected:
                continue
            status, raw_ids = connection.search(None, "ALL")
            if status != "OK" or not raw_ids or not raw_ids[0]:
                continue
            message_ids = raw_ids[0].split()[-GRAPH_MESSAGE_SCAN_LIMIT:][::-1]
            for msg_id in message_ids:
                status, msg_data = connection.fetch(msg_id, "(RFC822)")
                if status != "OK" or not msg_data or not msg_data[0]:
                    continue
                raw_email = msg_data[0][1]
                msg = email.message_from_bytes(raw_email)
                body = _get_email_body(msg)
                received_at = normalize_text(msg.get("Date"))
                messages.append(
                    MailMessage(
                        folder=folder,
                        subject=_decode_header_value(msg.get("Subject", "")),
                        sender=_decode_header_value(msg.get("From", "")),
                        received_at=received_at,
                        received_at_ms=_parse_email_date_ms(received_at),
                        preview=make_preview(body),
                        body=body,
                    )
                )
        return messages
    finally:
        try:
            connection.logout()
        except Exception:
            pass


def _exchange_graph_access_token(client_id: str, refresh_token: str) -> str:
    response = requests.post(
        GRAPH_TOKEN_URL,
        data={
            "client_id": client_id,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "scope": "https://graph.microsoft.com/.default",
        },
        timeout=30,
    )
    payload = response.json() if response.content else {}
    if response.status_code != 200:
        detail = payload.get("error_description") or payload.get("error") or payload or response.text
        raise ValueError(f"Graph token exchange failed: {detail}")
    token = payload.get("access_token")
    if not token:
        raise ValueError("Graph token exchange did not return access_token.")
    return token


def _exchange_imap_access_token(client_id: str, refresh_token: str) -> str:
    response = requests.post(
        IMAP_TOKEN_URL,
        data={
            "client_id": client_id,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "scope": "https://outlook.office.com/IMAP.AccessAsUser.All offline_access",
        },
        timeout=30,
    )
    payload = response.json() if response.content else {}
    if response.status_code != 200:
        detail = payload.get("error_description") or payload.get("error") or payload or response.text
        raise ValueError(f"IMAP token exchange failed: {detail}")
    token = payload.get("access_token")
    if not token:
        raise ValueError("IMAP token exchange did not return access_token.")
    return token


def _decode_header_value(value: str) -> str:
    if not value:
        return ""
    decoded = []
    for part, charset in decode_header(str(value)):
        if isinstance(part, bytes):
            try:
                decoded.append(part.decode(charset or "utf-8", "replace"))
            except Exception:
                decoded.append(part.decode("utf-8", "replace"))
        else:
            decoded.append(str(part))
    return normalize_text("".join(decoded))


def _get_email_body(msg: Message) -> str:
    if msg.is_multipart():
        parts: list[str] = []
        for part in msg.walk():
            content_type = part.get_content_type()
            disposition = (part.get("Content-Disposition") or "").lower()
            if "attachment" in disposition:
                continue
            if content_type in {"text/plain", "text/html"}:
                payload = part.get_payload(decode=True) or b""
                charset = part.get_content_charset() or "utf-8"
                try:
                    parts.append(payload.decode(charset, "replace"))
                except Exception:
                    parts.append(payload.decode("utf-8", "replace"))
        return normalize_text("\n".join(parts))
    payload = msg.get_payload(decode=True) or b""
    charset = msg.get_content_charset() or "utf-8"
    try:
        return normalize_text(payload.decode(charset, "replace"))
    except Exception:
        return normalize_text(payload.decode("utf-8", "replace"))


def _parse_iso_datetime_ms(value: str | None) -> int | None:
    if not value:
        return None
    try:
        normalized = value.replace("Z", "+00:00")
        return int(datetime.fromisoformat(normalized).timestamp() * 1000)
    except Exception:
        return None


def _parse_email_date_ms(value: str | None) -> int | None:
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp() * 1000)
    except Exception:
        return None
