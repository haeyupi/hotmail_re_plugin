from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(slots=True)
class StoredAccount:
    id: int
    email: str
    password: str
    client_id: str
    refresh_token: str
    access_method: str
    workflow_status: str
    tags: list[str]
    openai_password: str | None
    note: str | None
    claimed_at: str | None
    completed_at: str | None
    updated_at: str | None


class HotmailAccountDb:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS hotmail_accounts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL UNIQUE,
                    password TEXT NOT NULL,
                    client_id TEXT NOT NULL DEFAULT '',
                    refresh_token TEXT NOT NULL DEFAULT '',
                    access_method TEXT NOT NULL DEFAULT 'auto',
                    workflow_status TEXT NOT NULL DEFAULT 'pending',
                    tags TEXT NOT NULL DEFAULT '[]',
                    openai_password TEXT,
                    note TEXT,
                    claimed_at TEXT,
                    completed_at TEXT,
                    updated_at TEXT NOT NULL
                )
                """
            )
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(hotmail_accounts)").fetchall()}
            if "access_method" not in columns:
                conn.execute("ALTER TABLE hotmail_accounts ADD COLUMN access_method TEXT NOT NULL DEFAULT 'auto'")
            conn.commit()

    def import_raw(self, raw_text: str) -> dict:
        parsed = parse_import_lines(raw_text)
        imported = 0
        updated = 0
        with self._connect() as conn:
            for item in parsed:
                existing = conn.execute(
                    "SELECT email FROM hotmail_accounts WHERE email = ?",
                    (item["email"],),
                ).fetchone()
                now = utc_now_iso()
                if existing:
                    conn.execute(
                        """
                        UPDATE hotmail_accounts
                        SET password = ?, client_id = ?, refresh_token = ?, access_method = ?, updated_at = ?
                        WHERE email = ?
                        """,
                        (
                            item["password"],
                            item["client_id"],
                            item["refresh_token"],
                            item["access_method"],
                            now,
                            item["email"],
                        ),
                    )
                    updated += 1
                else:
                    conn.execute(
                        """
                        INSERT INTO hotmail_accounts (
                            email, password, client_id, refresh_token, access_method, workflow_status, tags, updated_at
                        ) VALUES (?, ?, ?, ?, ?, 'pending', '[]', ?)
                        """,
                        (
                            item["email"],
                            item["password"],
                            item["client_id"],
                            item["refresh_token"],
                            item["access_method"],
                            now,
                        ),
                    )
                    imported += 1
            conn.commit()
        summary = self.summary()
        summary.update({"imported": imported, "updated": updated})
        return summary

    def summary(self) -> dict:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT workflow_status, COUNT(*) AS count FROM hotmail_accounts GROUP BY workflow_status"
            ).fetchall()
        counts = {row["workflow_status"]: row["count"] for row in rows}
        return {
            "total": sum(counts.values()),
            "pending": counts.get("pending", 0),
            "claimed": counts.get("claimed", 0),
            "success": counts.get("success", 0),
            "failed": counts.get("failed", 0),
        }

    def claim_next(self) -> StoredAccount | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT * FROM hotmail_accounts
                WHERE workflow_status = 'pending'
                ORDER BY id ASC
                LIMIT 1
                """
            ).fetchone()
            if row is None:
                return None
            conn.execute(
                """
                UPDATE hotmail_accounts
                SET workflow_status = 'claimed', claimed_at = ?, updated_at = ?
                WHERE email = ?
                """,
                (utc_now_iso(), utc_now_iso(), row["email"]),
            )
            conn.commit()
            return self.get(row["email"])

    def reset_claimed(self, exclude_email: str | None = None) -> int:
        with self._connect() as conn:
            if exclude_email:
                result = conn.execute(
                    """
                    UPDATE hotmail_accounts
                    SET workflow_status = 'pending', updated_at = ?, claimed_at = NULL
                    WHERE workflow_status = 'claimed' AND email != ?
                    """,
                    (utc_now_iso(), exclude_email),
                )
            else:
                result = conn.execute(
                    """
                    UPDATE hotmail_accounts
                    SET workflow_status = 'pending', updated_at = ?, claimed_at = NULL
                    WHERE workflow_status = 'claimed'
                    """,
                    (utc_now_iso(),),
                )
            conn.commit()
            return int(result.rowcount or 0)

    def get(self, email: str) -> StoredAccount | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM hotmail_accounts WHERE email = ?", (email,)).fetchone()
        if row is None:
            return None
        return StoredAccount(
            id=row["id"],
            email=row["email"],
            password=row["password"],
            client_id=row["client_id"],
            refresh_token=row["refresh_token"],
            access_method=row["access_method"] or "auto",
            workflow_status=row["workflow_status"],
            tags=_parse_tags(row["tags"]),
            openai_password=row["openai_password"],
            note=row["note"],
            claimed_at=row["claimed_at"],
            completed_at=row["completed_at"],
            updated_at=row["updated_at"],
        )

    def list_accounts(self, workflow_status: str | None = None) -> list[StoredAccount]:
        query = "SELECT * FROM hotmail_accounts"
        params: tuple[str, ...] = ()
        if workflow_status:
            query += " WHERE workflow_status = ?"
            params = (workflow_status,)
        query += " ORDER BY id ASC"
        with self._connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [
            StoredAccount(
                id=row["id"],
                email=row["email"],
                password=row["password"],
                client_id=row["client_id"],
                refresh_token=row["refresh_token"],
                access_method=row["access_method"] or "auto",
                workflow_status=row["workflow_status"],
                tags=_parse_tags(row["tags"]),
                openai_password=row["openai_password"],
                note=row["note"],
                claimed_at=row["claimed_at"],
                completed_at=row["completed_at"],
                updated_at=row["updated_at"],
            )
            for row in rows
        ]

    def update_result(
        self,
        *,
        email: str,
        workflow_status: str,
        tag: str | None = None,
        note: str | None = None,
        openai_password: str | None = None,
    ) -> StoredAccount | None:
        account = self.get(email)
        if account is None:
            return None
        tags = list(account.tags)
        if tag and tag not in tags:
            tags.append(tag)
        completed_at = utc_now_iso() if workflow_status in {"success", "failed"} else None
        with self._connect() as conn:
            conn.execute(
                """
                UPDATE hotmail_accounts
                SET workflow_status = ?, tags = ?, note = ?, openai_password = COALESCE(?, openai_password),
                    completed_at = COALESCE(?, completed_at), updated_at = ?
                WHERE email = ?
                """,
                (
                    workflow_status,
                    json.dumps(tags, ensure_ascii=False),
                    note,
                    openai_password,
                    completed_at,
                    utc_now_iso(),
                    email,
                ),
            )
            conn.commit()
        return self.get(email)

    def update_account(
        self,
        *,
        email: str,
        workflow_status: str | None = None,
        tags: list[str] | None = None,
        note: str | None = None,
        openai_password: str | None = None,
        access_method: str | None = None,
    ) -> StoredAccount | None:
        account = self.get(email)
        if account is None:
            return None

        next_status = (workflow_status or account.workflow_status).strip() or account.workflow_status
        next_tags = [tag for tag in (tags if tags is not None else account.tags) if str(tag or "").strip()]
        next_note = note if note is not None else account.note
        next_openai_password = openai_password if openai_password is not None else account.openai_password
        next_access_method = (access_method if access_method is not None else account.access_method).strip() or "auto"
        claimed_at = account.claimed_at
        completed_at = account.completed_at
        if next_status == "pending":
            claimed_at = None
            completed_at = None
        elif next_status == "claimed":
            claimed_at = account.claimed_at or utc_now_iso()
            completed_at = None
        elif next_status in {"success", "failed"}:
            completed_at = account.completed_at or utc_now_iso()

        with self._connect() as conn:
            conn.execute(
                """
                UPDATE hotmail_accounts
                SET workflow_status = ?, tags = ?, note = ?, openai_password = ?, access_method = ?,
                    claimed_at = ?, completed_at = ?, updated_at = ?
                WHERE email = ?
                """,
                (
                    next_status,
                    json.dumps(next_tags, ensure_ascii=False),
                    next_note,
                    next_openai_password,
                    next_access_method,
                    claimed_at,
                    completed_at,
                    utc_now_iso(),
                    email,
                ),
            )
            conn.commit()
        return self.get(email)

    def delete_account(self, email: str) -> bool:
        with self._connect() as conn:
            result = conn.execute("DELETE FROM hotmail_accounts WHERE email = ?", (email,))
            conn.commit()
        return bool(result.rowcount)

    def batch_update_accounts(
        self,
        *,
        emails: list[str],
        workflow_status: str | None = None,
        add_tags: list[str] | None = None,
    ) -> int:
        normalized_emails = [str(email or "").strip() for email in emails if str(email or "").strip()]
        normalized_tags = [str(tag or "").strip() for tag in (add_tags or []) if str(tag or "").strip()]
        if not normalized_emails:
            return 0

        affected = 0
        for email in normalized_emails:
            account = self.get(email)
            if account is None:
                continue
            next_tags = list(account.tags)
            for tag in normalized_tags:
                if tag not in next_tags:
                    next_tags.append(tag)
            updated = self.update_account(
                email=email,
                workflow_status=workflow_status,
                tags=next_tags,
            )
            if updated is not None:
                affected += 1
        return affected

    def batch_delete_accounts(self, emails: list[str]) -> int:
        normalized_emails = [str(email or "").strip() for email in emails if str(email or "").strip()]
        if not normalized_emails:
            return 0
        placeholders = ",".join("?" for _ in normalized_emails)
        with self._connect() as conn:
            result = conn.execute(
                f"DELETE FROM hotmail_accounts WHERE email IN ({placeholders})",
                normalized_emails,
            )
            conn.commit()
        return int(result.rowcount or 0)

    def clear_all_accounts(self) -> int:
        with self._connect() as conn:
            count_row = conn.execute("SELECT COUNT(*) AS count FROM hotmail_accounts").fetchone()
            result = conn.execute("DELETE FROM hotmail_accounts")
            conn.commit()
        return int(result.rowcount or count_row["count"] or 0)


def parse_import_lines(raw_text: str) -> list[dict]:
    parsed: list[dict] = []
    for raw_line in str(raw_text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split("----")
        if len(parts) < 4:
            continue
        email = parts[0].strip()
        password = parts[1].strip()
        client_id = parts[2].strip()
        refresh_token = "----".join(parts[3:]).strip()
        if not email or not password:
            continue
        parsed.append(
            {
                "email": email,
                "password": password,
                "client_id": client_id,
                "refresh_token": refresh_token,
                "access_method": "auto",
            }
        )
    return parsed


def _parse_tags(raw_value: str | None) -> list[str]:
    try:
        data = json.loads(raw_value or "[]")
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    return [str(item).strip() for item in data if str(item).strip()]
