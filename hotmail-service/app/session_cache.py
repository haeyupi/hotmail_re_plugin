from __future__ import annotations

import re
from pathlib import Path

from playwright.sync_api import BrowserContext

from .accounts import Account


class SessionStateCache:
    def __init__(self, session_dir: Path) -> None:
        self.session_dir = session_dir

    def storage_state_path(self, account: Account) -> Path:
        safe_key = re.sub(r"[^a-zA-Z0-9_.-]+", "_", account.id or account.email)
        return self.session_dir / f"{safe_key}.json"

    def fresh_path_for(self, account: Account) -> Path | None:
        path = self.storage_state_path(account)
        return path if path.exists() else None

    def save(self, context: BrowserContext, account: Account) -> Path:
        path = self.storage_state_path(account)
        path.parent.mkdir(parents=True, exist_ok=True)
        context.storage_state(path=str(path))
        return path

    def invalidate(self, account: Account) -> None:
        path = self.storage_state_path(account)
        if path.exists():
            path.unlink()
