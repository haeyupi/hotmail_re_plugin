// sidepanel/sidepanel.js — Side Panel logic

const STATUS_ICONS = {
  pending: '',
  running: '',
  completed: '\u2713',  // ✓
  failed: '\u2717',     // ✗
  stopped: '\u25A0',    // ■
};

const logArea = document.getElementById('log-area');
const displayOauthUrl = document.getElementById('display-oauth-url');
const displayLocalhostUrl = document.getElementById('display-localhost-url');
const displayStatus = document.getElementById('display-status');
const statusBar = document.getElementById('status-bar');
const inputEmail = document.getElementById('input-email');
const inputPassword = document.getElementById('input-password');
const rowSignupEmail = inputEmail.closest('.data-row');
const rowSignupPassword = inputPassword.closest('.data-row');
const btnFetchEmail = document.getElementById('btn-fetch-email');
const autoHint = document.getElementById('auto-hint');
const btnTogglePassword = document.getElementById('btn-toggle-password');
const btnStop = document.getElementById('btn-stop');
const btnReset = document.getElementById('btn-reset');
const stepsProgress = document.getElementById('steps-progress');
const btnAutoRun = document.getElementById('btn-auto-run');
const btnAutoContinue = document.getElementById('btn-auto-continue');
const autoContinueBar = document.getElementById('auto-continue-bar');
const btnClearLog = document.getElementById('btn-clear-log');
const inputVpsUrl = document.getElementById('input-vps-url');
const inputCpaKey = document.getElementById('input-cpa-key');
const btnToggleCpaKey = document.getElementById('btn-toggle-cpa-key');
const selectMailProvider = document.getElementById('select-mail-provider');
const selectEmailProvider = document.getElementById('select-email-provider');
const rowCloudflareTempEmailUrl = document.getElementById('row-cloudflare-temp-email-url');
const inputCloudflareTempEmailUrl = document.getElementById('input-cloudflare-temp-email-url');
const rowHotmailApiUrl = document.getElementById('row-hotmail-api-url');
const inputHotmailApiUrl = document.getElementById('input-hotmail-api-url');
const rowHotmailServiceStatus = document.getElementById('row-hotmail-service-status');
const displayHotmailServiceStatus = document.getElementById('display-hotmail-service-status');
const hotmailServiceDot = document.getElementById('hotmail-service-dot');
const hotmailServiceText = document.getElementById('hotmail-service-text');
const btnCopyHotmailStart = document.getElementById('btn-copy-hotmail-start');
const rowHotmailCurrentAccount = document.getElementById('row-hotmail-current-account');
const displayHotmailCurrentAccount = document.getElementById('display-hotmail-current-account');
const rowHotmailEmail = document.getElementById('row-hotmail-email');
const inputHotmailEmail = document.getElementById('input-hotmail-email');
const rowHotmailPassword = document.getElementById('row-hotmail-password');
const inputHotmailPassword = document.getElementById('input-hotmail-password');
const rowHotmailAccessMethod = document.getElementById('row-hotmail-access-method');
const selectHotmailAccessMethod = document.getElementById('select-hotmail-access-method');
const rowHotmailClientId = document.getElementById('row-hotmail-client-id');
const inputHotmailClientId = document.getElementById('input-hotmail-client-id');
const rowHotmailRefreshToken = document.getElementById('row-hotmail-refresh-token');
const inputHotmailRefreshToken = document.getElementById('input-hotmail-refresh-token');
const rowHotmailBatch = document.getElementById('row-hotmail-batch');
const inputHotmailBatch = document.getElementById('input-hotmail-batch');
const displayHotmailBatchCount = document.getElementById('display-hotmail-batch-count');
const displayHotmailDbSummary = document.getElementById('display-hotmail-db-summary');
const btnImportHotmailDb = document.getElementById('btn-import-hotmail-db');
const btnRefreshHotmailDb = document.getElementById('btn-refresh-hotmail-db');
const btnOpenHotmailDbUi = document.getElementById('btn-open-hotmail-db-ui');
const rowInbucketHost = document.getElementById('row-inbucket-host');
const inputInbucketHost = document.getElementById('input-inbucket-host');
const rowInbucketMailbox = document.getElementById('row-inbucket-mailbox');
const inputInbucketMailbox = document.getElementById('input-inbucket-mailbox');
const inputRunCount = document.getElementById('input-run-count');
const btnSaveCpa = document.getElementById('btn-save-cpa');
let hotmailServiceStatusTimer = null;

