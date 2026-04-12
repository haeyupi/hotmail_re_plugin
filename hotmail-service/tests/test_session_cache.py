from pathlib import Path
from app.accounts import Account
from app.session_cache import SessionStateCache


def test_fresh_path_for_returns_none_when_missing(tmp_path: Path) -> None:
    cache = SessionStateCache(tmp_path / "sessions")
    account = Account(id="acct1", email="user@example.com", password="secret")

    assert cache.fresh_path_for(account) is None


def test_fresh_path_for_rejects_stale_file(tmp_path: Path) -> None:
    cache = SessionStateCache(tmp_path / "sessions")
    account = Account(id="acct1", email="user@example.com", password="secret")
    path = cache.storage_state_path(account)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{}", encoding="utf-8")

    assert cache.fresh_path_for(account) == path


def test_fresh_path_for_accepts_recent_file(tmp_path: Path) -> None:
    cache = SessionStateCache(tmp_path / "sessions")
    account = Account(id="acct1", email="user@example.com", password="secret")
    path = cache.storage_state_path(account)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{}", encoding="utf-8")

    assert cache.fresh_path_for(account) == path


def test_invalidate_removes_cached_session(tmp_path: Path) -> None:
    cache = SessionStateCache(tmp_path / "sessions")
    account = Account(id="acct1", email="user@example.com", password="secret")
    path = cache.storage_state_path(account)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{}", encoding="utf-8")

    cache.invalidate(account)

    assert cache.fresh_path_for(account) is None
