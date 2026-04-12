from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient

from app.accounts import load_accounts_csv
from app.config import Settings
from app.main import create_app
from app.models import FetchResult
from app.oauth_mail_client import extract_code_from_callback_url, get_oauth_authorize_url
from app.outlook_client import FOLDER_ALIASES, OutlookWebFetcher


class DummyFetcher:
    def __init__(self) -> None:
        self.released_accounts: list[str] = []
        self.fetched_accounts: list[tuple[str, str]] = []

    def fetch_code(
        self,
        account,
        max_wait_seconds: int,
        poll_interval_seconds: int,
        min_created_at_ms: int | None = None,
        exclude_codes: list[str] | None = None,
        request_context: dict | None = None,
    ) -> FetchResult:
        self.fetched_accounts.append((account.id, account.email))
        return FetchResult(
            status="ok",
            folder="Inbox",
            subject=f"Subject for {account.id}",
            sender="noreply@example.com",
            received_at="2026-04-10T00:00:00Z",
            received_at_ms=1775779200000,
            code="123456",
            matched_regex="numeric_code",
            preview="Your verification code is 123456.",
        )

    def release_session(self, account) -> tuple[bool, Path]:
        self.released_accounts.append(account.id)
        return True, Path(f"/tmp/{account.id}.json")


def make_settings(tmp_path: Path) -> Settings:
    return Settings(
        accounts_csv=tmp_path / "accounts.csv",
        accounts_db=tmp_path / "data" / "hotmail_accounts.db",
        artifacts_dir=tmp_path / "artifacts",
        session_state_dir=tmp_path / "artifacts" / "sessions",
        headless=True,
        outlook_url="https://outlook.live.com/mail/0/",
        login_timeout_seconds=90,
        default_max_wait_seconds=90,
        default_poll_interval_seconds=5,
        navigation_timeout_ms=30000,
        action_timeout_ms=10000,
        selector_probe_timeout_ms=1500,
        post_action_wait_ms=250,
        browser_health_cache_seconds=60,
        oauth_redirect_uri="http://localhost:8080",
        oauth_client_id="test-client-id",
    )