const {
  DEFAULT_CLOUDFLARE_TEMP_EMAIL_ADMIN_URL = 'https://mail.cloudflare.com/admin',
  DEFAULT_HOTMAIL_API_BASE_URL = 'http://127.0.0.1:8001',
  EMAIL_PROVIDER_2925 = 'mail_2925',
  EMAIL_PROVIDER_CLOUDFLARE_TEMP_EMAIL = 'cloudflare_temp_email',
  EMAIL_PROVIDER_DUCK = 'duckduckgo',
  EMAIL_PROVIDER_HOTMAIL = 'hotmail',
  EMAIL_PROVIDER_RELAY_FIREFOX = 'relay_firefox',
  MAIL_PROVIDER_2925 = '2925',
  MAIL_PROVIDER_CLOUDFLARE_TEMP_EMAIL = 'cloudflare_temp_email',
  MAIL_PROVIDER_HOTMAIL = 'hotmail',
  getEmailProviderDisplayName = (value) => value === 'mail_2925'
    ? '2925 Mail'
    : value === 'relay_firefox'
      ? 'Firefox Relay'
      : value === 'cloudflare_temp_email'
        ? 'Cloudflare Temp Email'
        : value === 'hotmail'
          ? 'Hotmail'
          : 'DuckDuckGo',
  normalizeCloudflareTempEmailAdminUrl = (value) => value || DEFAULT_CLOUDFLARE_TEMP_EMAIL_ADMIN_URL,
  normalizeHotmailApiBaseUrl = (value) => value || DEFAULT_HOTMAIL_API_BASE_URL,
  normalizeEmailProvider = (value) => {
    if (value === 'mail_2925') return 'mail_2925';
    if (value === 'relay_firefox') return 'relay_firefox';
    if (value === 'cloudflare_temp_email') return 'cloudflare_temp_email';
    if (value === 'hotmail') return 'hotmail';
    return 'duckduckgo';
  },
} = globalThis.MultiPageEmailProvider || {};

// ============================================================
// Toast Notifications
// ============================================================

const toastContainer = document.getElementById('toast-container');

const TOAST_ICONS = {
  error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  warn: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

function showToast(message, type = 'error', duration = 4000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `${TOAST_ICONS[type] || ''}<span class="toast-msg">${escapeHtml(message)}</span><button class="toast-close">&times;</button>`;

  toast.querySelector('.toast-close').addEventListener('click', () => dismissToast(toast));
  toastContainer.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => dismissToast(toast), duration);
  }
}

function dismissToast(toast) {
  if (!toast.parentNode) return;
  toast.classList.add('toast-exit');
  toast.addEventListener('animationend', () => toast.remove());
}

// ============================================================
// State Restore on load
// ============================================================

async function restoreState() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' });
    let initialHotmailStatusRefresh = null;

    if (state.oauthUrl) {
      displayOauthUrl.textContent = state.oauthUrl;
      displayOauthUrl.classList.add('has-value');
    }
    if (state.localhostUrl) {
      displayLocalhostUrl.textContent = state.localhostUrl;
      displayLocalhostUrl.classList.add('has-value');
    }
    if (state.email) {
      inputEmail.value = state.email;
    }
    syncPasswordField(state);
    if (state.cpaBaseUrl || state.vpsUrl) {
      inputVpsUrl.value = state.cpaBaseUrl || state.vpsUrl;
    }
    if (state.cpaManagementKey !== undefined) {
      inputCpaKey.value = state.cpaManagementKey || '';
    }
    if (state.mailProvider) {
      selectMailProvider.value = state.mailProvider;
    }
    if (state.emailProvider) {
      selectEmailProvider.value = normalizeEmailProvider(state.emailProvider);
    }
    if (state.cloudflareTempEmailAdminUrl) {
      inputCloudflareTempEmailUrl.value = state.cloudflareTempEmailAdminUrl;
    }
    if (state.hotmailApiBaseUrl) {
      inputHotmailApiUrl.value = state.hotmailApiBaseUrl;
    }
    if (state.hotmailEmail) {
      inputHotmailEmail.value = state.hotmailEmail;
    }
    if (state.hotmailPassword !== undefined) {
      inputHotmailPassword.value = state.hotmailPassword || '';
    }
    if (state.hotmailAccessMethod) {
      selectHotmailAccessMethod.value = state.hotmailAccessMethod;
    }
    if (state.hotmailClientId) {
      inputHotmailClientId.value = state.hotmailClientId;
    }
    if (state.hotmailRefreshToken !== undefined) {
      inputHotmailRefreshToken.value = state.hotmailRefreshToken || '';
    }
    if (state.hotmailBatchRaw !== undefined && inputHotmailBatch) {
      inputHotmailBatch.value = state.hotmailBatchRaw || '';
    }
    if (state.hotmailDbSummary) {
      setHotmailDbSummary(state.hotmailDbSummary);
    }
    setCurrentHotmailDbAccount(state.currentHotmailDbEmail || '');
    if (state.inbucketHost) {
      inputInbucketHost.value = state.inbucketHost;
    }
    if (state.inbucketMailbox) {
      inputInbucketMailbox.value = state.inbucketMailbox;
    }

    updateMailProviderUI();
    updateHotmailBatchCount();
    setHotmailDbSummary(state.hotmailDbSummary || null);
    updateAutoContinueHint();
    initialHotmailStatusRefresh = refreshHotmailServiceStatus({ silent: true }).catch(() => null);

    if (state.stepStatuses) {
      for (const [step, status] of Object.entries(state.stepStatuses)) {
        updateStepUI(Number(step), status);
      }
    }

    if (state.logs) {
      for (const entry of state.logs) {
        appendLog(entry);
      }
    }

    updateStatusDisplay(state);
    updateProgressCounter();
    await initialHotmailStatusRefresh;
    await refreshHotmailDbSummary().catch(() => {});
  } catch (err) {
    console.error('Failed to restore state:', err);
  }
}

