from __future__ import annotations

import logging
import threading
import time

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse

from .account_db import HotmailAccountDb
from .accounts import Account, AccountStore, AccountsLoadError, load_accounts_csv
from .config import Settings
from .models import (
    FetchCodeDirectRequest,
    FetchCodeRequest,
    FetchCodeResponse,
    HotmailBatchActionResponse,
    HotmailBatchDeleteRequest,
    HotmailBatchUpdateRequest,
    HotmailClearRequest,
    HealthResponse,
    HotmailAccountResponse,
    HotmailAccountsListResponse,
    HotmailClaimResponse,
    HotmailDeleteResponse,
    HotmailAccountUpdateRequest,
    HotmailImportRequest,
    HotmailImportResponse,
    HotmailMailboxMessageResponse,
    HotmailMailboxResponse,
    HotmailMarkRequest,
    HotmailSummaryResponse,
    OAuthAuthUrlResponse,
    OAuthExchangeRequest,
    OAuthExchangeResponse,
    ReleaseSessionRequest,
    ReleaseSessionResponse,
)
from .oauth_mail_client import extract_code_from_callback_url, exchange_authorization_code, get_oauth_authorize_url
from .outlook_client import OutlookWebFetcher

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

ACCOUNT_MAILBOX_LIST_LIMIT = 2
DIRECT_MAILBOX_LIST_LIMIT = 10
ACCOUNT_MAILBOX_CACHE_SECONDS = 90


def to_hotmail_account_response(account) -> HotmailAccountResponse:
    return HotmailAccountResponse(
        id=account.id,
        email=account.email,
        password=account.password,
        client_id=account.client_id,
        refresh_token=account.refresh_token,
        access_method=getattr(account, "access_method", "auto") or "auto",
        workflow_status=account.workflow_status,
        tags=account.tags,
        openai_password=account.openai_password,
        note=account.note,
        claimed_at=account.claimed_at,
        completed_at=account.completed_at,
        updated_at=account.updated_at,
    )


def available_access_methods(account) -> list[str]:
    methods: list[str] = []
    configured_method = (getattr(account, "access_method", "auto") or "auto").strip() or "auto"
    methods.append(configured_method)
    if getattr(account, "client_id", "") and getattr(account, "refresh_token", ""):
        for method in ("graph", "imap_new", "imap_old"):
            if method not in methods:
                methods.append(method)
    if getattr(account, "password", "") and "playwright" not in methods:
        methods.append("playwright")
    if "auto" not in methods:
        methods.insert(0, "auto")
    return methods


def make_example_payload(account) -> dict:
    configured_method = (getattr(account, "access_method", "auto") or "auto").strip() or "auto"
    payload = {
        "email": account.email,
        "access_method": configured_method,
        "max_wait_seconds": 20,
        "poll_interval_seconds": 3,
    }
    if getattr(account, "password", ""):
        payload["password"] = "<configured>"
    if getattr(account, "client_id", "") and getattr(account, "refresh_token", ""):
        payload["client_id"] = "<configured>"
        payload["refresh_token"] = "<configured>"
    return payload


def build_direct_account(request: FetchCodeDirectRequest) -> Account:
    return Account(
        id=request.email.strip(),
        email=request.email.strip(),
        password=request.password or "",
        client_id=request.client_id or "",
        refresh_token=request.refresh_token or "",
        access_method=request.access_method,
    )


def to_hotmail_mailbox_response(
    account,
    resolved_method: str,
    raw_messages,
    *,
    reason: str | None = None,
    supports_listing: bool = True,
    endpoint: str = "/messages-direct",
) -> HotmailMailboxResponse:
    messages = [
        HotmailMailboxMessageResponse(
            folder=item.folder,
            subject=item.subject,
            sender=item.sender,
            received_at=item.received_at,
            received_at_ms=item.received_at_ms,
            preview=item.preview,
            body=item.body,
            source=item.source,
        )
        for item in raw_messages
    ]
    return HotmailMailboxResponse(
        status="ok" if messages else "empty",
        email=account.email,
        access_method=(getattr(account, "access_method", "auto") or "auto").strip() or "auto",
        resolved_method=resolved_method,
        available_methods=available_access_methods(account),
        supports_listing=supports_listing,
        has_password=bool(getattr(account, "password", "")),
        has_oauth=bool(getattr(account, "client_id", "") and getattr(account, "refresh_token", "")),
        endpoint=endpoint,
        example_payload=make_example_payload(account),
        messages=messages,
        total_messages=len(messages),
        reason=reason,
    )


