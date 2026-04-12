from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path


class AccountsLoadError(ValueError):
    """Raised when the account CSV cannot be loaded."""


@dataclass(frozen=True, slots=True)
class Account:
    id: str
    email: str
    password: str = ""
    client_id: str = ""
    refresh_token: str = ""
    access_method: str = "auto"


class AccountStore:
    def __init__(self, accounts: list[Account]) -> None:
        self._accounts = list(accounts)
        self._by_id = {account.id.casefold(): account for account in accounts}
        self._by_email = {account.email.casefold(): account for account in accounts}

    def __len__(self) -> int:
        return len(self._accounts)

    def get(self, account_ref: str) -> Account | None:
        normalized = account_ref.strip().casefold()
        return self._by_id.get(normalized) or self._by_email.get(normalized)


def load_accounts_csv(path: Path) -> AccountStore:
    if not path.exists():
        raise AccountsLoadError(f"Account CSV not found: {path}")

    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise AccountsLoadError("Account CSV is missing a header row.")

        required = {"id", "email", "password"}
        fieldnames = {name.strip() for name in reader.fieldnames}
        missing = required.difference(fieldnames)
        if missing:
            raise AccountsLoadError(f"Account CSV is missing required columns: {', '.join(sorted(missing))}")

        accounts: list[Account] = []
        seen_ids: set[str] = set()
        seen_emails: set[str] = set()

        for index, row in enumerate(reader, start=2):
            account_id = (row.get("id") or "").strip()
            email = (row.get("email") or "").strip()
            password = (row.get("password") or "").strip()
            client_id = (row.get("client_id") or "").strip()
            refresh_token = (row.get("refresh_token") or "").strip()
            access_method = (row.get("access_method") or "auto").strip() or "auto"
            if not account_id or not email:
                raise AccountsLoadError(f"Row {index} must contain non-empty id and email values.")
            if not password and not (client_id and refresh_token):
                raise AccountsLoadError(
                    f"Row {index} must provide either password or both client_id and refresh_token."
                )

            normalized_id = account_id.casefold()
            normalized_email = email.casefold()
            if normalized_id in seen_ids:
                raise AccountsLoadError(f"Duplicate account id at row {index}: {account_id}")
            if normalized_email in seen_emails:
                raise AccountsLoadError(f"Duplicate email at row {index}: {email}")

            seen_ids.add(normalized_id)
            seen_emails.add(normalized_email)
            accounts.append(
                Account(
                    id=account_id,
                    email=email,
                    password=password,
                    client_id=client_id,
                    refresh_token=refresh_token,
                    access_method=access_method,
                )
            )

    return AccountStore(accounts)