function syncPasswordField(state) {
  inputPassword.value = state.customPassword || state.password || '';
}

function isHotmailSourceSelected() {
  return getSelectedEmailProvider() === EMAIL_PROVIDER_HOTMAIL;
}

function shouldShowHotmailSettings() {
  return isHotmailSourceSelected() || selectMailProvider.value === MAIL_PROVIDER_HOTMAIL;
}

function getHotmailAccessMethod() {
  return (selectHotmailAccessMethod.value || 'auto').trim() || 'auto';
}

function parseHotmailBatchRaw(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const parts = line.split('----');
      if (parts.length < 4) return null;
      const email = (parts[0] || '').trim();
      const password = (parts[1] || '').trim();
      const clientId = (parts[2] || '').trim();
      const refreshToken = parts.slice(3).join('----').trim();
      if (!email) return null;
      return { index, email, password, clientId, refreshToken };
    })
    .filter(Boolean);
}

function updateHotmailBatchCount() {
  if (!displayHotmailBatchCount) return;
  const count = parseHotmailBatchRaw(inputHotmailBatch?.value || '').length;
  displayHotmailBatchCount.textContent = `${count} accounts`;
}

function setHotmailDbSummary(summary = null) {
  if (!displayHotmailDbSummary) return;
  if (!summary) {
    displayHotmailDbSummary.textContent = 'pending 0 | claimed 0 | success 0 | failed 0';
    return;
  }
  displayHotmailDbSummary.textContent =
    `pending ${summary.pending || 0} | claimed ${summary.claimed || 0} | success ${summary.success || 0} | failed ${summary.failed || 0}`;
}

function setCurrentHotmailDbAccount(email = '') {
  if (!displayHotmailCurrentAccount) return;
  const value = String(email || '').trim();
  if (!value) {
    displayHotmailCurrentAccount.textContent = 'Idle';
    displayHotmailCurrentAccount.classList.add('is-idle');
    return;
  }
  displayHotmailCurrentAccount.textContent = value;
  displayHotmailCurrentAccount.classList.remove('is-idle');
}

function setHotmailServiceStatus(status, message) {
  if (!displayHotmailServiceStatus) return;
  if (hotmailServiceText) {
    hotmailServiceText.textContent = message;
  }
  displayHotmailServiceStatus.title = message || status || '';
  displayHotmailServiceStatus.setAttribute('aria-label', message || status || '');
  displayHotmailServiceStatus.classList.remove('service-online', 'service-offline', 'service-checking');
  if (hotmailServiceDot) {
    hotmailServiceDot.classList.remove('service-dot-online', 'service-dot-offline', 'service-dot-checking');
  }
  if (status === 'online') displayHotmailServiceStatus.classList.add('service-online');
  else if (status === 'offline') displayHotmailServiceStatus.classList.add('service-offline');
  else displayHotmailServiceStatus.classList.add('service-checking');

  if (hotmailServiceDot) {
    if (status === 'online') hotmailServiceDot.classList.add('service-dot-online');
    else if (status === 'offline') hotmailServiceDot.classList.add('service-dot-offline');
    else hotmailServiceDot.classList.add('service-dot-checking');
  }
}

function startHotmailServiceStatusPolling() {
  stopHotmailServiceStatusPolling();
  if (!shouldShowHotmailSettings()) return;
  hotmailServiceStatusTimer = setInterval(() => {
    refreshHotmailServiceStatus({ silent: true }).catch(() => {});
  }, 5000);
}

function stopHotmailServiceStatusPolling() {
  if (hotmailServiceStatusTimer) {
    clearInterval(hotmailServiceStatusTimer);
    hotmailServiceStatusTimer = null;
  }
}

function getHotmailStartCommand() {
  return 'powershell -ExecutionPolicy Bypass -File ".\\\\hotmail-service\\\\start_hotmail_service.ps1"';
}

async function refreshHotmailServiceStatus({ silent = false } = {}) {
  if (!shouldShowHotmailSettings()) return null;
  const baseUrl = normalizeHotmailApiBaseUrl(inputHotmailApiUrl.value.trim());
  setHotmailServiceStatus('checking', 'Checking...');
  try {
    const response = await fetch(`${baseUrl}/health`, { method: 'GET' });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.detail || response.statusText || 'Health check failed');
    }
    const browserReady = payload?.browser_ready !== false;
    setHotmailServiceStatus(browserReady ? 'online' : 'offline', browserReady ? 'Online' : 'Offline');
    return payload;
  } catch (err) {
    setHotmailServiceStatus('offline', 'Offline');
    if (!silent) {
      showToast(`Hotmail service offline: ${err.message}`, 'warn', 2500);
    }
    return null;
  }
}

async function importHotmailBatchToDb() {
  await persistFormState();
  const rawText = inputHotmailBatch.value || '';
  if (!rawText.trim()) {
    showToast('Hotmail Batch is empty', 'warn');
    return;
  }
  const response = await chrome.runtime.sendMessage({
    type: 'IMPORT_HOTMAIL_DB',
    source: 'sidepanel',
    payload: { rawText },
  });
  if (response?.error) {
    throw new Error(response.error);
  }
  setHotmailDbSummary(response?.summary || null);
  updateHotmailBatchCount();
  inputHotmailEmail.value = '';
  inputHotmailPassword.value = '';
  inputHotmailClientId.value = '';
  inputHotmailRefreshToken.value = '';
  syncHotmailEmailBinding();
  showToast(`Imported ${response?.summary?.imported || 0}, updated ${response?.summary?.updated || 0}`, 'success', 2500);
}