def render_accounts_ui_html() -> str:
    return """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Hotmail DB Manager</title>
  <style>
    :root { color-scheme: dark; --bg:#0f1115; --surface:#171a21; --surface2:#1f2430; --surface3:#262c3a; --border:#303647; --text:#e6eaf2; --muted:#98a2b3; --green:#22c55e; --red:#ef4444; --blue:#3b82f6; --orange:#f59e0b; }
    * { box-sizing:border-box; }
    body { margin:0; font:14px/1.5 Inter,system-ui,sans-serif; background:var(--bg); color:var(--text); }
    .wrap { max-width: 1520px; margin: 0 auto; padding: 20px; }
    h1 { margin:0 0 8px; font-size:24px; }
    .toolbar,.summary,.row,.filters,.batchbar,.dangerbar,.mailbox-toolbar,.mailbox-meta { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
    .panel { background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:16px; margin-bottom:16px; }
    .summary .card { min-width:120px; background:var(--surface2); border:1px solid var(--border); border-radius:10px; padding:10px 12px; }
    .summary .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
    .summary .value { font-size:20px; font-weight:700; }
    input,select,textarea,button { border-radius:10px; border:1px solid var(--border); background:var(--surface2); color:var(--text); padding:8px 10px; font:inherit; }
    input[type="checkbox"] { width:16px; height:16px; accent-color: var(--blue); }
    input,select,textarea { min-width: 0; }
    textarea { width:100%; min-height:64px; resize:vertical; }
    button { cursor:pointer; }
    button.primary { background:var(--blue); border-color:var(--blue); color:#fff; }
    button.danger { background:transparent; border-color:var(--red); color:var(--red); }
    button.warn { background:transparent; border-color:var(--orange); color:var(--orange); }
    button.success { background:transparent; border-color:var(--green); color:var(--green); }
    button:disabled { opacity:.5; cursor:not-allowed; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid var(--border); padding:10px 8px; vertical-align:top; text-align:left; }
    th { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
    .mono { font-family: ui-monospace,SFMono-Regular,Consolas,monospace; font-size:12px; }
    .status { display:inline-flex; align-items:center; gap:6px; }
    .dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
    .pending .dot { background:var(--orange); } .claimed .dot { background:var(--blue); } .success .dot { background:var(--green); } .failed .dot { background:var(--red); }
    .row-actions { display:flex; gap:8px; flex-wrap:wrap; }
    .muted { color:var(--muted); }
    .msg { margin-left:auto; color:var(--muted); }
    .selected-count { margin-left:auto; color:var(--muted); }
    .small { font-size:12px; }
    .dangerbox { padding:10px 12px; border:1px dashed rgba(239,68,68,.4); border-radius:12px; background:rgba(239,68,68,.06); width:100%; }
    .dangerbox-title { color:var(--red); font-weight:700; margin-bottom:4px; }
    .dangerbox-note { color:var(--muted); font-size:12px; margin-bottom:10px; }
    .danger-input { min-width:180px; }
    .table-wrap { overflow:auto; }
    .workspace { display:grid; grid-template-columns:minmax(0,1fr); gap:16px; align-items:start; --pane-height: calc(100vh - 280px); }
    .workspace.with-mailbox { grid-template-columns:minmax(0,1fr) minmax(360px,480px); }
    .main-pane { min-width:0; max-height:var(--pane-height); overflow-y:auto; padding-right:6px; }
    .mailbox-pane { min-width:0; display:none; }
    .mailbox-pane.is-open { display:block; }
    .mailbox-pane .panel { margin-bottom:0; max-height:var(--pane-height); overflow-y:auto; }
    .mailbox-layout { display:grid; grid-template-columns:1fr; gap:16px; align-items:start; }
    .mailbox-header { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; flex-wrap:wrap; }
    .mailbox-list { display:flex; flex-direction:column; gap:10px; }
    .mail-item { border:1px solid var(--border); border-radius:12px; padding:12px; background:var(--surface2); }
    .mail-top { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; margin-bottom:8px; }
    .mail-subject { font-weight:700; }
    .mail-preview { color:var(--muted); white-space:pre-wrap; word-break:break-word; }
    .mailbox-method { display:inline-flex; align-items:center; border:1px solid var(--border); border-radius:999px; padding:4px 10px; font-size:12px; color:var(--text); background:rgba(255,255,255,.03); }
    .mailbox-card { min-width:140px; background:var(--surface2); border:1px solid var(--border); border-radius:10px; padding:10px 12px; }
    .mailbox-card .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.08em; margin-bottom:4px; }
    .empty { padding:18px; border:1px dashed var(--border); border-radius:12px; color:var(--muted); background:rgba(255,255,255,.02); }
    pre { margin:0; padding:12px; border-radius:12px; overflow:auto; white-space:pre-wrap; word-break:break-word; background:var(--surface2); border:1px solid var(--border); color:var(--text); }
    .pill { display:inline-flex; align-items:center; border:1px solid var(--border); border-radius:999px; padding:2px 8px; font-size:12px; color:var(--muted); }
    .selected-row { background:rgba(59,130,246,.08); }
    .email-link { background:none; border:none; padding:0; color:var(--blue); cursor:pointer; font:inherit; text-align:left; }
    .email-link:hover { text-decoration:underline; }
    .method-badge { display:inline-flex; align-items:center; border:1px solid var(--border); border-radius:999px; padding:4px 8px; font-size:12px; color:var(--text); background:rgba(255,255,255,.03); }
    .full-only { display:block; }
    .workspace.with-mailbox .full-only { display:none; }
    @media (max-width: 1180px) {
      .workspace { --pane-height: auto; }
      .workspace.with-mailbox { grid-template-columns:1fr; }
      .main-pane { max-height:none; overflow:visible; padding-right:0; }
      .mailbox-pane .panel { max-height:none; overflow:visible; }
      .mailbox-layout { grid-template-columns:1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="panel">
      <div class="toolbar">
        <div>
          <h1>Hotmail 账号数据库管理</h1>
          <div class="muted">支持查看、单条编辑、批量改状态、批量加标签、批量删除，以及清空数据库。</div>
        </div>
        <div class="msg" id="msg">Ready</div>
      </div>
    </div>

    <div class="panel">
      <div class="filters">
        <label>Filter
          <select id="filter-status">
            <option value="">all</option>
            <option value="pending">pending</option>
            <option value="claimed">claimed</option>
            <option value="success">success</option>
            <option value="failed">failed</option>
          </select>
        </label>
        <button id="btn-refresh" class="primary">Refresh</button>
        <button id="btn-reset-claimed" class="warn">Reset claimed</button>
      </div>
    </div>

    <div class="panel">
      <div class="summary" id="summary"></div>
    </div>

    <div id="workspace" class="workspace">
      <div class="main-pane">
        <div class="panel full-only">
          <div class="batchbar">
            <label>Batch Status
              <select id="batch-status">
                <option value="">(unchanged)</option>
                <option value="pending">pending</option>
                <option value="claimed">claimed</option>
                <option value="success">success</option>
                <option value="failed">failed</option>
              </select>
            </label>
            <label style="min-width:280px; flex:1;">Batch Add Tags
              <input id="batch-tags" placeholder="例如 registered,manual" />
            </label>
            <button id="btn-batch-apply" class="success">Apply to Selected</button>
            <button id="btn-batch-delete" class="danger">Delete Selected</button>
            <span id="selected-count" class="selected-count">0 selected</span>
          </div>
        </div>

        <div class="panel dangerbox full-only">
          <div class="dangerbox-title">Danger Zone</div>
          <div class="dangerbox-note">清空数据库前，必须输入 <span class="mono">CLEAR</span> 作为确认词。</div>
          <div class="dangerbar">
            <input id="clear-confirm" class="danger-input mono" placeholder="输入 CLEAR" />
            <button id="btn-clear-db" class="danger">Clear Database</button>
          </div>
        </div>

        <div class="panel table-wrap">
          <table>
            <thead id="table-head"></thead>
            <tbody id="rows"></tbody>
          </table>
        </div>
      </div>

      <aside id="mailbox-pane" class="mailbox-pane">
        <div class="panel">
          <div class="mailbox-header">
            <div>
              <h2 style="margin:0 0 6px;">邮箱邮件面板</h2>
              <div class="muted" id="mailbox-subtitle">选择一个账号后，这里显示收信箱内容。</div>
            </div>
            <div class="mailbox-toolbar">
              <span id="mailbox-method" class="mailbox-method mono">API: -</span>
              <button id="btn-reload-mailbox" class="primary" disabled>Reload Mailbox</button>
              <button id="btn-close-mailbox" class="danger">Close</button>
            </div>
          </div>
          <div class="mailbox-layout" style="margin-top:16px;">
            <div id="mailbox-list" class="mailbox-list">
              <div class="empty">选择账号后加载邮件列表。</div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </div>
  <script>
    const $ = (sel) => document.querySelector(sel);
    const rowsEl = $('#rows');
    const tableHeadEl = $('#table-head');
    const summaryEl = $('#summary');
    const msgEl = $('#msg');
    const filterEl = $('#filter-status');
    const selectAllEl = $('#select-all');
    const selectedCountEl = $('#selected-count');
    const batchStatusEl = $('#batch-status');
    const batchTagsEl = $('#batch-tags');
    const clearConfirmEl = $('#clear-confirm');
    const workspaceEl = $('#workspace');
    const mailboxPaneEl = $('#mailbox-pane');
    const mailboxListEl = $('#mailbox-list');
    const mailboxSubtitleEl = $('#mailbox-subtitle');
    const mailboxMethodEl = $('#mailbox-method');
    const mailboxReloadEl = $('#btn-reload-mailbox');
    const mailboxCloseEl = $('#btn-close-mailbox');
    let selectedMailboxEmail = null;
    let currentAccounts = [];
    let mailboxRequestSeq = 0;

    function setMsg(text, isError = false) {
      msgEl.textContent = text;
      msgEl.style.color = isError ? 'var(--red)' : 'var(--muted)';
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text ?? '';
      return div.innerHTML;
    }

    function renderSummary(summary) {
      const items = [
        ['total', summary.total || 0],
        ['pending', summary.pending || 0],
        ['claimed', summary.claimed || 0],
        ['success', summary.success || 0],
        ['failed', summary.failed || 0],
      ];
      summaryEl.innerHTML = items.map(([label, value]) => `
        <div class="card">
          <div class="label">${label}</div>
          <div class="value">${value}</div>
        </div>
      `).join('');
    }

    function isMailboxOpen() {
      return workspaceEl.classList.contains('with-mailbox');
    }

    function renderTableHead() {
      if (isMailboxOpen()) {
        tableHeadEl.innerHTML = `
          <tr>
            <th>ID</th>
            <th>Email</th>
            <th>Status</th>
            <th>Method</th>
          </tr>
        `;
        return;
      }

      tableHeadEl.innerHTML = `
        <tr>
          <th><input id="select-all" type="checkbox" /></th>
          <th>ID</th>
          <th>Email</th>
          <th>Status</th>
          <th>Tags</th>
          <th>OpenAI Password</th>
          <th>Note</th>
          <th>Updated</th>
          <th>Actions</th>
        </tr>
      `;
      const selectAll = $('#select-all');
      if (selectAll) {
        selectAll.addEventListener('change', () => {
          const nextChecked = selectAll.checked;
          document.querySelectorAll('.row-check').forEach((checkbox) => {
            checkbox.checked = nextChecked;
          });
          updateSelectionUi();
        });
      }
    }

    function rowHtml(account) {
      const method = account.access_method || 'auto';
      const selectedClass = selectedMailboxEmail === account.email ? ' selected-row' : '';
      if (isMailboxOpen()) {
        return `
          <tr class="${selectedClass}" data-email="${encodeURIComponent(account.email)}">
            <td class="mono">${account.id ?? ''}</td>
            <td class="mono"><button type="button" class="email-link btn-open-mailbox">${escapeHtml(account.email)}</button></td>
            <td><div class="status ${escapeHtml(account.workflow_status)}"><span class="dot"></span>${escapeHtml(account.workflow_status)}</div></td>
            <td><span class="method-badge mono">${escapeHtml(method)}</span></td>
          </tr>
        `;
      }

      const tags = Array.isArray(account.tags) ? account.tags.join(', ') : '';
      return `
        <tr class="${selectedClass}" data-email="${encodeURIComponent(account.email)}">
          <td><input class="row-check" type="checkbox" /></td>
          <td class="mono">${account.id ?? ''}</td>
          <td class="mono"><button type="button" class="email-link btn-open-mailbox">${escapeHtml(account.email)}</button></td>
          <td>
            <div class="status ${escapeHtml(account.workflow_status)}"><span class="dot"></span>${escapeHtml(account.workflow_status)}</div>
            <div style="margin-top:8px;">
              <select class="edit-status">
                ${['pending','claimed','success','failed'].map(s => `<option value="${s}" ${s === account.workflow_status ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
            </div>
          </td>
          <td><textarea class="edit-tags small" placeholder="逗号分隔标签">${escapeHtml(tags)}</textarea></td>
          <td><input class="edit-openai-password mono small" value="${escapeHtml(account.openai_password || '')}" placeholder="OpenAI password" /></td>
          <td><textarea class="edit-note small" placeholder="备注">${escapeHtml(account.note || '')}</textarea></td>
          <td class="mono">${escapeHtml(account.updated_at || '')}</td>
          <td>
            <div class="row-actions">
              <button class="primary btn-save">Save</button>
              <button class="danger btn-delete">Delete</button>
            </div>
          </td>
        </tr>
      `;
    }

    function renderAccountsTable() {
      renderTableHead();
      rowsEl.innerHTML = currentAccounts.map(rowHtml).join('') || `<tr><td colspan="${isMailboxOpen() ? 4 : 9}" class="muted">No accounts</td></tr>`;
      if (!isMailboxOpen()) {
        updateSelectionUi();
      }
    }

    function getSelectedEmails() {
      return Array.from(document.querySelectorAll('.row-check:checked'))
        .map((checkbox) => checkbox.closest('tr'))
        .filter(Boolean)
        .map((tr) => decodeURIComponent(tr.dataset.email));
    }

    function updateSelectionUi() {
      const selectAll = $('#select-all');
      const checks = Array.from(document.querySelectorAll('.row-check'));
      const checked = checks.filter((checkbox) => checkbox.checked);
      if (selectedCountEl) {
        selectedCountEl.textContent = `${checked.length} selected`;
      }
      if (!selectAll) return;
      if (!checks.length) {
        selectAll.checked = false;
        selectAll.indeterminate = false;
        return;
      }
      selectAll.checked = checked.length === checks.length;
      selectAll.indeterminate = checked.length > 0 && checked.length < checks.length;
    }

    async function api(path, options = {}) {
      const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new Error(data.detail || data.error || response.statusText || 'Request failed');
      }
      return data;
    }

    function openMailboxPane() {
      workspaceEl.classList.add('with-mailbox');
      mailboxPaneEl.classList.add('is-open');
      renderAccountsTable();
    }

    function closeMailboxPane() {
      workspaceEl.classList.remove('with-mailbox');
      mailboxPaneEl.classList.remove('is-open');
      renderAccountsTable();
    }

    function resetMailboxContent() {
      mailboxReloadEl.disabled = true;
      mailboxSubtitleEl.textContent = '选择一个账号后，这里显示收信箱内容。';
      mailboxMethodEl.textContent = 'API: -';
      mailboxListEl.innerHTML = '<div class="empty">选择账号后加载邮件列表。</div>';
    }

    function renderMailboxLoading(email) {
      mailboxSubtitleEl.textContent = email ? `当前账号: ${email}` : '选择一个账号后，这里显示收信箱内容。';
      mailboxMethodEl.textContent = 'API: loading...';
      mailboxListEl.innerHTML = '<div class="empty">正在加载邮件列表，请稍候...</div>';
    }

    function renderMailboxList(data) {
      if (!data.messages || !data.messages.length) {
        mailboxListEl.innerHTML = `<div class="empty">${escapeHtml(data.reason || '当前没有可显示的邮件。')}</div>`;
        return;
      }
      mailboxListEl.innerHTML = data.messages.map((item) => `
        <div class="mail-item">
          <div class="mail-top">
            <div>
              <div class="mail-subject">${escapeHtml(item.subject || '(no subject)')}</div>
              <div class="small muted">${escapeHtml(item.sender || '(unknown sender)')}</div>
            </div>
            <div style="text-align:right;">
              <div class="pill">${escapeHtml(item.folder || '-')}</div>
              <div class="small muted" style="margin-top:6px;">${escapeHtml(item.received_at || '')}</div>
            </div>
          </div>
          <div class="small muted" style="margin-bottom:8px;">source=${escapeHtml(item.source || '-')}</div>
          <div class="mail-preview">${escapeHtml(item.preview || item.body || '')}</div>
        </div>
      `).join('');
    }

    async function loadMailbox(email) {
      if (!email) return;
      const requestSeq = ++mailboxRequestSeq;
      selectedMailboxEmail = email;
      openMailboxPane();
      mailboxReloadEl.disabled = false;
      renderMailboxLoading(email);
      setMsg(`Loading mailbox for ${email}...`);
      const data = await api(`/accounts/${encodeURIComponent(email)}/messages`);
      if (requestSeq !== mailboxRequestSeq || selectedMailboxEmail !== email) {
        return;
      }
      mailboxSubtitleEl.textContent = data.email ? `当前账号: ${data.email}` : '选择一个账号后，这里显示收信箱内容。';
      mailboxMethodEl.textContent = `API: ${data.resolved_method || data.access_method || '-'}`;
      renderMailboxList(data);
      document.querySelectorAll('#rows tr[data-email]').forEach((row) => {
        row.classList.toggle('selected-row', decodeURIComponent(row.dataset.email) === email);
      });
      setMsg(`Loaded ${data.total_messages || 0} mail(s) for ${email}`);
    }

    async function loadAccounts() {
      setMsg('Loading...');
      const query = filterEl.value ? `?workflow_status=${encodeURIComponent(filterEl.value)}` : '';
      const data = await api(`/accounts${query}`);
      currentAccounts = data.accounts || [];
      renderSummary(data);
      renderAccountsTable();
      if (selectedMailboxEmail && currentAccounts.some((account) => account.email === selectedMailboxEmail)) {
        await loadMailbox(selectedMailboxEmail);
      } else if (!currentAccounts.length) {
        selectedMailboxEmail = null;
        closeMailboxPane();
        resetMailboxContent();
        mailboxListEl.innerHTML = '<div class="empty">暂无邮件可显示。</div>';
      }
      setMsg(`Loaded ${data.accounts.length} accounts`);
    }

    rowsEl.addEventListener('click', async (event) => {
      const tr = event.target.closest('tr');
      if (!tr) return;
      const email = decodeURIComponent(tr.dataset.email);
      const clickedButton = event.target.closest('button');
      if (clickedButton && clickedButton.classList.contains('btn-open-mailbox')) {
        try {
          await loadMailbox(email);
        } catch (err) {
          setMsg(err.message, true);
        }
        return;
      }
      if (clickedButton && clickedButton.classList.contains('btn-save')) {
        try {
          setMsg(`Saving ${email}...`);
          const tags = tr.querySelector('.edit-tags').value.split(',').map(v => v.trim()).filter(Boolean);
          await api(`/accounts/${encodeURIComponent(email)}`, {
            method: 'PUT',
            body: JSON.stringify({
              workflow_status: tr.querySelector('.edit-status').value,
              tags,
              openai_password: tr.querySelector('.edit-openai-password').value,
              note: tr.querySelector('.edit-note').value,
            }),
          });
          await loadAccounts();
          setMsg(`Saved ${email}`);
        } catch (err) {
          setMsg(err.message, true);
        }
        return;
      }
      if (clickedButton && clickedButton.classList.contains('btn-delete')) {
        if (!window.confirm(`Delete ${email}?`)) return;
        try {
          setMsg(`Deleting ${email}...`);
          await api(`/accounts/${encodeURIComponent(email)}`, { method: 'DELETE' });
          if (selectedMailboxEmail === email) {
            selectedMailboxEmail = null;
            closeMailboxPane();
            resetMailboxContent();
          }
          await loadAccounts();
          setMsg(`Deleted ${email}`);
        } catch (err) {
          setMsg(err.message, true);
        }
      }
    });
    rowsEl.addEventListener('change', (event) => {
      if (event.target.classList.contains('row-check')) {
        updateSelectionUi();
      }
    });
    $('#btn-refresh').addEventListener('click', () => loadAccounts().catch(err => setMsg(err.message, true)));
    $('#btn-reset-claimed').addEventListener('click', () => api('/accounts/reset-claimed', { method: 'POST' }).then(() => loadAccounts()).catch(err => setMsg(err.message, true)));
    $('#btn-batch-apply').addEventListener('click', async () => {
      const emails = getSelectedEmails();
      if (!emails.length) return setMsg('Please select at least one account.', true);
      const workflowStatus = batchStatusEl.value || null;
      const addTags = batchTagsEl.value.split(',').map(v => v.trim()).filter(Boolean);
      if (!workflowStatus && !addTags.length) return setMsg('Choose a batch status or enter tags first.', true);
      const data = await api('/accounts/batch-update', {
        method: 'POST',
        body: JSON.stringify({ emails, workflow_status: workflowStatus, add_tags: addTags }),
      });
      renderSummary(data);
      await loadAccounts();
      setMsg(`Updated ${data.affected || 0} account(s)`);
    });
    $('#btn-batch-delete').addEventListener('click', async () => {
      const emails = getSelectedEmails();
      if (!emails.length) return setMsg('Please select at least one account.', true);
      if (!window.confirm(`Delete ${emails.length} selected account(s)?`)) return;
      const data = await api('/accounts/batch-delete', {
        method: 'POST',
        body: JSON.stringify({ emails }),
      });
      renderSummary(data);
      await loadAccounts();
      setMsg(`Deleted ${data.affected || 0} account(s)`);
    });
    $('#btn-clear-db').addEventListener('click', async () => {
      const confirmText = clearConfirmEl.value.trim();
      if (confirmText !== 'CLEAR') return setMsg('Type CLEAR first to confirm database wipe.', true);
      if (!window.confirm('This will permanently delete all accounts in the database. Continue?')) return;
      const data = await api('/accounts/clear', {
        method: 'POST',
        body: JSON.stringify({ confirm_text: confirmText }),
      });
      renderSummary(data);
      clearConfirmEl.value = '';
      await loadAccounts();
      setMsg(`Cleared ${data.affected || 0} account(s)`);
    });
    $('#btn-reload-mailbox').addEventListener('click', () => selectedMailboxEmail && loadMailbox(selectedMailboxEmail).catch(err => setMsg(err.message, true)));
    $('#btn-close-mailbox').addEventListener('click', () => {
      selectedMailboxEmail = null;
      closeMailboxPane();
      resetMailboxContent();
    });
    filterEl.addEventListener('change', () => loadAccounts().catch(err => setMsg(err.message, true)));
    resetMailboxContent();
    loadAccounts().catch(err => setMsg(err.message, true));
  </script>
</body>
</html>"""


