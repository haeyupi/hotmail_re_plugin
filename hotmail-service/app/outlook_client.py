from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from playwright.sync_api import BrowserContext, Error, Page, TimeoutError, sync_playwright

from .accounts import Account
from .code_extractor import extract_code, make_preview, normalize_text
from .config import Settings
from .models import FetchResult
from .oauth_mail_client import can_use_oauth, fetch_code_via_oauth, list_messages_via_oauth, normalize_access_method
from .session_cache import SessionStateCache

LOGGER = logging.getLogger(__name__)
LOGIN_URL = "https://login.live.com/"
MESSAGE_SCAN_LIMIT = 6
STANDARD_TIMEZONE = "Asia/Shanghai"
TIMEZONE_LOOKUP_URLS = (
    ("ipinfo", "https://ipinfo.io/json", "timezone"),
    ("ipapi", "https://ipapi.co/json/", "timezone"),
)
WEEKDAY_ORDER = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
WEEKDAY_ALIASES = {
    "mon": 0,
    "monday": 0,
    "lunes": 0,
    "lundi": 0,
    "montag": 0,
    "lunedì": 0,
    "lunedi": 0,
    "понедельник": 0,
    "月曜日": 0,
    "월요일": 0,
    "seg": 0,
    "segunda": 0,
    "segunda-feira": 0,
    "周一": 0,
    "星期一": 0,
    "tue": 1,
    "tuesday": 1,
    "martes": 1,
    "mardi": 1,
    "dienstag": 1,
    "martedì": 1,
    "martedi": 1,
    "вторник": 1,
    "火曜日": 1,
    "화요일": 1,
    "ter": 1,
    "terça": 1,
    "terca": 1,
    "terça-feira": 1,
    "terca-feira": 1,
    "周二": 1,
    "星期二": 1,
    "wed": 2,
    "wednesday": 2,
    "miércoles": 2,
    "miercoles": 2,
    "mercredi": 2,
    "mittwoch": 2,
    "mercoledì": 2,
    "mercoledi": 2,
    "среда": 2,
    "水曜日": 2,
    "수요일": 2,
    "qua": 2,
    "quarta": 2,
    "quarta-feira": 2,
    "周三": 2,
    "星期三": 2,
    "thu": 3,
    "thursday": 3,
    "jueves": 3,
    "jeudi": 3,
    "donnerstag": 3,
    "giovedì": 3,
    "giovedi": 3,
    "четверг": 3,
    "木曜日": 3,
    "목요일": 3,
    "qui": 3,
    "quinta": 3,
    "quinta-feira": 3,
    "周四": 3,
    "星期四": 3,
    "fri": 4,
    "friday": 4,
    "viernes": 4,
    "vendredi": 4,
    "freitag": 4,
    "venerdì": 4,
    "venerdi": 4,
    "пятница": 4,
    "金曜日": 4,
    "금요일": 4,
    "sex": 4,
    "sexta": 4,
    "sexta-feira": 4,
    "周五": 4,
    "星期五": 4,
    "sat": 5,
    "saturday": 5,
    "sábado": 5,
    "sabado": 5,
    "samedi": 5,
    "samstag": 5,
    "sabato": 5,
    "суббота": 5,
    "土曜日": 5,
    "토요일": 5,
    "sab": 5,
    "周六": 5,
    "星期六": 5,
    "sun": 6,
    "sunday": 6,
    "domingo": 6,
    "dimanche": 6,
    "sonntag": 6,
    "domenica": 6,
    "воскресенье": 6,
    "日曜日": 6,
    "일요일": 6,
    "dom": 6,
    "周日": 6,
    "星期日": 6,
}

MAILBOX_READY_SELECTORS = (
    '[role="main"]',
    '[aria-label*="Folder"]',
    '[aria-label*="Message list"]',
    'div[role="grid"]',
    'div[role="treegrid"]',
)

FOLDER_ALIASES = {
    "Inbox": (
        "Inbox",
        "收件箱",
        "Caixa de Entrada",
        "Bandeja de entrada",
        "Boîte de réception",
        "Boite de réception",
        "Posteingang",
        "Posta in arrivo",
        "Входящие",
        "受信トレイ",
        "받은 편지함",
    ),
    "Junk Email": (
        "Junk Email",
        "Junk E-mail",
        "垃圾邮件",
        "Lixo Eletrônico",
        "Lixo Eletronico",
        "Correo no deseado",
        "Courrier indésirable",
        "Courrier indesirable",
        "Junk-E-Mail",
        "Posta indesiderata",
        "Спам",
        "迷惑メール",
        "정크 메일",
        "스팸 메일",
    ),
}

SECURITY_CHALLENGE_PATTERNS = (
    "help us protect your account",
    "verify your identity",
    "approve sign in request",
    "recover your account",
    "add security info",
    "security challenge",
    "captcha",
    "verify your account",
    "protect your account",
    "use your phone",
    "security info",
    "your account has been locked",
    "account has been locked",
    "let's prove you're human",
    "show you're human",
    "press and hold the button",
    "microsoft services agreement",
)

LOGIN_FAILED_PATTERNS = (
    "your account or password is incorrect",
    "password is incorrect",
    "that microsoft account doesn't exist",
    "this username may be incorrect",
    "sign-in was blocked",
    "we couldn't find an account",
)


@dataclass(slots=True)
class MessageSnapshot:
    folder: str
    subject: str | None
    sender: str | None
    received_at: str | None
    body_text: str
    preview: str | None


@dataclass(slots=True)
class ListMessageSnapshot:
    folder: str
    summary_text: str
    subject: str | None
    sender: str | None
    received_at: str | None
    preview: str | None
    conversation_id: str | None