async function refreshHotmailDbSummary() {
  const response = await chrome.runtime.sendMessage({
    type: 'REFRESH_HOTMAIL_DB_SUMMARY',
    source: 'sidepanel',
    payload: {},
  });
  if (response?.error) {
    throw new Error(response.error);
  }
  setHotmailDbSummary(response?.summary || null);
}

async function openHotmailDbUi() {
  const baseUrl = normalizeHotmailApiBaseUrl(inputHotmailApiUrl.value.trim());
  await chrome.tabs.create({ url: `${baseUrl}/accounts/ui` });
}

function toRestartHint(message) {
  const text = String(message || '');
  if (/404|Not Found/i.test(text)) {
    return `${text} — please restart hotmail-service on port 8001`;
  }
  return text;
}

async function saveCpaPersistentSettings() {
  const response = await chrome.runtime.sendMessage({
    type: 'SAVE_CPA_PERSISTENT',
    source: 'sidepanel',
    payload: {
      cpaBaseUrl: inputVpsUrl.value.trim(),
      cpaManagementKey: inputCpaKey.value,
    },
  });
  if (response?.error) {
    throw new Error(response.error);
  }
}

function syncMailProviderForSelectedSource() {
  if (getSelectedEmailProvider() === EMAIL_PROVIDER_2925) {
    selectMailProvider.value = MAIL_PROVIDER_2925;
  }
  if (getSelectedEmailProvider() === EMAIL_PROVIDER_CLOUDFLARE_TEMP_EMAIL) {
    selectMailProvider.value = MAIL_PROVIDER_CLOUDFLARE_TEMP_EMAIL;
  }
  if (isHotmailSourceSelected()) {
    selectMailProvider.value = MAIL_PROVIDER_HOTMAIL;
  }
}

function syncHotmailEmailBinding() {
  const isHotmailSource = isHotmailSourceSelected();
  inputEmail.readOnly = isHotmailSource;
  inputEmail.placeholder = isHotmailSource ? 'Synced from Hotmail Email' : 'Paste signup email';
  btnFetchEmail.textContent = isHotmailSource ? 'Check' : 'Auto';

  if (isHotmailSource) {
    inputEmail.value = inputHotmailEmail.value.trim();
  }
}

function updateMailProviderUI() {
  syncMailProviderForSelectedSource();
  const useInbucket = selectMailProvider.value === 'inbucket';
  const useCloudflareTempEmail = getSelectedEmailProvider() === EMAIL_PROVIDER_CLOUDFLARE_TEMP_EMAIL;
  const useHotmail = shouldShowHotmailSettings();

  inputCloudflareTempEmailUrl.placeholder = DEFAULT_CLOUDFLARE_TEMP_EMAIL_ADMIN_URL;
  inputHotmailApiUrl.placeholder = DEFAULT_HOTMAIL_API_BASE_URL;
  rowCloudflareTempEmailUrl.style.display = useCloudflareTempEmail ? '' : 'none';
  rowHotmailApiUrl.style.display = useHotmail ? '' : 'none';
  rowHotmailServiceStatus.style.display = useHotmail ? '' : 'none';
  rowHotmailCurrentAccount.style.display = useHotmail ? '' : 'none';
  rowHotmailEmail.style.display = 'none';
  rowHotmailPassword.style.display = 'none';
  rowHotmailAccessMethod.style.display = 'none';
  rowHotmailClientId.style.display = 'none';
  rowHotmailRefreshToken.style.display = 'none';
  rowHotmailBatch.style.display = useHotmail ? '' : 'none';
  rowInbucketHost.style.display = useInbucket ? '' : 'none';
  rowInbucketMailbox.style.display = useInbucket ? '' : 'none';
  selectMailProvider.disabled = isHotmailSourceSelected();
  if (rowSignupEmail) rowSignupEmail.style.display = useHotmail ? 'none' : '';
  if (rowSignupPassword) rowSignupPassword.style.display = useHotmail ? 'none' : '';
  syncHotmailEmailBinding();
  if (useHotmail) startHotmailServiceStatusPolling();
  else stopHotmailServiceStatusPolling();
}

function getSelectedEmailProvider() {
  return normalizeEmailProvider(selectEmailProvider.value);
}

function getDisplayedEmailValue() {
  return isHotmailSourceSelected() ? inputHotmailEmail.value.trim() : inputEmail.value.trim();
}

function getEmailProviderName(provider = getSelectedEmailProvider()) {
  return getEmailProviderDisplayName(provider);
}