def test_health_and_fetch_code(tmp_path: Path) -> None:
    csv_path = tmp_path / "accounts.csv"
    csv_path.write_text("id,email,password\nacct1,user1@example.com,pass1\n", encoding="utf-8")
    settings = make_settings(tmp_path)
    store = load_accounts_csv(csv_path)
    app = create_app(
        settings=settings,
        account_store=store,
        fetcher=DummyFetcher(),
        browser_checker=lambda: (True, None),
    )

    client = TestClient(app)

    health = client.get("/health")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"
    assert health.json()["account_count"] == 1

    response = client.post("/fetch-code", json={"account": "acct1"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["code"] == "123456"
    assert payload["folder"] == "Inbox"
    assert payload["received_at_ms"] == 1775779200000


def test_fetch_code_returns_404_for_unknown_account(tmp_path: Path) -> None:
    csv_path = tmp_path / "accounts.csv"
    csv_path.write_text("id,email,password\nacct1,user1@example.com,pass1\n", encoding="utf-8")
    settings = make_settings(tmp_path)
    store = load_accounts_csv(csv_path)
    app = create_app(
        settings=settings,
        account_store=store,
        fetcher=DummyFetcher(),
        browser_checker=lambda: (True, None),
    )

    client = TestClient(app)
    response = client.post("/fetch-code", json={"account": "missing"})
    assert response.status_code == 404


def test_release_session(tmp_path: Path) -> None:
    csv_path = tmp_path / "accounts.csv"
    csv_path.write_text("id,email,password\nacct1,user1@example.com,pass1\n", encoding="utf-8")
    settings = make_settings(tmp_path)
    store = load_accounts_csv(csv_path)
    fetcher = DummyFetcher()
    app = create_app(
        settings=settings,
        account_store=store,
        fetcher=fetcher,
        browser_checker=lambda: (True, None),
    )

    client = TestClient(app)
    response = client.post("/release-session", json={"account": "acct1"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "released"
    assert payload["released"] is True
    assert payload["account"] == "acct1"
    assert fetcher.released_accounts == ["acct1"]


def test_fetch_code_direct_without_csv_lookup(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    fetcher = DummyFetcher()
    app = create_app(
        settings=settings,
        account_store=None,
        fetcher=fetcher,
        browser_checker=lambda: (True, None),
    )

    client = TestClient(app)
    response = client.post(
        "/fetch-code-direct",
        json={
            "email": "direct@example.com",
            "password": "secret",
            "max_wait_seconds": 15,
            "poll_interval_seconds": 2,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert fetcher.fetched_accounts == [("direct@example.com", "direct@example.com")]


def test_fetch_code_direct_accepts_graph_credentials_without_password(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    fetcher = DummyFetcher()
    app = create_app(
        settings=settings,
        account_store=None,
        fetcher=fetcher,
        browser_checker=lambda: (True, None),
    )

    client = TestClient(app)
    response = client.post(
        "/fetch-code-direct",
        json={
            "email": "graph@example.com",
            "client_id": "client-id",
            "refresh_token": "refresh-token",
            "access_method": "graph",
        },
    )

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_release_session_accepts_direct_email(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    fetcher = DummyFetcher()
    app = create_app(
        settings=settings,
        account_store=None,
        fetcher=fetcher,
        browser_checker=lambda: (True, None),
    )

    client = TestClient(app)
    response = client.post("/release-session", json={"account": "direct@example.com"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "released"
    assert payload["account"] == "direct@example.com"
    assert fetcher.released_accounts == ["direct@example.com"]


def test_oauth_helper_auth_url(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    app = create_app(
        settings=settings,
        account_store=None,
        fetcher=DummyFetcher(),
        browser_checker=lambda: (True, None),
    )

    client = TestClient(app)
    response = client.get("/oauth/auth-url")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert "authorize" in payload["auth_url"]
    assert payload["client_id"] == "test-client-id"


def test_extract_code_from_callback_url() -> None:
    callback_url = "http://localhost:8080/?code=abc123&state=demo"
    assert extract_code_from_callback_url(callback_url) == "abc123"
    assert "authorize" in get_oauth_authorize_url("client-id", "http://localhost:8080")


def test_hotmail_account_db_import_and_claim(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    app = create_app(
        settings=settings,
        account_store=None,
        fetcher=DummyFetcher(),
        browser_checker=lambda: (True, None),
    )
    client = TestClient(app)

    import_resp = client.post(
        "/accounts/import",
        json={
            "raw_text": (
                "a@hotmail.com----pass1----client1----refresh1\n"
                "b@hotmail.com----pass2----client2----refresh2"
            )
        },
    )
    assert import_resp.status_code == 200
    assert import_resp.json()["pending"] == 2

    summary = client.get("/accounts/summary")
    assert summary.status_code == 200
    assert summary.json()["total"] == 2

    claim = client.post("/accounts/claim-next")
    assert claim.status_code == 200
    payload = claim.json()
    assert payload["status"] == "ok"
    assert payload["account"]["email"] == "a@hotmail.com"

    marked = client.post(
        "/accounts/mark",
        json={
            "email": "a@hotmail.com",
            "workflow_status": "success",
            "tag": "registered",
            "openai_password": "derived-pass",
        },
    )
    assert marked.status_code == 200
    assert marked.json()["account"]["workflow_status"] == "success"
    assert "registered" in marked.json()["account"]["tags"]


def test_hotmail_account_db_reset_claimed(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    app = create_app(
        settings=settings,
        account_store=None,
        fetcher=DummyFetcher(),
        browser_checker=lambda: (True, None),
    )
    client = TestClient(app)
    client.post(
        "/accounts/import",
        json={"raw_text": "a@hotmail.com----pass1----client1----refresh1"},
    )
    client.post("/accounts/claim-next")
    reset_resp = client.post("/accounts/reset-claimed")
    assert reset_resp.status_code == 200
    payload = reset_resp.json()
    assert payload["reset_claimed"] >= 1
    assert payload["claimed"] == 0
    assert payload["pending"] >= 1


def test_hotmail_account_db_list_update_delete_and_ui(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    app = create_app(
        settings=settings,
        account_store=None,
        fetcher=DummyFetcher(),
        browser_checker=lambda: (True, None),
    )
    client = TestClient(app)
    client.post(
        "/accounts/import",
        json={
            "raw_text": (
                "a@hotmail.com----pass1----client1----refresh1\n"
                "b@hotmail.com----pass2----client2----refresh2"
            )
        },
    )

    listed = client.get("/accounts")
    assert listed.status_code == 200
    listed_payload = listed.json()
    assert listed_payload["total"] == 2
    assert listed_payload["accounts"][0]["email"] == "a@hotmail.com"
    assert listed_payload["accounts"][0]["id"] >= 1

    updated = client.put(
        "/accounts/a@hotmail.com",
        json={
            "workflow_status": "failed",
            "tags": ["bad-proxy", "manual-review"],
            "note": "captcha",
            "openai_password": "openai-pass",
        },
    )
    assert updated.status_code == 200
    updated_payload = updated.json()["account"]
    assert updated_payload["workflow_status"] == "failed"
    assert updated_payload["tags"] == ["bad-proxy", "manual-review"]
    assert updated_payload["note"] == "captcha"
    assert updated_payload["openai_password"] == "openai-pass"

    filtered = client.get("/accounts", params={"workflow_status": "failed"})
    assert filtered.status_code == 200
    assert [item["email"] for item in filtered.json()["accounts"]] == ["a@hotmail.com"]

    page = client.get("/accounts/ui")
    assert page.status_code == 200
    assert "Hotmail DB Manager" in page.text

    deleted = client.delete("/accounts/a@hotmail.com")
    assert deleted.status_code == 200
    assert deleted.json()["deleted"] is True
    assert deleted.json()["total"] == 1


def test_hotmail_account_db_batch_update_delete_and_clear(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    app = create_app(
        settings=settings,
        account_store=None,
        fetcher=DummyFetcher(),
        browser_checker=lambda: (True, None),
    )
    client = TestClient(app)
    client.post(
        "/accounts/import",
        json={
            "raw_text": (
                "a@hotmail.com----pass1----client1----refresh1\n"
                "b@hotmail.com----pass2----client2----refresh2\n"
                "c@hotmail.com----pass3----client3----refresh3"
            )
        },
    )

    batch_updated = client.post(
        "/accounts/batch-update",
        json={
            "emails": ["a@hotmail.com", "b@hotmail.com"],
            "workflow_status": "success",
            "add_tags": ["registered", "bulk"],
        },
    )
    assert batch_updated.status_code == 200
    assert batch_updated.json()["affected"] == 2
    assert batch_updated.json()["success"] == 2

    listed = client.get("/accounts", params={"workflow_status": "success"})
    success_emails = [item["email"] for item in listed.json()["accounts"]]
    assert success_emails == ["a@hotmail.com", "b@hotmail.com"]
    assert listed.json()["accounts"][0]["tags"] == ["registered", "bulk"]

    batch_deleted = client.post(
        "/accounts/batch-delete",
        json={"emails": ["a@hotmail.com", "c@hotmail.com"]},
    )
    assert batch_deleted.status_code == 200
    assert batch_deleted.json()["affected"] == 2
    assert batch_deleted.json()["total"] == 1

    bad_clear = client.post("/accounts/clear", json={"confirm_text": "NOPE"})
    assert bad_clear.status_code == 400

    cleared = client.post("/accounts/clear", json={"confirm_text": "CLEAR"})
    assert cleared.status_code == 200
    assert cleared.json()["affected"] == 1
    assert cleared.json()["total"] == 0


def test_parse_received_time_supports_relative_labels(tmp_path: Path) -> None:
    fetcher = OutlookWebFetcher(make_settings(tmp_path))

    assert fetcher._parse_received_at_ms("Hoje 09:11") is not None
    assert fetcher._parse_received_at_ms("Ontem 09:11") is not None
    assert fetcher._parse_received_at_ms("今天 09:11") is not None
    assert fetcher._parse_received_at_ms("昨天 09:11") is not None
    assert fetcher._parse_received_at_ms("Hoy 09:11") is not None
    assert fetcher._parse_received_at_ms("Hier 09:11") is not None
    assert fetcher._parse_received_at_ms("Heute 09:11") is not None
    assert fetcher._parse_received_at_ms("Oggi 09:11") is not None


def test_parse_received_time_supports_weekdays(tmp_path: Path) -> None:
    fetcher = OutlookWebFetcher(make_settings(tmp_path))

    assert fetcher._parse_received_at_ms("周五 09:11") is not None
    assert fetcher._parse_received_at_ms("sexta-feira 09:11") is not None
    assert fetcher._parse_received_at_ms("Friday 09:11") is not None
    assert fetcher._parse_received_at_ms("viernes 09:11") is not None
    assert fetcher._parse_received_at_ms("vendredi 09:11") is not None
    assert fetcher._parse_received_at_ms("Donnerstag 09:11") is not None
    assert fetcher._parse_received_at_ms("martedì 09:11") is not None


def test_folder_aliases_cover_common_languages() -> None:
    assert "Caixa de Entrada" in FOLDER_ALIASES["Inbox"]
    assert "Bandeja de entrada" in FOLDER_ALIASES["Inbox"]
    assert "Boîte de réception" in FOLDER_ALIASES["Inbox"]
    assert "Posteingang" in FOLDER_ALIASES["Inbox"]
    assert "Posta in arrivo" in FOLDER_ALIASES["Inbox"]
    assert "Входящие" in FOLDER_ALIASES["Inbox"]
    assert "受信トレイ" in FOLDER_ALIASES["Inbox"]

    assert "Lixo Eletrônico" in FOLDER_ALIASES["Junk Email"]
    assert "Correo no deseado" in FOLDER_ALIASES["Junk Email"]
    assert "Courrier indésirable" in FOLDER_ALIASES["Junk Email"]
    assert "Junk-E-Mail" in FOLDER_ALIASES["Junk Email"]
    assert "Posta indesiderata" in FOLDER_ALIASES["Junk Email"]
    assert "Спам" in FOLDER_ALIASES["Junk Email"]
    assert "迷惑メール" in FOLDER_ALIASES["Junk Email"]


def test_result_sort_prefers_code_mail_over_new_access_notice(tmp_path: Path) -> None:
    fetcher = OutlookWebFetcher(make_settings(tmp_path))

    openai_result = FetchResult(
        status="ok",
        folder="Inbox",
        subject="你的 OpenAI 代码为 583779",
        sender="noreply@tm.openai.com",
        received_at="18:10",
        received_at_ms=fetcher._parse_received_at_ms("18:10"),
        code="583779",
        matched_regex="numeric_code",
        preview="输入此临时验证码以继续：583779",
    )
    notice_result = FetchResult(
        status="ok",
        folder="Junk Email",
        subject="Detectamos um novo acesso à sua conta 01/11/2025",
        sender="noreply@login.ifood.com.br",
        received_at="19:21",
        received_at_ms=fetcher._parse_received_at_ms("19:21"),
        code="2025",
        matched_regex="numeric_code",
        preview="Novo acesso à sua conta Windows",
    )

    assert fetcher._result_sort_key(openai_result) > fetcher._result_sort_key(notice_result)


def test_parse_received_time_uses_reference_timezone(tmp_path: Path) -> None:
    fetcher = OutlookWebFetcher(make_settings(tmp_path))
    fetcher._reference_timezone = ZoneInfo("Asia/Tokyo")

    now_tokyo = datetime.now(ZoneInfo("Asia/Tokyo"))
    candidate = now_tokyo.replace(hour=18, minute=10, second=0, microsecond=0)
    if candidate > now_tokyo + timedelta(minutes=2):
        candidate = candidate - timedelta(days=1)

    assert fetcher._parse_received_at_ms("18:10") == int(candidate.astimezone(ZoneInfo("Asia/Shanghai")).timestamp() * 1000)


def test_create_failure_diagnostics_records_request_context(tmp_path: Path) -> None:
    fetcher = OutlookWebFetcher(make_settings(tmp_path))
    diagnostics = fetcher._create_diagnostics(
        account=type("A", (), {"id": "acct1", "email": "user@example.com"})(),
        request_context={
            "endpoint": "/fetch-code-direct",
            "account": "user@example.com",
            "email": "user@example.com",
            "min_created_at_ms": 123,
            "exclude_codes": ["111111"],
        },
        min_created_at_ms=123,
        exclude_codes={"111111"},
    )

    assert diagnostics["request"]["endpoint"] == "/fetch-code-direct"
    assert diagnostics["request"]["account"] == "user@example.com"
    assert diagnostics["request"]["exclude_codes"] == ["111111"]
    assert diagnostics["candidate_count"] == 0