class BrowserHealthCache:
    def __init__(self, ttl_seconds: int) -> None:
        self.ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        self._expires_at = 0.0
        self._value: tuple[bool, str | None] = (False, "Not checked yet.")

    def get(self, checker) -> tuple[bool, str | None]:
        with self._lock:
            now = time.monotonic()
            if now < self._expires_at:
                return self._value
            self._value = checker()
            self._expires_at = now + self.ttl_seconds
            return self._value


class MailboxResponseCache:
    def __init__(self, ttl_seconds: int) -> None:
        self.ttl_seconds = ttl_seconds
        self._lock = threading.Lock()
        self._items: dict[str, tuple[float, HotmailMailboxResponse]] = {}

    def get(self, key: str) -> HotmailMailboxResponse | None:
        with self._lock:
            item = self._items.get(key)
            if item is None:
                return None
            expires_at, value = item
            if time.monotonic() >= expires_at:
                self._items.pop(key, None)
                return None
            return value

    def set(self, key: str, value: HotmailMailboxResponse) -> HotmailMailboxResponse:
        with self._lock:
            self._items[key] = (time.monotonic() + self.ttl_seconds, value)
        return value

    def invalidate(self, key: str | None = None) -> None:
        with self._lock:
            if key is None:
                self._items.clear()
                return
            self._items.pop(key, None)