function updateAutoContinueHint() {
  const provider = getSelectedEmailProvider();
  if (!autoHint) return;
  if (provider === EMAIL_PROVIDER_2925) {
    autoHint.textContent = 'Use Auto to detect the current 2925 mailbox and generate a child mailbox, then continue';
    return;
  }
  if (provider === EMAIL_PROVIDER_HOTMAIL) {
    const pendingCountText = displayHotmailDbSummary?.textContent || 'pending 0 | claimed 0 | success 0 | failed 0';
    autoHint.textContent = `Use Check to verify the Hotmail service, then continue with the next pending DB account (${pendingCountText})`;
    return;
  }
  if (provider === EMAIL_PROVIDER_RELAY_FIREFOX) {
    autoHint.textContent = 'Use Auto to create a Relay mask, or paste manually, then continue';
    return;
  }
  if (provider === EMAIL_PROVIDER_CLOUDFLARE_TEMP_EMAIL) {
    const configuredUrl = normalizeCloudflareTempEmailAdminUrl(inputCloudflareTempEmailUrl.value.trim());
    autoHint.textContent = `Use Auto to create a Cloudflare Temp Email mailbox from ${configuredUrl}, or paste an existing admin mailbox, then continue`;
    return;
  }
  autoHint.textContent = 'Use Auto to fetch Duck email, or paste manually, then continue';
}

// ============================================================
// UI Updates
// ============================================================

function updateStepUI(step, status) {
  const statusEl = document.querySelector(`.step-status[data-step="${step}"]`);
  const row = document.querySelector(`.step-row[data-step="${step}"]`);

  if (statusEl) statusEl.textContent = STATUS_ICONS[status] || '';
  if (row) {
    row.className = `step-row ${status}`;
  }

  updateButtonStates();
  updateProgressCounter();
}

function updateProgressCounter() {
  let completed = 0;
  document.querySelectorAll('.step-row').forEach(row => {
    if (row.classList.contains('completed')) completed++;
  });
  stepsProgress.textContent = `${completed} / 9`;
}

function updateButtonStates() {
  const statuses = {};
  document.querySelectorAll('.step-row').forEach(row => {
    const step = Number(row.dataset.step);
    if (row.classList.contains('completed')) statuses[step] = 'completed';
    else if (row.classList.contains('running')) statuses[step] = 'running';
    else if (row.classList.contains('failed')) statuses[step] = 'failed';
    else if (row.classList.contains('stopped')) statuses[step] = 'stopped';
    else statuses[step] = 'pending';
  });

  const anyRunning = Object.values(statuses).some(s => s === 'running');

  for (let step = 1; step <= 9; step++) {
    const btn = document.querySelector(`.step-btn[data-step="${step}"]`);
    if (!btn) continue;

    if (anyRunning) {
      btn.disabled = true;
    } else if (step === 1) {
      btn.disabled = false;
    } else {
      const prevStatus = statuses[step - 1];
      const currentStatus = statuses[step];
      btn.disabled = !(prevStatus === 'completed' || currentStatus === 'failed' || currentStatus === 'completed' || currentStatus === 'stopped');
    }
  }

  updateStopButtonState(anyRunning || autoContinueBar.style.display !== 'none');
}

function updateStopButtonState(active) {
  btnStop.disabled = !active;
}

function updateStatusDisplay(state) {
  if (!state || !state.stepStatuses) return;

  statusBar.className = 'status-bar';

  const running = Object.entries(state.stepStatuses).find(([, s]) => s === 'running');
  if (running) {
    displayStatus.textContent = `Step ${running[0]} running...`;
    statusBar.classList.add('running');
    return;
  }

  const failed = Object.entries(state.stepStatuses).find(([, s]) => s === 'failed');
  if (failed) {
    displayStatus.textContent = `Step ${failed[0]} failed`;
    statusBar.classList.add('failed');
    return;
  }

  const stopped = Object.entries(state.stepStatuses).find(([, s]) => s === 'stopped');
  if (stopped) {
    displayStatus.textContent = `Step ${stopped[0]} stopped`;
    statusBar.classList.add('stopped');
    return;
  }

  const lastCompleted = Object.entries(state.stepStatuses)
    .filter(([, s]) => s === 'completed')
    .map(([k]) => Number(k))
    .sort((a, b) => b - a)[0];

  if (lastCompleted === 9) {
    displayStatus.textContent = 'All steps completed!';
    statusBar.classList.add('completed');
  } else if (lastCompleted) {
    displayStatus.textContent = `Step ${lastCompleted} done`;
  } else {
    displayStatus.textContent = 'Ready';
  }
}

function appendLog(entry) {
  const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
  const levelLabel = entry.level.toUpperCase();
  const line = document.createElement('div');
  line.className = `log-line log-${entry.level}`;

  const stepMatch = entry.message.match(/Step (\d)/);
  const stepNum = stepMatch ? stepMatch[1] : null;

  let html = `<span class="log-time">${time}</span> `;
  html += `<span class="log-level log-level-${entry.level}">${levelLabel}</span> `;
  if (stepNum) {
    html += `<span class="log-step-tag step-${stepNum}">S${stepNum}</span>`;
  }
  html += `<span class="log-msg">${escapeHtml(entry.message)}</span>`;

  line.innerHTML = html;
  logArea.appendChild(line);
  logArea.scrollTop = logArea.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function persistFormState() {
  const settingsPayload = {
    cpaBaseUrl: inputVpsUrl.value.trim(),
    cpaManagementKey: inputCpaKey.value,
    customPassword: inputPassword.value,
    emailProvider: getSelectedEmailProvider(),
    mailProvider: selectMailProvider.value,
    cloudflareTempEmailAdminUrl: inputCloudflareTempEmailUrl.value.trim(),
    hotmailApiBaseUrl: inputHotmailApiUrl.value.trim(),
    hotmailEmail: inputHotmailEmail.value.trim(),
    hotmailPassword: inputHotmailPassword.value,
    hotmailAccessMethod: getHotmailAccessMethod(),
    hotmailClientId: inputHotmailClientId.value.trim(),
    hotmailRefreshToken: inputHotmailRefreshToken.value,
    hotmailBatchRaw: inputHotmailBatch?.value || '',
    inbucketHost: inputInbucketHost.value.trim(),
    inbucketMailbox: inputInbucketMailbox.value.trim(),
  };

  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: settingsPayload,
  });

  await chrome.runtime.sendMessage({
    type: 'SAVE_EMAIL',
    source: 'sidepanel',
    payload: { email: getDisplayedEmailValue() },
  });
}

