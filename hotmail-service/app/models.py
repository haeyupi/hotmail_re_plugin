from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Optional

from pydantic import BaseModel, Field, model_validator


class FetchCodeRequest(BaseModel):
    account: str = Field(min_length=1)
    max_wait_seconds: int = Field(default=90, ge=5, le=600)
    poll_interval_seconds: int = Field(default=5, ge=1, le=60)
    min_created_at_ms: Optional[int] = Field(default=None, ge=0)
    exclude_codes: list[str] = Field(default_factory=list)


class FetchCodeDirectRequest(BaseModel):
    email: str = Field(min_length=3)
    password: Optional[str] = Field(default=None)
    client_id: Optional[str] = Field(default=None)
    refresh_token: Optional[str] = Field(default=None)
    access_method: str = Field(default="auto")
    max_wait_seconds: int = Field(default=90, ge=5, le=600)
    poll_interval_seconds: int = Field(default=5, ge=1, le=60)
    min_created_at_ms: Optional[int] = Field(default=None, ge=0)
    exclude_codes: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_credentials(self):
        password = (self.password or "").strip()
        client_id = (self.client_id or "").strip()
        refresh_token = (self.refresh_token or "").strip()
        if not password and not (client_id and refresh_token):
            raise ValueError("Either password or both client_id and refresh_token must be provided.")
        self.password = password or None
        self.client_id = client_id or None
        self.refresh_token = refresh_token or None
        self.access_method = (self.access_method or "auto").strip() or "auto"
        return self


class ReleaseSessionRequest(BaseModel):
    account: str = Field(min_length=1)


class FetchCodeResponse(BaseModel):
    status: str
    source: str = "playwright"
    folder: Optional[str] = None
    subject: Optional[str] = None
    sender: Optional[str] = None
    received_at: Optional[str] = None
    received_at_ms: Optional[int] = None
    code: Optional[str] = None
    matched_regex: Optional[str] = None
    preview: Optional[str] = None
    reason: Optional[str] = None


class HealthResponse(BaseModel):
    status: str
    csv_loaded: bool
    csv_path: str
    account_count: int
    browser_ready: bool
    browser_reason: Optional[str] = None
    headless: bool
    artifacts_dir: str
    oauth_helper_redirect_uri: Optional[str] = None
    oauth_helper_client_id: Optional[str] = None


class ReleaseSessionResponse(BaseModel):
    status: str
    account: str
    released: bool
    session_path: Optional[str] = None
    reason: Optional[str] = None


class OAuthAuthUrlResponse(BaseModel):
    status: str
    auth_url: str
    client_id: str
    redirect_uri: str
    scopes: list[str]


class OAuthExchangeRequest(BaseModel):
    callback_url: Optional[str] = None
    code: Optional[str] = None
    client_id: Optional[str] = None
    redirect_uri: Optional[str] = None

    @model_validator(mode="after")
    def validate_exchange_input(self):
        if not (self.callback_url or self.code):
            raise ValueError("Either callback_url or code must be provided.")
        return self


class OAuthExchangeResponse(BaseModel):
    status: str
    refresh_token: Optional[str] = None
    access_token: Optional[str] = None
    token_type: Optional[str] = None
    expires_in: Optional[int] = None
    scope: Optional[str] = None
    client_id: Optional[str] = None
    redirect_uri: Optional[str] = None
    reason: Optional[str] = None


class HotmailImportRequest(BaseModel):
    raw_text: str = Field(min_length=1)


class HotmailImportResponse(BaseModel):
    status: str
    imported: int
    updated: int
    total: int
    pending: int
    claimed: int
    success: int
    failed: int
    reset_claimed: int = 0


class HotmailAccountResponse(BaseModel):
    id: Optional[int] = None
    email: str
    password: str
    client_id: str
    refresh_token: str
    workflow_status: str
    tags: list[str] = Field(default_factory=list)
    openai_password: Optional[str] = None
    note: Optional[str] = None
    claimed_at: Optional[str] = None
    completed_at: Optional[str] = None
    updated_at: Optional[str] = None


class HotmailClaimResponse(BaseModel):
    status: str
    account: Optional[HotmailAccountResponse] = None
    total: int = 0
    pending: int = 0
    claimed: int = 0
    success: int = 0
    failed: int = 0
    reason: Optional[str] = None


class HotmailSummaryResponse(BaseModel):
    status: str
    total: int
    pending: int
    claimed: int
    success: int
    failed: int
    reset_claimed: int = 0


class HotmailMarkRequest(BaseModel):
    email: str = Field(min_length=3)
    workflow_status: str = Field(min_length=1)
    tag: Optional[str] = None
    note: Optional[str] = None
    openai_password: Optional[str] = None


class HotmailAccountsListResponse(BaseModel):
    status: str
    accounts: list[HotmailAccountResponse] = Field(default_factory=list)
    total: int = 0
    pending: int = 0
    claimed: int = 0
    success: int = 0
    failed: int = 0


class HotmailAccountUpdateRequest(BaseModel):
    workflow_status: Optional[str] = None
    tags: Optional[list[str]] = None
    note: Optional[str] = None
    openai_password: Optional[str] = None


class HotmailDeleteResponse(BaseModel):
    status: str
    deleted: bool
    total: int = 0
    pending: int = 0
    claimed: int = 0
    success: int = 0
    failed: int = 0


class HotmailBatchUpdateRequest(BaseModel):
    emails: list[str] = Field(default_factory=list)
    workflow_status: Optional[str] = None
    add_tags: list[str] = Field(default_factory=list)


class HotmailBatchDeleteRequest(BaseModel):
    emails: list[str] = Field(default_factory=list)


class HotmailClearRequest(BaseModel):
    confirm_text: str = Field(min_length=1)


class HotmailBatchActionResponse(BaseModel):
    status: str
    affected: int = 0
    total: int = 0
    pending: int = 0
    claimed: int = 0
    success: int = 0
    failed: int = 0


@dataclass(slots=True)
class FetchResult:
    status: str
    source: str = "playwright"
    folder: Optional[str] = None
    subject: Optional[str] = None
    sender: Optional[str] = None
    received_at: Optional[str] = None
    received_at_ms: Optional[int] = None
    code: Optional[str] = None
    matched_regex: Optional[str] = None
    preview: Optional[str] = None
    reason: Optional[str] = None

    def to_dict(self) -> dict:
        return asdict(self)
