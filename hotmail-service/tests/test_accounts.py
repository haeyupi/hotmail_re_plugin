from pathlib import Path

import pytest

from app.accounts import AccountsLoadError, load_accounts_csv


def test_load_accounts_csv_success(tmp_path: Path) -> None:
    csv_path = tmp_path / "accounts.csv"
    csv_path.write_text("id,email,password\nacct1,user1@example.com,pass1\nacct2,user2@example.com,pass2\n", encoding="utf-8")

    store = load_accounts_csv(csv_path)

    assert len(store) == 2
    assert store.get("acct1").email == "user1@example.com"
    assert store.get("user2@example.com").id == "acct2"


def test_load_accounts_csv_accepts_optional_oauth_columns(tmp_path: Path) -> None:
    csv_path = tmp_path / "accounts.csv"
    csv_path.write_text(
        "id,email,password,client_id,refresh_token,access_method\n"
        "acct1,user1@example.com,,client-1,refresh-1,graph\n",
        encoding="utf-8",
    )

    store = load_accounts_csv(csv_path)
    account = store.get("acct1")

    assert account.client_id == "client-1"
    assert account.refresh_token == "refresh-1"
    assert account.access_method == "graph"


def test_load_accounts_csv_rejects_duplicates(tmp_path: Path) -> None:
    csv_path = tmp_path / "accounts.csv"
    csv_path.write_text("id,email,password\nacct1,user1@example.com,pass1\nacct1,user2@example.com,pass2\n", encoding="utf-8")

    with pytest.raises(AccountsLoadError):
        load_accounts_csv(csv_path)