async function fetchSelectedEmail() {
  const defaultLabel = btnFetchEmail.textContent;
  const provider = getSelectedEmailProvider();
  await persistFormState();
  btnFetchEmail.disabled = true;
  btnFetchEmail.textContent = '...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'FETCH_PROVIDER_EMAIL',
      source: 'sidepanel',
      payload: { provider, generateNew: provider !== EMAIL_PROVIDER_HOTMAIL },
    });

    if (response?.error) {
      throw new Error(response.error);
    }
    if (!response?.email) {
      throw new Error('Provider email was not returned.');
    }

    if (provider === EMAIL_PROVIDER_HOTMAIL) {
      inputHotmailEmail.value = response.email;
      syncHotmailEmailBinding();
    } else {
      inputEmail.value = response.email;
    }

    showToast(`${provider === EMAIL_PROVIDER_HOTMAIL ? 'Hotmail ready' : 'Fetched'} ${response.email}`, 'success', 2500);
    if (provider === EMAIL_PROVIDER_HOTMAIL) {
      await refreshHotmailServiceStatus({ silent: true });
    }
    return response.email;
  } catch (err) {
    showToast(`${provider === EMAIL_PROVIDER_HOTMAIL ? 'Hotmail check failed' : 'Auto fetch failed'}: ${err.message}`, 'error');
    throw err;
  } finally {
    btnFetchEmail.disabled = false;
    btnFetchEmail.textContent = defaultLabel;
  }
}

function syncPasswordToggleLabel() {
  btnTogglePassword.textContent = inputPassword.type === 'password' ? 'Show' : 'Hide';
}

function syncCpaKeyToggleLabel() {
  if (!btnToggleCpaKey || !inputCpaKey) return;
  btnToggleCpaKey.textContent = inputCpaKey.type === 'password' ? 'Show' : 'Hide';
}

// ============================================================
// Button Handlers
// ============================================================

document.querySelectorAll('.step-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    await persistFormState();
    const step = Number(btn.dataset.step);
    if (step === 3) {
      const provider = getSelectedEmailProvider();
      const email = getDisplayedEmailValue();
      if (provider === EMAIL_PROVIDER_DUCK && !email) {
        showToast('Please paste email address or use Auto first', 'warn');
        return;
      }
      if (provider === EMAIL_PROVIDER_HOTMAIL && !email) {
        showToast('Please configure Hotmail Email first', 'warn');
        return;
      }
      const payload = provider === EMAIL_PROVIDER_DUCK ? { step, email } : { step };
      await chrome.runtime.sendMessage({ type: 'EXECUTE_STEP', source: 'sidepanel', payload });
    } else {
      await chrome.runtime.sendMessage({ type: 'EXECUTE_STEP', source: 'sidepanel', payload: { step } });
    }
  });
});

btnFetchEmail.addEventListener('click', async () => {
  await fetchSelectedEmail().catch(() => {});
});

btnCopyHotmailStart.addEventListener('click', async () => {
  const command = getHotmailStartCommand();
  try {
    await navigator.clipboard.writeText(command);
    showToast('Hotmail start command copied to clipboard', 'success', 2500);
  } catch (err) {
    showToast(`Copy failed: ${err.message}`, 'error');
  }
});

btnTogglePassword.addEventListener('click', () => {
  inputPassword.type = inputPassword.type === 'password' ? 'text' : 'password';
  syncPasswordToggleLabel();
});

btnImportHotmailDb.addEventListener('click', async () => {
  try {
    await importHotmailBatchToDb();
  } catch (err) {
    showToast(`Import failed: ${toRestartHint(err.message)}`, 'error');
  }
});

btnRefreshHotmailDb.addEventListener('click', async () => {
  try {
    await refreshHotmailDbSummary();
    showToast('DB summary refreshed', 'success', 2000);
  } catch (err) {
    showToast(`Refresh failed: ${toRestartHint(err.message)}`, 'error');
  }
});

btnOpenHotmailDbUi.addEventListener('click', async () => {
  try {
    await openHotmailDbUi();
  } catch (err) {
    showToast(`Open DB UI failed: ${toRestartHint(err.message)}`, 'error');
  }
});

btnToggleCpaKey.addEventListener('click', () => {
  inputCpaKey.type = inputCpaKey.type === 'password' ? 'text' : 'password';
  syncCpaKeyToggleLabel();
});