def create_app(
    settings: Settings | None = None,
    account_store: AccountStore | None = None,
    fetcher=None,
    browser_checker=None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    app = FastAPI(title="Hotmail Playwright Code Fetcher")
    app.state.settings = settings
    app.state.fetch_lock = threading.Lock()
    app.state.browser_health_cache = BrowserHealthCache(settings.browser_health_cache_seconds)
    app.state.mailbox_cache = MailboxResponseCache(ACCOUNT_MAILBOX_CACHE_SECONDS)
    app.state.browser_checker = browser_checker or default_browser_checker
    app.state.account_db = HotmailAccountDb(settings.accounts_db)

    if account_store is not None:
        app.state.account_store = account_store
        app.state.accounts_error = None
    else:
        try:
            app.state.account_store = load_accounts_csv(settings.accounts_csv)
            app.state.accounts_error = None
        except AccountsLoadError as exc:
            app.state.account_store = None
            app.state.accounts_error = str(exc)

    app.state.fetcher = fetcher or OutlookWebFetcher(settings)

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        browser_ready, browser_reason = app.state.browser_health_cache.get(app.state.browser_checker)
        account_store_local = app.state.account_store
        return HealthResponse(
            status="ok" if account_store_local is not None and browser_ready else "degraded",
            csv_loaded=account_store_local is not None,
            csv_path=str(settings.accounts_csv.resolve()),
            account_count=len(account_store_local) if account_store_local is not None else 0,
            browser_ready=browser_ready,
            browser_reason=browser_reason if not browser_ready else None,
            headless=settings.headless,
            artifacts_dir=str(settings.artifacts_dir.resolve()),
            oauth_helper_redirect_uri=settings.oauth_redirect_uri,
            oauth_helper_client_id=settings.oauth_client_id,
        )

    @app.post("/accounts/import", response_model=HotmailImportResponse)
    def import_accounts(request: HotmailImportRequest) -> HotmailImportResponse:
        result = app.state.account_db.import_raw(request.raw_text)
        app.state.mailbox_cache.invalidate()
        return HotmailImportResponse(status="ok", **result)

    @app.get("/accounts/summary", response_model=HotmailSummaryResponse)
    def accounts_summary() -> HotmailSummaryResponse:
        return HotmailSummaryResponse(status="ok", **app.state.account_db.summary())

    @app.get("/accounts", response_model=HotmailAccountsListResponse)
    def list_accounts(workflow_status: str | None = None) -> HotmailAccountsListResponse:
        accounts = app.state.account_db.list_accounts(workflow_status=workflow_status)
        return HotmailAccountsListResponse(
            status="ok",
            accounts=[to_hotmail_account_response(account) for account in accounts],
            **app.state.account_db.summary(),
        )

    @app.get("/accounts/ui", response_class=HTMLResponse)
    def accounts_ui() -> HTMLResponse:
        return HTMLResponse(render_accounts_ui_html())

    @app.post("/accounts/batch-update", response_model=HotmailBatchActionResponse)
    def batch_update_accounts(request: HotmailBatchUpdateRequest) -> HotmailBatchActionResponse:
        affected = app.state.account_db.batch_update_accounts(
            emails=request.emails,
            workflow_status=request.workflow_status,
            add_tags=request.add_tags,
        )
        for email in request.emails:
            app.state.mailbox_cache.invalidate(email)
        return HotmailBatchActionResponse(status="ok", affected=affected, **app.state.account_db.summary())

    @app.post("/accounts/reset-claimed", response_model=HotmailSummaryResponse)
    def reset_claimed_accounts() -> HotmailSummaryResponse:
        reset_count = app.state.account_db.reset_claimed()
        app.state.mailbox_cache.invalidate()
        return HotmailSummaryResponse(status="ok", reset_claimed=reset_count, **app.state.account_db.summary())

    @app.post("/accounts/claim-next", response_model=HotmailClaimResponse)
    def claim_next_account() -> HotmailClaimResponse:
        account = app.state.account_db.claim_next()
        summary = app.state.account_db.summary()
        if account is None:
            return HotmailClaimResponse(
                status="empty",
                account=None,
                reason="No pending accounts remained in the database.",
                **summary,
            )
        return HotmailClaimResponse(
            status="ok",
            account=to_hotmail_account_response(account),
            **summary,
        )

    @app.post("/accounts/mark", response_model=HotmailClaimResponse)
    def mark_account(request: HotmailMarkRequest) -> HotmailClaimResponse:
        updated = app.state.account_db.update_result(
            email=request.email,
            workflow_status=request.workflow_status,
            tag=request.tag,
            note=request.note,
            openai_password=request.openai_password,
        )
        app.state.mailbox_cache.invalidate(request.email)
        summary = app.state.account_db.summary()
        if updated is None:
            raise HTTPException(status_code=404, detail=f"Unknown hotmail db account: {request.email}")
        return HotmailClaimResponse(
            status="ok",
            account=to_hotmail_account_response(updated),
            **summary,
        )

    @app.put("/accounts/{email:path}", response_model=HotmailClaimResponse)
    def update_account(email: str, request: HotmailAccountUpdateRequest) -> HotmailClaimResponse:
        updated = app.state.account_db.update_account(
            email=email,
            workflow_status=request.workflow_status,
            tags=request.tags,
            note=request.note,
            openai_password=request.openai_password,
            access_method=request.access_method,
        )
        summary = app.state.account_db.summary()
        if updated is None:
            raise HTTPException(status_code=404, detail=f"Unknown hotmail db account: {email}")
        app.state.mailbox_cache.invalidate(email)
        return HotmailClaimResponse(
            status="ok",
            account=to_hotmail_account_response(updated),
            **summary,
        )

    @app.get("/accounts/{email:path}/messages", response_model=HotmailMailboxResponse)
    def get_account_messages(email: str) -> HotmailMailboxResponse:
        account = app.state.account_db.get(email)
        if account is None:
            raise HTTPException(status_code=404, detail=f"Unknown hotmail db account: {email}")

        cached = app.state.mailbox_cache.get(account.email)
        if cached is not None:
            return cached

        resolved_method = "unknown"
        reason: str | None = None
        supports_listing = True
        raw_messages = []
        try:
            with app.state.fetch_lock:
                resolved_method, raw_messages = app.state.fetcher.list_messages(
                    Account(
                        id=account.email,
                        email=account.email,
                        password=account.password,
                        client_id=account.client_id,
                        refresh_token=account.refresh_token,
                        access_method=account.access_method,
                    ),
                    limit=ACCOUNT_MAILBOX_LIST_LIMIT,
                )
        except Exception as exc:
            reason = str(exc)
            supports_listing = False

        response = to_hotmail_mailbox_response(
            account,
            resolved_method,
            raw_messages,
            reason=reason,
            supports_listing=supports_listing,
        )
        return app.state.mailbox_cache.set(account.email, response)

    @app.delete("/accounts/{email:path}", response_model=HotmailDeleteResponse)
    def delete_account(email: str) -> HotmailDeleteResponse:
        deleted = app.state.account_db.delete_account(email)
        if not deleted:
            raise HTTPException(status_code=404, detail=f"Unknown hotmail db account: {email}")
        app.state.mailbox_cache.invalidate(email)
        return HotmailDeleteResponse(status="ok", deleted=True, **app.state.account_db.summary())

    @app.post("/accounts/batch-delete", response_model=HotmailBatchActionResponse)
    def batch_delete_accounts(request: HotmailBatchDeleteRequest) -> HotmailBatchActionResponse:
        affected = app.state.account_db.batch_delete_accounts(request.emails)
        for email in request.emails:
            app.state.mailbox_cache.invalidate(email)
        return HotmailBatchActionResponse(status="ok", affected=affected, **app.state.account_db.summary())

    @app.post("/accounts/clear", response_model=HotmailBatchActionResponse)
    def clear_accounts(request: HotmailClearRequest) -> HotmailBatchActionResponse:
        if request.confirm_text.strip() != "CLEAR":
            raise HTTPException(status_code=400, detail="Type CLEAR to confirm database wipe.")
        affected = app.state.account_db.clear_all_accounts()
        app.state.mailbox_cache.invalidate()
        return HotmailBatchActionResponse(status="ok", affected=affected, **app.state.account_db.summary())

    @app.post("/fetch-code", response_model=FetchCodeResponse)
    def fetch_code(request: FetchCodeRequest) -> FetchCodeResponse:
        account = resolve_account_reference(app.state.account_store, request.account)
        if account is None:
            raise HTTPException(status_code=404, detail=f"Unknown account: {request.account}")

        with app.state.fetch_lock:
            result = app.state.fetcher.fetch_code(
                account=account,
                max_wait_seconds=request.max_wait_seconds or settings.default_max_wait_seconds,
                poll_interval_seconds=request.poll_interval_seconds or settings.default_poll_interval_seconds,
                min_created_at_ms=request.min_created_at_ms,
                exclude_codes=request.exclude_codes,
                request_context={
                    "endpoint": "/fetch-code",
                    "account": request.account,
                    "email": account.email,
                    "min_created_at_ms": request.min_created_at_ms,
                    "exclude_codes": request.exclude_codes,
                },
            )
        return FetchCodeResponse(**result.to_dict())

    @app.post("/fetch-code-direct", response_model=FetchCodeResponse)
    def fetch_code_direct(request: FetchCodeDirectRequest) -> FetchCodeResponse:
        account = build_direct_account(request)

        with app.state.fetch_lock:
            result = app.state.fetcher.fetch_code(
                account=account,
                max_wait_seconds=request.max_wait_seconds or settings.default_max_wait_seconds,
                poll_interval_seconds=request.poll_interval_seconds or settings.default_poll_interval_seconds,
                min_created_at_ms=request.min_created_at_ms,
                exclude_codes=request.exclude_codes,
                request_context={
                    "endpoint": "/fetch-code-direct",
                    "account": request.email.strip(),
                    "email": request.email.strip(),
                    "min_created_at_ms": request.min_created_at_ms,
                    "exclude_codes": request.exclude_codes,
                },
            )
        return FetchCodeResponse(**result.to_dict())

    @app.post("/messages-direct", response_model=HotmailMailboxResponse)
    def get_direct_messages(request: FetchCodeDirectRequest) -> HotmailMailboxResponse:
        account = build_direct_account(request)

        resolved_method = "unknown"
        reason: str | None = None
        supports_listing = True
        raw_messages = []
        try:
            with app.state.fetch_lock:
                resolved_method, raw_messages = app.state.fetcher.list_messages(account, limit=DIRECT_MAILBOX_LIST_LIMIT)
        except Exception as exc:
            reason = str(exc)
            supports_listing = False

        return to_hotmail_mailbox_response(
            account,
            resolved_method,
            raw_messages,
            reason=reason,
            supports_listing=supports_listing,
        )

    @app.post("/release-session", response_model=ReleaseSessionResponse)
    def release_session(request: ReleaseSessionRequest) -> ReleaseSessionResponse:
        account = resolve_account_reference(app.state.account_store, request.account)
        if account is None:
            raise HTTPException(status_code=404, detail=f"Unknown account: {request.account}")

        with app.state.fetch_lock:
            released, session_path = app.state.fetcher.release_session(account)

        return ReleaseSessionResponse(
            status="released" if released else "not_found",
            account=account.id,
            released=released,
            session_path=str(session_path),
            reason=None if released else "No cached session existed for this account.",
        )

    @app.get("/oauth/auth-url", response_model=OAuthAuthUrlResponse)
    def oauth_auth_url(client_id: str | None = None, redirect_uri: str | None = None) -> OAuthAuthUrlResponse:
        resolved_client_id = (client_id or settings.oauth_client_id).strip()
        resolved_redirect_uri = (redirect_uri or settings.oauth_redirect_uri).strip()
        return OAuthAuthUrlResponse(
            status="ok",
            auth_url=get_oauth_authorize_url(resolved_client_id, resolved_redirect_uri),
            client_id=resolved_client_id,
            redirect_uri=resolved_redirect_uri,
            scopes=[
                "offline_access",
                "https://graph.microsoft.com/Mail.Read",
                "https://graph.microsoft.com/User.Read",
                "https://outlook.office.com/IMAP.AccessAsUser.All",
            ],
        )

    @app.post("/oauth/exchange-token", response_model=OAuthExchangeResponse)
    def oauth_exchange_token(request: OAuthExchangeRequest) -> OAuthExchangeResponse:
        resolved_client_id = (request.client_id or settings.oauth_client_id).strip()
        resolved_redirect_uri = (request.redirect_uri or settings.oauth_redirect_uri).strip()
        code = request.code or extract_code_from_callback_url(request.callback_url or "")
        try:
            payload = exchange_authorization_code(resolved_client_id, resolved_redirect_uri, code)
            return OAuthExchangeResponse(
                status="ok",
                refresh_token=payload.get("refresh_token"),
                access_token=payload.get("access_token"),
                token_type=payload.get("token_type"),
                expires_in=payload.get("expires_in"),
                scope=payload.get("scope"),
                client_id=resolved_client_id,
                redirect_uri=resolved_redirect_uri,
                reason=None,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

    return app


def resolve_account_reference(account_store: AccountStore | None, account_ref: str) -> Account | None:
    if account_store is not None:
        account = account_store.get(account_ref)
        if account is not None:
            return account
    normalized = account_ref.strip()
    if "@" in normalized:
        return Account(id=normalized, email=normalized, password="")
    return None


def default_browser_checker() -> tuple[bool, str | None]:
    from playwright.sync_api import sync_playwright

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            browser.close()
        return True, None
    except Exception as exc:  # pragma: no cover - environment dependent
        return False, str(exc)


app = create_app()
