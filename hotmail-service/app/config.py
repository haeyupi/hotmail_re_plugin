from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off"}


@dataclass(slots=True)
class Settings:
    accounts_csv: Path
    accounts_db: Path
    artifacts_dir: Path
    session_state_dir: Path
    headless: bool
    outlook_url: str
    login_timeout_seconds: int
    default_max_wait_seconds: int
    default_poll_interval_seconds: int
    navigation_timeout_ms: int
    action_timeout_ms: int
    selector_probe_timeout_ms: int
    post_action_wait_ms: int
    browser_health_cache_seconds: int
    oauth_redirect_uri: str
    oauth_client_id: str

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            accounts_csv=Path(os.getenv("HOTMAIL_ACCOUNTS_CSV", "accounts.csv")),
            accounts_db=Path(os.getenv("HOTMAIL_ACCOUNTS_DB", "data/hotmail_accounts.db")),
            artifacts_dir=Path(os.getenv("HOTMAIL_ARTIFACTS_DIR", "output/playwright")),
            session_state_dir=Path(os.getenv("HOTMAIL_SESSION_STATE_DIR", "output/playwright/sessions")),
            headless=_env_bool("HOTMAIL_HEADLESS", True),
            outlook_url=os.getenv("HOTMAIL_OUTLOOK_URL", "https://outlook.live.com/mail/0/"),
            login_timeout_seconds=int(os.getenv("HOTMAIL_LOGIN_TIMEOUT_SECONDS", "90")),
            default_max_wait_seconds=int(os.getenv("HOTMAIL_DEFAULT_MAX_WAIT_SECONDS", "90")),
            default_poll_interval_seconds=int(os.getenv("HOTMAIL_DEFAULT_POLL_INTERVAL_SECONDS", "5")),
            navigation_timeout_ms=int(os.getenv("HOTMAIL_NAVIGATION_TIMEOUT_MS", "30000")),
            action_timeout_ms=int(os.getenv("HOTMAIL_ACTION_TIMEOUT_MS", "10000")),
            selector_probe_timeout_ms=int(os.getenv("HOTMAIL_SELECTOR_PROBE_TIMEOUT_MS", "1500")),
            post_action_wait_ms=int(os.getenv("HOTMAIL_POST_ACTION_WAIT_MS", "250")),
            browser_health_cache_seconds=int(os.getenv("HOTMAIL_BROWSER_HEALTH_CACHE_SECONDS", "60")),
            oauth_redirect_uri=os.getenv("HOTMAIL_OAUTH_REDIRECT_URI", "http://localhost:8080"),
            oauth_client_id=os.getenv("HOTMAIL_OAUTH_CLIENT_ID", "24d9a0ed-8787-4584-883c-2fd79308940a"),
        )