btnSaveCpa.addEventListener('click', async () => {
  try {
    await saveCpaPersistentSettings();
    showToast('CPA settings saved locally', 'success', 2000);
  } catch (err) {
    showToast(`Save CPA failed: ${err.message}`, 'error');
  }
});

btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  await chrome.runtime.sendMessage({ type: 'STOP_FLOW', source: 'sidepanel', payload: {} });
  showToast('Stopping current flow...', 'warn', 2000);
});

// Auto Run
btnAutoRun.addEventListener('click', async () => {
  await persistFormState();
  const totalRuns = parseInt(inputRunCount.value) || 1;
  btnAutoRun.disabled = true;
  inputRunCount.disabled = true;
  btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> Running...';
  await chrome.runtime.sendMessage({ type: 'AUTO_RUN', source: 'sidepanel', payload: { totalRuns } });
});

btnAutoContinue.addEventListener('click', async () => {
  await persistFormState();
  const provider = getSelectedEmailProvider();
  let email = getDisplayedEmailValue();
  if ((provider === EMAIL_PROVIDER_2925 || provider === EMAIL_PROVIDER_HOTMAIL) && !email) {
    email = await fetchSelectedEmail().catch(() => '');
  }
  if (!email) {
    showToast(`Please fetch or paste ${getEmailProviderName(provider)} email first!`, 'warn');
    return;
  }
  autoContinueBar.style.display = 'none';
  await chrome.runtime.sendMessage({ type: 'RESUME_AUTO_RUN', source: 'sidepanel', payload: { email } });
});

// Reset
btnReset.addEventListener('click', async () => {
  if (confirm('Reset all steps and data?')) {
    await chrome.runtime.sendMessage({ type: 'RESET', source: 'sidepanel' });
    displayOauthUrl.textContent = 'Waiting...';
    displayOauthUrl.classList.remove('has-value');
    displayLocalhostUrl.textContent = 'Waiting...';
    displayLocalhostUrl.classList.remove('has-value');
    inputEmail.value = '';
    displayStatus.textContent = 'Ready';
    statusBar.className = 'status-bar';
    logArea.innerHTML = '';
    document.querySelectorAll('.step-row').forEach(row => row.className = 'step-row');
    document.querySelectorAll('.step-status').forEach(el => el.textContent = '');
    btnAutoRun.disabled = false;
    inputRunCount.disabled = false;
    btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Auto';
    autoContinueBar.style.display = 'none';
    updateStopButtonState(false);
    updateButtonStates();
    updateProgressCounter();
    updateMailProviderUI();
    updateAutoContinueHint();
  }
});

// Clear log
btnClearLog.addEventListener('click', () => {
  logArea.innerHTML = '';
});

// Save settings on change
inputEmail.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({ type: 'SAVE_EMAIL', source: 'sidepanel', payload: { email: getDisplayedEmailValue() } });
});

inputVpsUrl.addEventListener('change', persistFormState);
inputCpaKey.addEventListener('change', persistFormState);
inputPassword.addEventListener('change', persistFormState);
inputCloudflareTempEmailUrl.addEventListener('change', async () => {
  updateAutoContinueHint();
  await persistFormState();
});
inputHotmailApiUrl.addEventListener('change', async () => {
  inputHotmailApiUrl.value = normalizeHotmailApiBaseUrl(inputHotmailApiUrl.value.trim());
  updateAutoContinueHint();
  await persistFormState();
  await refreshHotmailServiceStatus({ silent: true });
});
inputHotmailEmail.addEventListener('change', async () => {
  syncHotmailEmailBinding();
  await persistFormState();
});
inputHotmailPassword.addEventListener('change', persistFormState);
selectHotmailAccessMethod.addEventListener('change', async () => {
  updateAutoContinueHint();
  await persistFormState();
  await refreshHotmailServiceStatus({ silent: true });
});
inputHotmailClientId.addEventListener('change', persistFormState);
inputHotmailRefreshToken.addEventListener('change', persistFormState);
inputHotmailBatch.addEventListener('change', async () => {
  updateHotmailBatchCount();
  await persistFormState();
});
inputInbucketMailbox.addEventListener('change', persistFormState);
inputInbucketHost.addEventListener('change', persistFormState);

selectMailProvider.addEventListener('change', async () => {
  syncMailProviderForSelectedSource();
  updateMailProviderUI();
  updateAutoContinueHint();
  await persistFormState();
});

selectEmailProvider.addEventListener('change', async () => {
  syncMailProviderForSelectedSource();
  updateMailProviderUI();
  updateAutoContinueHint();
  await persistFormState();
});