@dataclass(slots=True)
class MailboxMessage:
    folder: str
    subject: str | None
    sender: str | None
    received_at: str | None
    received_at_ms: int | None
    preview: str | None
    body: str | None
    source: str


class OutlookWebFetcher:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.session_cache = SessionStateCache(settings.session_state_dir)
        self._reference_timezone: ZoneInfo | None = None
        self._reference_timezone_source: str | None = None

    def release_session(self, account: Account) -> tuple[bool, Path]:
        path = self.session_cache.storage_state_path(account)
        existed = path.exists()
        self.session_cache.invalidate(account)
        return existed, path

    def _should_fallback_to_playwright(self, account: Account, access_method: str) -> bool:
        return access_method in {"auto", "graph"} and bool(account.password)

    def list_messages(self, account: Account, limit: int = 50) -> tuple[str, list[MailboxMessage]]:
        normalized_limit = max(1, min(limit, 200))
        access_method = normalize_access_method(account.access_method)
        should_fallback_to_playwright = self._should_fallback_to_playwright(account, access_method)

        if access_method != "playwright" and can_use_oauth(account):
            try:
                resolved_method, messages = list_messages_via_oauth(account)
                if should_fallback_to_playwright and not messages:
                    raise RuntimeError(f"{resolved_method} returned no mailbox messages.")
                return (
                    resolved_method,
                    [
                        MailboxMessage(
                            folder=message.folder,
                            subject=message.subject,
                            sender=message.sender,
                            received_at=message.received_at,
                            received_at_ms=message.received_at_ms,
                            preview=message.preview,
                            body=message.body,
                            source=resolved_method,
                        )
                        for message in messages[:normalized_limit]
                    ],
                )
            except Exception:
                if not should_fallback_to_playwright:
                    raise

        if not account.password:
            raise RuntimeError("Password login is unavailable for this account.")

        return self._list_messages_via_playwright(account, normalized_limit)

    def _create_diagnostics(
        self,
        account: Account,
        request_context: dict | None,
        min_created_at_ms: int | None,
        exclude_codes: set[str],
    ) -> dict:
        context = dict(request_context or {})
        context.setdefault("account", account.id)
        context.setdefault("email", account.email)
        context["exclude_codes"] = sorted(exclude_codes)
        context["min_created_at_ms"] = min_created_at_ms
        return {
            "request": context,
            "candidate_count": 0,
            "filtered_reason_counts": {},
            "filtered_samples": [],
        }

    def _record_filtered_candidate(
        self,
        diagnostics: dict | None,
        *,
        folder: str,
        code: str,
        reason: str,
        received_at: str | None,
        sender: str | None,
        subject: str | None,
    ) -> None:
        if diagnostics is None:
            return
        counts = diagnostics.setdefault("filtered_reason_counts", {})
        counts[reason] = counts.get(reason, 0) + 1
        samples = diagnostics.setdefault("filtered_samples", [])
        if len(samples) < 10:
            samples.append(
                {
                    "folder": folder,
                    "code": code,
                    "reason": reason,
                    "received_at": received_at,
                    "sender": sender,
                    "subject": subject,
                }
            )

    def _log_failure_diagnostics(self, diagnostics: dict) -> None:
        request_info = diagnostics.get("request", {})
        LOGGER.warning(
            "Fetch failed for endpoint=%s account=%s email=%s min_created_at_ms=%s exclude_codes=%s candidate_count=%s filtered_reasons=%s result=%s",
            request_info.get("endpoint"),
            request_info.get("account"),
            request_info.get("email"),
            request_info.get("min_created_at_ms"),
            request_info.get("exclude_codes"),
            diagnostics.get("candidate_count"),
            diagnostics.get("filtered_reason_counts"),
            diagnostics.get("result"),
        )

    def fetch_code(
        self,
        account: Account,
        max_wait_seconds: int,
        poll_interval_seconds: int,
        min_created_at_ms: int | None = None,
        exclude_codes: list[str] | None = None,
        request_context: dict | None = None,
    ) -> FetchResult:
        request_name = self._artifact_basename(account)
        artifact_dir = self.settings.artifacts_dir / request_name
        console_messages: list[dict] = []
        page: Page | None = None
        context: BrowserContext | None = None
        excluded_codes = {code.strip() for code in (exclude_codes or []) if code and code.strip()}
        diagnostics = self._create_diagnostics(account, request_context, min_created_at_ms, excluded_codes)

        access_method = normalize_access_method(account.access_method)
        should_fallback_to_playwright = self._should_fallback_to_playwright(account, access_method)
        if access_method != "playwright" and can_use_oauth(account):
            oauth_result = fetch_code_via_oauth(
                account,
                max_wait_seconds=max_wait_seconds,
                poll_interval_seconds=poll_interval_seconds,
                min_created_at_ms=min_created_at_ms,
                exclude_codes=excluded_codes,
            )
            if oauth_result.status == "ok":
                return oauth_result
            if not should_fallback_to_playwright:
                diagnostics["result"] = oauth_result.to_dict()
                self._log_failure_diagnostics(diagnostics)
                return oauth_result

        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=self.settings.headless)
                storage_state_path = self.session_cache.fresh_path_for(account)
                context_kwargs = {"storage_state": str(storage_state_path)} if storage_state_path is not None else {}
                context = browser.new_context(**context_kwargs)
                context.set_default_timeout(self.settings.action_timeout_ms)
                context.set_default_navigation_timeout(self.settings.navigation_timeout_ms)
                context.tracing.start(screenshots=True, snapshots=True)
                page = context.new_page()
                page.on("console", lambda message: console_messages.append(self._serialize_console(message)))

                if storage_state_path is not None and self._resume_cached_session(page):
                    login_result = None
                else:
                    login_result = self._login(page, account)
                if login_result is not None and storage_state_path is not None:
                    self.session_cache.invalidate(account)
                    try:
                        context.close()
                    except Exception:
                        pass
                    context = browser.new_context()
                    context.set_default_timeout(self.settings.action_timeout_ms)
                    context.set_default_navigation_timeout(self.settings.navigation_timeout_ms)
                    context.tracing.start(screenshots=True, snapshots=True)
                    page = context.new_page()
                    page.on("console", lambda message: console_messages.append(self._serialize_console(message)))
                    login_result = self._login(page, account)
                if login_result is not None:
                    self.session_cache.invalidate(account)
                    diagnostics["result"] = login_result.to_dict()
                    self._log_failure_diagnostics(diagnostics)
                    self._save_failure_artifacts(artifact_dir, page, context, console_messages, diagnostics)
                    browser.close()
                    return login_result
                self.session_cache.save(context, account)

                deadline = time.monotonic() + max_wait_seconds
                inspected_mailbox = False
                while time.monotonic() <= deadline:
                    folder_results: list[FetchResult] = []
                    for folder_name in ("Inbox", "Junk Email"):
                        opened = self._open_folder(page, folder_name)
                        if not opened:
                            continue
                        inspected_mailbox = True

                        result = self._scan_folder_for_code(
                            page,
                            folder_name,
                            min_created_at_ms=min_created_at_ms,
                            exclude_codes=excluded_codes,
                            diagnostics=diagnostics,
                        )
                        if result is not None:
                            folder_results.append(result)

                    if folder_results:
                        best_result = max(folder_results, key=self._result_sort_key)
                        context.tracing.stop()
                        browser.close()
                        return best_result

                    if self._detect_security_challenge(page):
                        self.session_cache.invalidate(account)
                        result = FetchResult(status="security_challenge", reason="Microsoft prompted for additional verification.")
                        diagnostics["result"] = result.to_dict()
                        self._log_failure_diagnostics(diagnostics)
                        self._save_failure_artifacts(artifact_dir, page, context, console_messages, diagnostics)
                        browser.close()
                        return result

                    page.reload(wait_until="domcontentloaded")
                    time.sleep(poll_interval_seconds)

                result = FetchResult(
                    status="no_code_found" if inspected_mailbox else "timeout",
                    reason=f"No verification code was found in the first {MESSAGE_SCAN_LIMIT} Inbox or Junk Email messages."
                    if inspected_mailbox
                    else "Timed out while waiting for a matching message.",
                )
                diagnostics["result"] = result.to_dict()
                self._log_failure_diagnostics(diagnostics)
                self._save_failure_artifacts(artifact_dir, page, context, console_messages, diagnostics)
                browser.close()
                return result
        except TimeoutError as exc:
            LOGGER.exception("Timed out while fetching code for %s", account.email)
            if context is not None:
                result = FetchResult(status="mailbox_load_failed", reason=f"Timeout while loading Outlook Web: {exc}")
                diagnostics["result"] = result.to_dict()
                self._log_failure_diagnostics(diagnostics)
                self._save_failure_artifacts(artifact_dir, page, context, console_messages, diagnostics)
                return result
            return FetchResult(status="mailbox_load_failed", reason=f"Timeout while loading Outlook Web: {exc}")
        except Error as exc:
            LOGGER.exception("Playwright error while fetching code for %s", account.email)
            if context is not None:
                result = FetchResult(status="mailbox_load_failed", reason=f"Playwright error: {exc}")
                diagnostics["result"] = result.to_dict()
                self._log_failure_diagnostics(diagnostics)
                self._save_failure_artifacts(artifact_dir, page, context, console_messages, diagnostics)
                return result
            return FetchResult(status="mailbox_load_failed", reason=f"Playwright error: {exc}")
        except Exception as exc:  # pragma: no cover - defensive
            LOGGER.exception("Unexpected error while fetching code for %s", account.email)
            if context is not None:
                result = FetchResult(status="mailbox_load_failed", reason=f"Unexpected error: {exc}")
                diagnostics["result"] = result.to_dict()
                self._log_failure_diagnostics(diagnostics)
                self._save_failure_artifacts(artifact_dir, page, context, console_messages, diagnostics)
                return result
            return FetchResult(status="mailbox_load_failed", reason=f"Unexpected error: {exc}")

    def _list_messages_via_playwright(self, account: Account, limit: int) -> tuple[str, list[MailboxMessage]]:
        context: BrowserContext | None = None
        page: Page | None = None
        messages: list[MailboxMessage] = []

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=self.settings.headless)
            try:
                storage_state_path = self.session_cache.fresh_path_for(account)
                context_kwargs = {"storage_state": str(storage_state_path)} if storage_state_path is not None else {}
                context = browser.new_context(**context_kwargs)
                context.set_default_timeout(self.settings.action_timeout_ms)
                context.set_default_navigation_timeout(self.settings.navigation_timeout_ms)
                page = context.new_page()

                if storage_state_path is not None and self._resume_cached_session(page):
                    login_result = None
                else:
                    login_result = self._login(page, account)
                if login_result is not None and storage_state_path is not None:
                    self.session_cache.invalidate(account)
                    context.close()
                    context = browser.new_context()
                    context.set_default_timeout(self.settings.action_timeout_ms)
                    context.set_default_navigation_timeout(self.settings.navigation_timeout_ms)
                    page = context.new_page()
                    login_result = self._login(page, account)
                if login_result is not None:
                    self.session_cache.invalidate(account)
                    raise RuntimeError(login_result.reason or "Unable to open Outlook mailbox.")

                self.session_cache.save(context, account)
                per_folder_limit = max(1, min(limit, 100))
                for folder_name in ("Inbox", "Junk Email"):
                    if not self._open_folder(page, folder_name):
                        continue
                    messages.extend(self._collect_folder_messages(page, folder_name, per_folder_limit))

                messages.sort(key=lambda item: (item.received_at_ms or 0, 1 if item.folder == "Inbox" else 0), reverse=True)
                return "playwright", messages[:limit]
            finally:
                if context is not None:
                    try:
                        context.close()
                    except Exception:
                        pass
                browser.close()

    def _login(self, page: Page, account: Account) -> FetchResult | None:
        page.goto(self.settings.outlook_url, wait_until="domcontentloaded")
        if self._is_mailbox_ready(page):
            return None
        if self._detect_security_challenge(page):
            return FetchResult(
                status="security_challenge",
                reason="Microsoft locked the account or requested human verification before sign-in.",
            )
        if not self._has_login_form(page):
            page.goto(LOGIN_URL, wait_until="domcontentloaded")
            self._wait_a_moment(page)
            if self._detect_security_challenge(page):
                return FetchResult(
                    status="security_challenge",
                    reason="Microsoft locked the account or requested human verification before sign-in.",
                )
            if not self._has_login_form(page):
                return FetchResult(status="login_failed", reason="Could not find the Microsoft sign-in form.")

        self._fill_first(page, ('input[name="loginfmt"]', 'input[type="email"]', 'input[name="username"]'), account.email)
        if not self._click_first(page, ('#idSIButton9', 'input[type="submit"]', 'button[type="submit"]', 'button:has-text("Next")', 'button:has-text("Sign in")')):
            return FetchResult(status="login_failed", reason="Could not find the Microsoft sign-in submit button.")

        self._wait_a_moment(page)
        if self._detect_security_challenge(page):
            return FetchResult(status="security_challenge", reason="Microsoft requested additional verification before password entry.")
        if self._detect_login_failed(page):
            return FetchResult(status="login_failed", reason="Microsoft rejected the email or username.")

        self._fill_first(page, ('input[name="passwd"]', 'input[type="password"]'), account.password)
        if not self._click_first(page, ('#idSIButton9', 'input[type="submit"]', 'button[type="submit"]', 'button:has-text("Next")', 'button:has-text("Sign in")')):
            return FetchResult(status="login_failed", reason="Could not submit the password form.")

        deadline = time.monotonic() + self.settings.login_timeout_seconds
        while time.monotonic() <= deadline:
            self._dismiss_post_login_prompts(page)
            if not self._is_mailbox_ready(page) and "outlook.live.com/mail" not in page.url:
                page.goto(self.settings.outlook_url, wait_until="domcontentloaded")
                self._wait_a_moment(page)
            if self._is_mailbox_ready(page):
                return None
            if self._detect_security_challenge(page):
                return FetchResult(status="security_challenge", reason="Microsoft requested additional verification after password entry.")
            if self._detect_login_failed(page):
                return FetchResult(status="login_failed", reason="Microsoft rejected the password.")
            time.sleep(1)
        return FetchResult(
            status="login_failed",
            reason=(
                f"Login did not reach the mailbox within {self.settings.login_timeout_seconds}s. "
                f"Last URL: {page.url}"
            ),
        )

    def _resume_cached_session(self, page: Page) -> bool:
        page.goto(self.settings.outlook_url, wait_until="domcontentloaded")
        deadline = time.monotonic() + 4
        while time.monotonic() <= deadline:
            self._dismiss_post_login_prompts(page)
            if self._is_mailbox_ready(page):
                return True
            if self._has_login_form(page) or self._detect_security_challenge(page) or self._detect_login_failed(page):
                return False
            page.wait_for_timeout(200)
        return self._is_mailbox_ready(page)

    def _dismiss_post_login_prompts(self, page: Page) -> None:
        for selector in (
            '#idBtn_Back',
            'button:has-text("No")',
            'input[value="No"]',
            'button:has-text("OK")',
            'input[value="OK"]',
            'button:has-text("Continue")',
            'button:has-text("Next")',
        ):
            locator = page.locator(selector).first
            if self._click_locator_if_visible(locator):
                return

    def _is_mailbox_ready(self, page: Page) -> bool:
        parsed_url = urlparse(page.url or "")
        if parsed_url.netloc.lower() != "outlook.live.com" or not parsed_url.path.startswith("/mail"):
            return False
        for selector in MAILBOX_READY_SELECTORS:
            locator = page.locator(selector).first
            try:
                if locator.count() and locator.is_visible():
                    return True
            except Error:
                continue
        try:
            if self._message_row_locators(page, limit=1):
                return True
        except Error:
            pass
        body_text = normalize_text(page.locator("body").inner_text())
        mailbox_markers = (
            "Inbox",
            "Focused",
            "Other",
            "Junk Email",
            "收件箱",
            "垃圾邮件",
            "Caixa de Entrada",
            "Lixo Eletrônico",
            "Lixo Eletronico",
            "Destaques",
            "Outros",
            "Bandeja de entrada",
            "Correo no deseado",
            "Boîte de réception",
            "Boite de réception",
            "Courrier indésirable",
            "Courrier indesirable",
            "Posteingang",
            "Junk-E-Mail",
            "Posta in arrivo",
            "Posta indesiderata",
            "Входящие",
            "Спам",
            "受信トレイ",
            "迷惑メール",
            "받은 편지함",
            "정크 메일",
            "스팸 메일",
        )
        return any(marker in body_text for marker in mailbox_markers)

    def _has_login_form(self, page: Page) -> bool:
        for selector in ('input[name="loginfmt"]', 'input[type="email"]', 'input[name="passwd"]', 'input[type="password"]'):
            locator = page.locator(selector).first
            try:
                if locator.count():
                    return True
            except Error:
                continue
        return False

    def _open_folder(self, page: Page, folder_name: str) -> bool:
        aliases = FOLDER_ALIASES[folder_name]
        for alias in aliases:
            treeitem = page.get_by_role("treeitem", name=re.compile(f"^{re.escape(alias)}$", re.I)).first
            if self._click_locator_if_visible(treeitem):
                self._wait_for_message_list(page)
                return True
            text_locator = page.get_by_text(alias, exact=True).first
            if self._click_locator_if_visible(text_locator):
                self._wait_for_message_list(page)
                return True
        return False

    def _wait_for_message_list(self, page: Page) -> None:
        self._find_visible_locator(page, ('[aria-label*="Message list"]', 'div[role="grid"]', 'div[role="treegrid"]'))
        deadline = time.monotonic() + 3
        while time.monotonic() <= deadline:
            if self._message_row_locators(page, limit=1):
                return
            page.wait_for_timeout(200)

    def _scan_folder_for_code(
        self,
        page: Page,
        folder_name: str,
        min_created_at_ms: int | None = None,
        exclude_codes: set[str] | None = None,
        diagnostics: dict | None = None,
    ) -> FetchResult | None:
        message_rows = self._message_row_locators(page, limit=MESSAGE_SCAN_LIMIT)
        if not message_rows:
            return None

        for row in message_rows:
            list_snapshot = self._snapshot_from_message_row(row, folder_name)
            if list_snapshot is None:
                continue
            code, matched_regex = extract_code(list_snapshot.summary_text)
            if code:
                if diagnostics is not None:
                    diagnostics["candidate_count"] = diagnostics.get("candidate_count", 0) + 1
                accepted, reason = self._accept_candidate(code, list_snapshot.received_at, min_created_at_ms, exclude_codes)
            else:
                accepted, reason = (False, None)
            if code and accepted:
                return FetchResult(
                    status="ok",
                    folder=list_snapshot.folder,
                    subject=list_snapshot.subject,
                    sender=list_snapshot.sender,
                    received_at=list_snapshot.received_at,
                    received_at_ms=self._parse_received_at_ms(list_snapshot.received_at),
                    code=code,
                    matched_regex=matched_regex,
                    preview=list_snapshot.preview,
                )
            if code and not accepted and reason is not None:
                self._record_filtered_candidate(
                    diagnostics,
                    folder=folder_name,
                    code=code,
                    reason=reason,
                    received_at=list_snapshot.received_at,
                    sender=list_snapshot.sender,
                    subject=list_snapshot.subject,
                )

        for row in message_rows:
            message_snapshot = self._read_opened_message(page, row, folder_name)
            if message_snapshot is None:
                continue
            code, matched_regex = extract_code(
                "\n".join(
                    part
                    for part in (
                        message_snapshot.subject,
                        message_snapshot.sender,
                        message_snapshot.body_text,
                    )
                    if part
                )
            )
            if code:
                if diagnostics is not None:
                    diagnostics["candidate_count"] = diagnostics.get("candidate_count", 0) + 1
                accepted, reason = self._accept_candidate(code, message_snapshot.received_at, min_created_at_ms, exclude_codes)
            else:
                accepted, reason = (False, None)
            if code and accepted:
                return FetchResult(
                    status="ok",
                    folder=message_snapshot.folder,
                    subject=message_snapshot.subject,
                    sender=message_snapshot.sender,
                    received_at=message_snapshot.received_at,
                    received_at_ms=self._parse_received_at_ms(message_snapshot.received_at),
                    code=code,
                    matched_regex=matched_regex,
                    preview=message_snapshot.preview,
                )
            if code and not accepted and reason is not None:
                self._record_filtered_candidate(
                    diagnostics,
                    folder=folder_name,
                    code=code,
                    reason=reason,
                    received_at=message_snapshot.received_at,
                    sender=message_snapshot.sender,
                    subject=message_snapshot.subject,
                )

        return None

    def _collect_folder_messages(self, page: Page, folder_name: str, limit: int) -> list[MailboxMessage]:
        collected: list[MailboxMessage] = []
        for row in self._message_row_locators(page, limit=limit):
            snapshot = self._snapshot_from_message_row(row, folder_name)
            if snapshot is None:
                continue
            collected.append(
                MailboxMessage(
                    folder=snapshot.folder,
                    subject=snapshot.subject,
                    sender=snapshot.sender,
                    received_at=snapshot.received_at,
                    received_at_ms=self._parse_received_at_ms(snapshot.received_at),
                    preview=snapshot.preview,
                    body=None,
                    source="playwright",
                )
            )
        return collected

    def _message_row_locators(self, page: Page, limit: int):
        selectors = (
            '[aria-label*="Message list"] div[role="option"]',
            '[aria-label*="Message list"] div[role="row"]',
            'div[role="grid"] div[role="row"]',
            'div[role="treegrid"] div[role="row"]',
            '[data-convid]',
        )
        rows = []
        for selector in selectors:
            locator = page.locator(selector)
            try:
                count = locator.count()
            except Error:
                continue
            for index in range(count):
                candidate = locator.nth(index)
                try:
                    if candidate.is_visible() and normalize_text(candidate.text_content() or ""):
                        rows.append(candidate)
                        if len(rows) >= limit:
                            return rows
                except Error:
                    continue
        return rows

    def _snapshot_from_message_row(self, row, folder_name: str) -> ListMessageSnapshot | None:
        try:
            aria_summary = normalize_text(row.get_attribute("aria-label"))
            row_text = normalize_text(row.text_content() or "")
            summary = normalize_text(" ".join(filter(None, [aria_summary, row_text])))
        except Error:
            return None
        if not summary:
            return None
        raw_lines = [normalize_text(line) for line in row_text.splitlines()] if row_text else []
        visible_lines = [line for line in raw_lines if line]
        if visible_lines and len(visible_lines[0]) <= 2 and "@" not in visible_lines[0] and not re.search(r"\d", visible_lines[0]):
            visible_lines = visible_lines[1:]

        received_at = None
        received_index = -1
        for index, line in enumerate(visible_lines):
            if self._extract_received_at_from_summary(line):
                received_at = self._extract_received_at_from_summary(line)
                received_index = index
                break

        sender = self._extract_sender_from_text(aria_summary or summary)
        if sender is None and visible_lines:
            sender = visible_lines[0]

        subject = None
        if received_index > 0:
            subject = visible_lines[received_index - 1]
            if sender and subject == sender and received_index > 1:
                subject = visible_lines[received_index - 2]
        elif len(visible_lines) >= 2:
            subject = visible_lines[1] if visible_lines[0] == sender else visible_lines[0]

        preview_lines: list[str] = []
        if received_index >= 0 and received_index + 1 < len(visible_lines):
            preview_lines = visible_lines[received_index + 1 :]
        elif subject and visible_lines:
            try:
                subject_index = visible_lines.index(subject)
            except ValueError:
                subject_index = -1
            if subject_index >= 0 and subject_index + 1 < len(visible_lines):
                preview_lines = visible_lines[subject_index + 1 :]

        return ListMessageSnapshot(
            folder=folder_name,
            summary_text=summary,
            subject=subject or self._extract_subject_from_summary(summary, sender),
            sender=sender,
            received_at=received_at or self._extract_received_at_from_summary(summary),
            preview=make_preview(" ".join(preview_lines) if preview_lines else summary),
            conversation_id=row.get_attribute("data-convid"),
        )

    def _read_opened_message(self, page: Page, row, folder_name: str) -> MessageSnapshot | None:
        if not self._open_message_row(row):
            return None
        self._wait_a_moment(page)
        body_text = self._extract_message_text(page)
        if not body_text:
            return None
        return MessageSnapshot(
            folder=folder_name,
            subject=self._extract_subject(page),
            sender=self._extract_sender(page),
            received_at=self._extract_received_at(page),
            body_text=body_text,
            preview=make_preview(body_text),
        )

    def _extract_message_text(self, page: Page) -> str:
        for selector in (
            '[role="document"]',
            '[data-app-section="MailReadCompose"] [role="document"]',
            '[data-app-section="MailReadCompose"]',
            '[aria-label*="Reading pane"]',
            '[aria-label*="Message body"]',
            '[aria-label*="阅读窗格"]',
        ):
            locator = page.locator(selector).first
            try:
                if locator.count() and locator.is_visible():
                    text = normalize_text(locator.inner_text())
                    if text:
                        return text
            except Error:
                continue
        return normalize_text(page.locator("body").inner_text())

    def _extract_subject(self, page: Page) -> str | None:
        for selector in (
            '[data-app-section="MailReadCompose"] [id*="_SUBJECT"] [title]',
            '[data-app-section="MailReadCompose"] [id*="_SUBJECT"]',
            '[data-app-section="MailReadCompose"] [role="heading"][aria-level="3"]',
            '[aria-label*="阅读窗格"] [id*="_SUBJECT"] [title]',
            '[aria-label*="阅读窗格"] [role="heading"][aria-level="3"]',
            '[role="main"] [id*="_SUBJECT"] [title]',
            '[role="main"] [id*="_SUBJECT"]',
            'h1',
            'h2',
        ):
            locator = page.locator(selector).first
            try:
                if locator.count() and locator.is_visible():
                    text = normalize_text(locator.get_attribute("title") or locator.inner_text())
                    if text:
                        return text
            except Error:
                continue
        return None

    def _extract_sender(self, page: Page) -> str | None:
        for selector in (
            '[data-app-section="MailReadCompose"] [id*="_FROM"] .OZZZK',
            '[data-app-section="MailReadCompose"] [id*="_FROM"]',
            '[aria-label*="阅读窗格"] [id*="_FROM"] .OZZZK',
            '[role="main"] [id*="_FROM"] .OZZZK',
        ):
            locator = page.locator(selector).first
            try:
                if locator.count() and locator.is_visible():
                    text = normalize_text(locator.inner_text())
                    sender = self._extract_sender_from_text(text)
                    if sender:
                        return sender
            except Error:
                continue
        text = normalize_text(page.locator("body").inner_text())
        return self._extract_sender_from_text(text)

    def _extract_received_at(self, page: Page) -> str | None:
        for selector in ('time', '[title*="AM"]', '[title*="PM"]'):
            locator = page.locator(selector).first
            try:
                if locator.count() and locator.is_visible():
                    raw = normalize_text(locator.inner_text() or locator.get_attribute("datetime") or locator.get_attribute("title"))
                    if raw:
                        return raw
            except Error:
                continue
        return None

    def _extract_sender_from_text(self, text: str) -> str | None:
        email_match = re.search(r"([A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,})", text, re.IGNORECASE)
        return email_match.group(1) if email_match else None

    def _extract_subject_from_summary(self, summary: str, sender: str | None) -> str | None:
        candidate = summary
        if sender:
            candidate = candidate.replace(sender, " ", 1).strip()
        candidate = re.sub(r"\b\d{1,2}:\d{2}\b", " ", candidate)
        candidate = normalize_text(candidate)
        return candidate or None

    def _extract_received_at_from_summary(self, summary: str) -> str | None:
        weekday_patterns = sorted(WEEKDAY_ALIASES.keys(), key=len, reverse=True)
        time_match = re.search(r"\b\d{1,2}:\d{2}(?:\s?[AP]M)?\b", summary, re.IGNORECASE)
        date_match = re.search(r"\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b", summary)
        relative_match = re.search(r"\b(today|yesterday|hoje|ontem)\b|今天|昨天", summary, re.IGNORECASE)
        weekday_match = re.search(r"|".join(re.escape(token) for token in weekday_patterns), summary, re.IGNORECASE)

        parts: list[str] = []
        if relative_match:
            parts.append(relative_match.group(0))
        elif weekday_match:
            parts.append(weekday_match.group(0))
        elif date_match:
            parts.append(date_match.group(0))

        if time_match:
            parts.append(time_match.group(0))

        if parts:
            return " ".join(parts)
        return None

    def _accept_candidate(
        self,
        code: str,
        received_at: str | None,
        min_created_at_ms: int | None,
        exclude_codes: set[str] | None,
    ) -> tuple[bool, str | None]:
        if exclude_codes and code in exclude_codes:
            return False, "excluded_code"

        # Default mode: do not reject candidates purely because of timestamp mismatch.
        # We still parse and expose received_at_ms for sorting and diagnostics.
        return True, None

    def _parse_received_at_ms(self, received_at: str | None) -> int | None:
        raw = normalize_text(received_at)
        if not raw:
            return None

        reference_tz = self._get_reference_timezone()
        standard_tz = self._get_standard_timezone()
        now = datetime.now(reference_tz)
        lowered = raw.casefold()

        relative_day = 0
        if any(
            token in lowered
            for token in (
                "yesterday",
                "ontem",
                "昨天",
                "ayer",
                "hier",
                "gestern",
                "ieri",
                "вчера",
                "昨日",
                "어제",
            )
        ):
            relative_day = 1
        elif any(
            token in lowered
            for token in (
                "today",
                "hoje",
                "今天",
                "hoy",
                "aujourd",
                "heute",
                "oggi",
                "сегодня",
                "今日",
                "오늘",
            )
        ):
            relative_day = 0

        time_match = re.search(r"\b\d{1,2}:\d{2}(?:\s?[AP]M)?\b", raw, re.IGNORECASE)
        if time_match and (
            relative_day
            or any(
                token in lowered
                for token in ("today", "hoje", "今天", "hoy", "aujourd", "heute", "oggi", "сегодня", "今日", "오늘")
            )
        ):
            for fmt in ("%I:%M %p", "%H:%M"):
                try:
                    parsed = datetime.strptime(time_match.group(0), fmt)
                    candidate = (now - timedelta(days=relative_day)).replace(
                        hour=parsed.hour,
                        minute=parsed.minute,
                        second=0,
                        microsecond=0,
                    )
                    return int(candidate.astimezone(standard_tz).timestamp() * 1000)
                except ValueError:
                    continue

        weekday_index = self._parse_weekday_index(lowered)
        if weekday_index is not None:
            days_back = (now.weekday() - weekday_index) % 7
            if days_back == 0:
                days_back = 7
            base = now - timedelta(days=days_back)
            if time_match:
                for fmt in ("%I:%M %p", "%H:%M"):
                    try:
                        parsed = datetime.strptime(time_match.group(0), fmt)
                        candidate = base.replace(hour=parsed.hour, minute=parsed.minute, second=0, microsecond=0)
                        return int(candidate.astimezone(standard_tz).timestamp() * 1000)
                    except ValueError:
                        continue
            return int(base.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(standard_tz).timestamp() * 1000)

        for fmt in ("%I:%M %p", "%H:%M", "%Y/%m/%d", "%Y-%m-%d"):
            try:
                parsed = datetime.strptime(raw, fmt)
            except ValueError:
                continue

            if fmt in ("%I:%M %p", "%H:%M"):
                candidate = now.replace(
                    hour=parsed.hour,
                    minute=parsed.minute,
                    second=0,
                    microsecond=0,
                )
                if candidate > now + timedelta(minutes=2):
                    candidate = candidate - timedelta(days=1)
                return int(candidate.astimezone(standard_tz).timestamp() * 1000)

            candidate = parsed.replace(tzinfo=reference_tz)
            return int(candidate.astimezone(standard_tz).timestamp() * 1000)

        return None

    def _get_standard_timezone(self) -> ZoneInfo:
        try:
            return ZoneInfo(STANDARD_TIMEZONE)
        except ZoneInfoNotFoundError:
            return ZoneInfo("UTC")

    def _get_reference_timezone(self) -> ZoneInfo:
        if self._reference_timezone is not None:
            return self._reference_timezone

        timezone_name = self._lookup_network_timezone_name()
        if timezone_name:
            try:
                self._reference_timezone = ZoneInfo(timezone_name)
                self._reference_timezone_source = f"network:{timezone_name}"
                LOGGER.info("Using network timezone reference: %s", timezone_name)
                return self._reference_timezone
            except ZoneInfoNotFoundError:
                LOGGER.warning("Network timezone %s was not available locally.", timezone_name)

        local_tz = datetime.now().astimezone().tzinfo
        if isinstance(local_tz, ZoneInfo):
            self._reference_timezone = local_tz
            self._reference_timezone_source = f"system:{local_tz.key}"
            LOGGER.info("Using system timezone reference: %s", local_tz.key)
            return self._reference_timezone

        self._reference_timezone = ZoneInfo("UTC")
        self._reference_timezone_source = "fallback:UTC"
        LOGGER.info("Using UTC timezone reference as fallback.")
        return self._reference_timezone

    def _lookup_network_timezone_name(self) -> str | None:
        headers = {"User-Agent": "outlook-code-fetcher/1.0"}
        for source, url, key in TIMEZONE_LOOKUP_URLS:
            try:
                request = Request(url, headers=headers)
                with urlopen(request, timeout=5) as response:
                    payload = json.loads(response.read().decode("utf-8", "replace"))
                timezone_name = payload.get(key)
                if isinstance(timezone_name, str) and timezone_name.strip():
                    return timezone_name.strip()
            except Exception as exc:  # pragma: no cover - network-dependent
                LOGGER.debug("Timezone lookup failed for %s: %s", source, exc)
        return None

    def _parse_weekday_index(self, lowered: str) -> int | None:
        for token, index in WEEKDAY_ALIASES.items():
            if token in lowered:
                return index
        return None

    def _open_message_row(self, row) -> bool:
        try:
            row.scroll_into_view_if_needed()
        except Error:
            pass
        try:
            row.click(no_wait_after=True, force=True)
            return True
        except Error:
            pass
        try:
            row.focus()
            row.press("Enter")
            return True
        except Error:
            return False

    def _fill_first(self, page: Page, selectors: Iterable[str], value: str) -> None:
        locator = self._find_visible_locator(page, selectors)
        if locator is not None:
            locator.fill(value)
            return
        raise TimeoutError(f"Unable to find an input for selectors: {selectors}")

    def _click_first(self, page: Page, selectors: Iterable[str]) -> bool:
        locator = self._find_visible_locator(page, selectors)
        return self._click_locator_if_visible(locator) if locator is not None else False

    def _click_locator_if_visible(self, locator) -> bool:
        try:
            if locator.is_visible():
                locator.click(no_wait_after=True)
                self._wait_a_moment(locator.page)
                return True
        except Error:
            return False
        return False

    def _wait_a_moment(self, page: Page) -> None:
        try:
            page.wait_for_load_state("domcontentloaded", timeout=min(self.settings.navigation_timeout_ms, 1500))
        except TimeoutError:
            pass
        page.wait_for_timeout(self.settings.post_action_wait_ms)

    def _find_visible_locator(self, page: Page, selectors: Iterable[str]):
        deadline = time.monotonic() + (self.settings.selector_probe_timeout_ms / 1000)
        while time.monotonic() <= deadline:
            for selector in selectors:
                locator = page.locator(selector).first
                try:
                    if locator.is_visible():
                        return locator
                except Error:
                    continue
            page.wait_for_timeout(100)
        return None

    def _detect_security_challenge(self, page: Page) -> bool:
        body_text = normalize_text(page.locator("body").inner_text()).casefold()
        return any(pattern in body_text for pattern in SECURITY_CHALLENGE_PATTERNS)

    def _detect_login_failed(self, page: Page) -> bool:
        body_text = normalize_text(page.locator("body").inner_text()).casefold()
        return any(pattern in body_text for pattern in LOGIN_FAILED_PATTERNS)

    def _result_sort_key(self, result: FetchResult) -> tuple[int, datetime, int]:
        received_at_ms = result.received_at_ms if result.received_at_ms is not None else self._parse_received_at_ms(result.received_at)
        parsed = (
            datetime.fromtimestamp(received_at_ms / 1000, tz=timezone.utc)
            if received_at_ms is not None
            else datetime.min.replace(tzinfo=timezone.utc)
        )
        content_priority = self._result_content_priority(result)
        folder_priority = 1 if result.folder == "Inbox" else 0
        return content_priority, parsed, folder_priority

    def _result_content_priority(self, result: FetchResult) -> int:
        haystack = normalize_text(" ".join(filter(None, [result.subject, result.preview, result.sender]))).casefold()

        strong_code_markers = (
            "code",
            "验证码",
            "verification",
            "otp",
            "chatgpt",
            "openai",
            "temporary verification",
            "temporary code",
            "临时验证码",
            "codigo de acesso",
            "código de acesso",
        )
        weak_notification_markers = (
            "novo acesso",
            "new access",
            "new login",
            "detectamos um novo acesso",
            "detected a new sign-in",
            "detected a new login",
            "accesso",
            "login",
        )

        if any(marker in haystack for marker in strong_code_markers):
            return 2
        if any(marker in haystack for marker in weak_notification_markers):
            return 0
        return 1

    def _artifact_basename(self, account: Account) -> str:
        safe_id = re.sub(r"[^a-zA-Z0-9_.-]+", "_", account.id or account.email)
        timestamp = datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        return f"{timestamp}_{safe_id}"

    def _save_failure_artifacts(
        self,
        artifact_dir: Path,
        page: Page | None,
        context: BrowserContext,
        console_messages: list[dict],
        diagnostics: dict | None = None,
    ) -> None:
        artifact_dir.mkdir(parents=True, exist_ok=True)
        if page is not None:
            try:
                page.screenshot(path=str(artifact_dir / "failure.png"), full_page=True)
            except Exception:
                LOGGER.warning("Failed to save screenshot to %s", artifact_dir, exc_info=True)
        try:
            context.tracing.stop(path=str(artifact_dir / "trace.zip"))
        except Exception:
            LOGGER.warning("Failed to save Playwright trace to %s", artifact_dir, exc_info=True)
        try:
            (artifact_dir / "console.json").write_text(json.dumps(console_messages, indent=2, ensure_ascii=False), encoding="utf-8")
        except OSError:
            LOGGER.warning("Failed to save console log to %s", artifact_dir, exc_info=True)
        if diagnostics is not None:
            try:
                (artifact_dir / "diagnostics.json").write_text(
                    json.dumps(diagnostics, indent=2, ensure_ascii=False),
                    encoding="utf-8",
                )
            except OSError:
                LOGGER.warning("Failed to save diagnostics to %s", artifact_dir, exc_info=True)

    def _serialize_console(self, message) -> dict:
        location = message.location
        return {
            "type": message.type,
            "text": message.text,
            "url": location.get("url"),
            "lineNumber": location.get("lineNumber"),
            "columnNumber": location.get("columnNumber"),
        }