// ============================================================
// Listen for Background broadcasts
// ============================================================

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'LOG_ENTRY':
      appendLog(message.payload);
      if (message.payload.level === 'error') {
        showToast(message.payload.message, 'error');
      }
      break;

    case 'STEP_STATUS_CHANGED': {
      const { step, status } = message.payload;
      updateStepUI(step, status);
      chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' }).then(updateStatusDisplay);
      if (status === 'completed') {
        chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' }).then(state => {
          syncPasswordField(state);
          if (state.oauthUrl) {
            displayOauthUrl.textContent = state.oauthUrl;
            displayOauthUrl.classList.add('has-value');
          }
          if (state.localhostUrl) {
            displayLocalhostUrl.textContent = state.localhostUrl;
            displayLocalhostUrl.classList.add('has-value');
          }
        });
      }
      break;
    }

    case 'AUTO_RUN_RESET': {
      // Full UI reset for next run
      displayOauthUrl.textContent = 'Waiting...';
      displayOauthUrl.classList.remove('has-value');
      displayLocalhostUrl.textContent = 'Waiting...';
      displayLocalhostUrl.classList.remove('has-value');
      inputEmail.value = '';
      displayStatus.textContent = 'Ready';
      statusBar.className = 'status-bar';
      logArea.innerHTML = '';
      document.querySelectorAll('.step-row').forEach(row => row.className = 'step-row');
      document.querySelectorAll('.step-status').forEach(el => el.textContent = '');
      updateStopButtonState(false);
      updateProgressCounter();
      updateMailProviderUI();
      updateAutoContinueHint();
      break;
    }

    case 'DATA_UPDATED': {
      if (message.payload.email !== undefined) {
        inputEmail.value = message.payload.email || '';
      }
      if (message.payload.hotmailEmail !== undefined) {
        inputHotmailEmail.value = message.payload.hotmailEmail || '';
      }
      if (message.payload.hotmailPassword !== undefined) {
        inputHotmailPassword.value = message.payload.hotmailPassword || '';
      }
      if (message.payload.hotmailAccessMethod !== undefined) {
        selectHotmailAccessMethod.value = message.payload.hotmailAccessMethod || 'auto';
      }
      if (message.payload.hotmailClientId !== undefined) {
        inputHotmailClientId.value = message.payload.hotmailClientId || '';
      }
      if (message.payload.hotmailRefreshToken !== undefined) {
        inputHotmailRefreshToken.value = message.payload.hotmailRefreshToken || '';
      }
      if (message.payload.hotmailBatchRaw !== undefined) {
        inputHotmailBatch.value = message.payload.hotmailBatchRaw || '';
      }
      if (message.payload.hotmailDbSummary !== undefined) {
        setHotmailDbSummary(message.payload.hotmailDbSummary || null);
      }
      if (message.payload.currentHotmailDbEmail !== undefined) {
        setCurrentHotmailDbAccount(message.payload.currentHotmailDbEmail || '');
      }
      if (message.payload.currentHotmailDbEmail === '') {
        inputHotmailEmail.value = '';
        inputHotmailPassword.value = '';
        inputHotmailClientId.value = '';
        inputHotmailRefreshToken.value = '';
        syncHotmailEmailBinding();
      }
      if (message.payload.hotmailApiBaseUrl !== undefined) {
        inputHotmailApiUrl.value = message.payload.hotmailApiBaseUrl || '';
      }
      if (message.payload.password !== undefined) {
        inputPassword.value = message.payload.password || '';
      }
      if (message.payload.emailProvider) {
        selectEmailProvider.value = normalizeEmailProvider(message.payload.emailProvider);
      }
      if (message.payload.mailProvider) {
        selectMailProvider.value = message.payload.mailProvider;
      }
      if (message.payload.oauthUrl) {
        displayOauthUrl.textContent = message.payload.oauthUrl;
        displayOauthUrl.classList.add('has-value');
      }
      if (message.payload.localhostUrl) {
        displayLocalhostUrl.textContent = message.payload.localhostUrl;
        displayLocalhostUrl.classList.add('has-value');
      }
      if (message.payload.hotmailDbSummary === undefined) {
        updateHotmailBatchCount();
      }
      updateMailProviderUI();
      updateAutoContinueHint();
      break;
    }

    case 'AUTO_RUN_STATUS': {
      const { phase, currentRun, totalRuns } = message.payload;
      const runLabel = totalRuns > 1 ? ` (${currentRun}/${totalRuns})` : '';
      switch (phase) {
        case 'waiting_email':
          autoContinueBar.style.display = 'flex';
          btnAutoRun.innerHTML = `Paused${runLabel}`;
          updateStopButtonState(true);
          break;
        case 'running':
          btnAutoRun.innerHTML = `Running${runLabel}`;
          updateStopButtonState(true);
          break;
        case 'complete':
          btnAutoRun.disabled = false;
          inputRunCount.disabled = false;
          btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Auto';
          autoContinueBar.style.display = 'none';
          updateStopButtonState(false);
          break;
        case 'stopped':
          btnAutoRun.disabled = false;
          inputRunCount.disabled = false;
          btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Auto';
          autoContinueBar.style.display = 'none';
          updateStopButtonState(false);
          break;
      }
      break;
    }
  }
});

// ============================================================
// Theme Toggle
// ============================================================

const btnTheme = document.getElementById('btn-theme');

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('multipage-theme', theme);
}

function initTheme() {
  const saved = localStorage.getItem('multipage-theme');
  if (saved) {
    setTheme(saved);
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    setTheme('dark');
  }
}

btnTheme.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
});

// ============================================================
// Init
// ============================================================

initTheme();
restoreState().then(() => {
  syncPasswordToggleLabel();
  syncCpaKeyToggleLabel();
  updateButtonStates();
});
