// background.js — Service Worker: orchestration, state, tab management, message routing

importScripts(
  'data/names.js',
  'shared/oauth-flow.js',
  'shared/email-provider.js',
  'shared/verification-flow.js',
  'shared/mail-2925.js',
  'shared/dynamic-injection.js'
);

const LOG_PREFIX = '[MultiPage:bg]';
const DUCK_AUTOFILL_URL = 'https://duckduckgo.com/email/settings/autofill';
const RELAY_FIREFOX_PROFILE_URL = 'https://relay.firefox.com/accounts/profile/';
const CLOUDFLARE_TEMP_EMAIL_INJECT_FILES = [
  'content/utils.js',
  'shared/cloudflare-temp-email.js',
  'content/cloudflare-temp-email.js',
];
const VPS_PANEL_INJECT_FILES = [
  'content/utils.js',
  'content/vps-panel.js',
];
const MAIL_2925_INJECT_FILES = [
  'content/utils.js',
  'shared/mail-2925.js',
  'content/2925-mail.js',
];
const STOP_ERROR_MESSAGE = 'Flow stopped by user.';
const RUN_TIMEOUT_ERROR_MESSAGE = 'Registration exceeded time limit.';
const HUMAN_STEP_DELAY_MIN = 700;
const HUMAN_STEP_DELAY_MAX = 2200;
const MAX_REGISTRATION_DURATION_MS = 150000;
const ERROR_PAGE_TIMEOUT_BONUS_MS = 20000;
const HOTMAIL_HEALTH_CACHE_TTL_MS = 10000;
const DEFAULT_STEP_COMPLETION_TIMEOUT_MS = 120000;
const STEP4_COMPLETION_TIMEOUT_MS = 420000;
const STEP7_COMPLETION_TIMEOUT_MS = 240000;
const MAX_ERROR_PAGE_RETRIES_PER_STEP = 2;
const STEP7_ERROR_PAGE_RECOVERY_ABORT_MESSAGE = 'Step 7 OpenAI error page recovery triggered.';

const {
  DEFAULT_CLOUDFLARE_TEMP_EMAIL_ADMIN_URL = 'https://mail.cloudflare.com/admin',
  DEFAULT_HOTMAIL_API_BASE_URL = 'http://127.0.0.1:8001',
  EMAIL_PROVIDER_2925 = 'mail_2925',
  EMAIL_PROVIDER_CLOUDFLARE_TEMP_EMAIL = 'cloudflare_temp_email',
  EMAIL_PROVIDER_DUCK = 'duckduckgo',
  EMAIL_PROVIDER_HOTMAIL = 'hotmail',
  EMAIL_PROVIDER_RELAY_FIREFOX = 'relay_firefox',
  MAIL_PROVIDER_2925 = '2925',
  MAIL_PROVIDER_HOTMAIL = 'hotmail',
  getEmailProviderDisplayName = (value) => value === 'mail_2925'
    ? '2925邮箱'
    : value === 'relay_firefox'
      ? 'Firefox Relay'
      : value === 'cloudflare_temp_email'
        ? 'Cloudflare Temp Email'
        : value === 'hotmail'
          ? 'Hotmail'
          : 'DuckDuckGo',
  is2925EmailProvider = (value) => value === 'mail_2925',
  isCloudflareTempEmailProvider = (value) => value === 'cloudflare_temp_email',
  isHotmailEmailProvider = (value) => value === 'hotmail',
  isRelayFirefoxProvider = (value) => value === 'relay_firefox',
  normalizeCloudflareTempEmailAdminUrl = (value) => value || DEFAULT_CLOUDFLARE_TEMP_EMAIL_ADMIN_URL,
  normalizeHotmailApiBaseUrl = (value) => value || DEFAULT_HOTMAIL_API_BASE_URL,
  normalizeEmailProvider = (value) => {
    if (value === 'mail_2925') return 'mail_2925';
    if (value === 'relay_firefox') return 'relay_firefox';
    if (value === 'cloudflare_temp_email') return 'cloudflare_temp_email';
    if (value === 'hotmail') return 'hotmail';
    return 'duckduckgo';
  },
  shouldUseEmailSourceForVerification = (value) => value === 'cloudflare_temp_email' || value === 'mail_2925' || value === 'hotmail',
  shouldSkipStep9Cleanup = (value) => value !== 'relay_firefox',
} = globalThis.MultiPageEmailProvider || {};
const {
  shouldRetryStep4VerificationWithResend = () => false,
} = globalThis.MultiPageVerificationFlow || {};
const {
  shouldSkipDynamicInjection = () => false,
} = globalThis.MultiPageDynamicInjection || {};
const {
  build2925ChildEmail = () => null,
  is2925ChildEmailForMain = () => false,
  parse2925MainEmail = () => null,
} = globalThis.MultiPage2925Mail || {};

initializeSessionStorageAccess();

// ============================================================
// State Management (chrome.storage.session)
// ============================================================

const DEFAULT_STATE = {
  currentStep: 0,
  stepStatuses: {
    1: 'pending', 2: 'pending', 3: 'pending', 4: 'pending', 5: 'pending',
    6: 'pending', 7: 'pending', 8: 'pending', 9: 'pending',
  },
  oauthUrl: null,
  oauthState: null,
  email: null,
  password: null,
  accounts: [], // { email, password, emailProvider, createdAt }
  lastEmailTimestamp: null,
  lastVerificationCode: null,
  localhostUrl: null,
  flowStartTime: null,
  tabRegistry: {},
  logs: [],
  cpaBaseUrl: '',
  cpaManagementKey: '',
  customPassword: '',
  emailProvider: EMAIL_PROVIDER_2925,
  mailProvider: MAIL_PROVIDER_2925, // 'qq', '163', 'inbucket', '2925', or 'hotmail'
  mail2925MainEmail: '',
  cloudflareTempEmailAdminUrl: '',
  hotmailApiBaseUrl: DEFAULT_HOTMAIL_API_BASE_URL,
  hotmailEmail: '',
  hotmailPassword: '',
  hotmailAccessMethod: 'auto',
  hotmailClientId: '',
  hotmailRefreshToken: '',
  hotmailBatchRaw: '',
  hotmailDbSummary: { total: 0, pending: 0, claimed: 0, success: 0, failed: 0 },
  currentHotmailDbEmail: '',
  errorPageRetryCounts: {},
  inbucketHost: '',
  inbucketMailbox: '',
  activeCloudflareMailbox: null,
  activeRelayMask: null,
};

const HOTMAIL_PERSISTENT_KEYS = [
  'hotmailApiBaseUrl',
  'hotmailEmail',
  'hotmailPassword',
  'hotmailAccessMethod',
  'hotmailClientId',
  'hotmailRefreshToken',
  'hotmailBatchRaw',
];
const CPA_PERSISTENT_KEYS = ['cpaBaseUrl', 'cpaManagementKey'];

async function getPersistentCpaSettings() {
  try {
    const data = await chrome.storage.local.get(CPA_PERSISTENT_KEYS);
    return {
      cpaBaseUrl: normalizeCpaBaseUrl(data.cpaBaseUrl || ''),
      cpaManagementKey: data.cpaManagementKey || '',
    };
  } catch (err) {
    console.warn(LOG_PREFIX, 'Failed to read persistent CPA settings:', err?.message || err);
    return { cpaBaseUrl: '', cpaManagementKey: '' };
  }
}

async function setPersistentCpaSettings(updates = {}) {
  const payload = {};
  if (updates.cpaBaseUrl !== undefined) {
    payload.cpaBaseUrl = normalizeCpaBaseUrl(updates.cpaBaseUrl || '');
  }
  if (updates.cpaManagementKey !== undefined) {
    payload.cpaManagementKey = updates.cpaManagementKey || '';
  }
  if (Object.keys(payload).length) {
    await chrome.storage.local.set(payload);
  }
}

async function getPersistentHotmailSettings() {
  try {
    const data = await chrome.storage.local.get(HOTMAIL_PERSISTENT_KEYS);
    return {
      hotmailApiBaseUrl: normalizeHotmailApiBaseUrl(data.hotmailApiBaseUrl || DEFAULT_HOTMAIL_API_BASE_URL),
      hotmailEmail: String(data.hotmailEmail || '').trim(),
      hotmailPassword: data.hotmailPassword || '',
      hotmailAccessMethod: String(data.hotmailAccessMethod || 'auto').trim() || 'auto',
      hotmailClientId: String(data.hotmailClientId || '').trim(),
      hotmailRefreshToken: data.hotmailRefreshToken || '',
      hotmailBatchRaw: data.hotmailBatchRaw || '',
    };
  } catch (err) {
    console.warn(LOG_PREFIX, 'Failed to read persistent Hotmail settings:', err?.message || err);
    return {
      hotmailApiBaseUrl: DEFAULT_HOTMAIL_API_BASE_URL,
      hotmailEmail: '',
      hotmailPassword: '',
      hotmailAccessMethod: 'auto',
      hotmailClientId: '',
      hotmailRefreshToken: '',
      hotmailBatchRaw: '',
    };
  }
}

async function setPersistentHotmailSettings(updates = {}) {
  const payload = {};
  if (updates.hotmailApiBaseUrl !== undefined) {
    payload.hotmailApiBaseUrl = normalizeHotmailApiBaseUrl(updates.hotmailApiBaseUrl);
  }
  if (updates.hotmailEmail !== undefined) {
    payload.hotmailEmail = String(updates.hotmailEmail || '').trim();
  }
  if (updates.hotmailPassword !== undefined) {
    payload.hotmailPassword = updates.hotmailPassword || '';
  }
  if (updates.hotmailAccessMethod !== undefined) {
    payload.hotmailAccessMethod = String(updates.hotmailAccessMethod || 'auto').trim() || 'auto';
  }
  if (updates.hotmailClientId !== undefined) {
    payload.hotmailClientId = String(updates.hotmailClientId || '').trim();
  }
  if (updates.hotmailRefreshToken !== undefined) {
    payload.hotmailRefreshToken = updates.hotmailRefreshToken || '';
  }
  if (updates.hotmailBatchRaw !== undefined) {
    payload.hotmailBatchRaw = updates.hotmailBatchRaw || '';
  }

  if (Object.keys(payload).length) {
    await chrome.storage.local.set(payload);
  }
}

async function getState() {
  const state = await chrome.storage.session.get(null);
  const persistentCpa = await getPersistentCpaSettings();
  const persistentHotmail = await getPersistentHotmailSettings();
  return {
    ...DEFAULT_STATE,
    ...state,
    ...persistentCpa,
    ...persistentHotmail,
    cpaBaseUrl: normalizeCpaBaseUrl(persistentCpa.cpaBaseUrl || state.cpaBaseUrl || ''),
    cpaManagementKey: persistentCpa.cpaManagementKey || state.cpaManagementKey || '',
    hotmailApiBaseUrl: normalizeHotmailApiBaseUrl(
      persistentHotmail.hotmailApiBaseUrl || state.hotmailApiBaseUrl || DEFAULT_STATE.hotmailApiBaseUrl
    ),
    hotmailEmail: String(persistentHotmail.hotmailEmail || state.hotmailEmail || '').trim(),
    hotmailPassword: persistentHotmail.hotmailPassword || state.hotmailPassword || '',
    hotmailAccessMethod: String(persistentHotmail.hotmailAccessMethod || state.hotmailAccessMethod || 'auto').trim() || 'auto',
    hotmailClientId: String(persistentHotmail.hotmailClientId || state.hotmailClientId || '').trim(),
    hotmailRefreshToken: persistentHotmail.hotmailRefreshToken || state.hotmailRefreshToken || '',
    hotmailBatchRaw: persistentHotmail.hotmailBatchRaw || state.hotmailBatchRaw || '',
  };
}

function parseHotmailBatchRaw(rawValue = '') {
  return String(rawValue || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const parts = line.split('----');
      if (parts.length < 4) {
        return null;
      }
      const email = String(parts[0] || '').trim();
      const password = String(parts[1] || '').trim();
      const clientId = String(parts[2] || '').trim();
      const refreshToken = parts.slice(3).join('----').trim();
      if (!email) return null;
      return {
        index,
        raw: line,
        email,
        password,
        clientId,
        refreshToken,
      };
    })
    .filter(Boolean);
}

async function initializeSessionStorageAccess() {
  try {
    if (chrome.storage?.session?.setAccessLevel) {
      await chrome.storage.session.setAccessLevel({
        accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
      });
      console.log(LOG_PREFIX, 'Enabled storage.session for content scripts');
    }
  } catch (err) {
    console.warn(LOG_PREFIX, 'Failed to enable storage.session for content scripts:', err?.message || err);
  }
}

async function setState(updates) {
  console.log(LOG_PREFIX, 'storage.set:', JSON.stringify(updates).slice(0, 200));
  await chrome.storage.session.set(updates);
}

function broadcastDataUpdate(payload) {
  chrome.runtime.sendMessage({
    type: 'DATA_UPDATED',
    payload,
  }).catch(() => {});
}

async function setEmailState(email) {
  await setState({ email });
  broadcastDataUpdate({ email });
}

async function set2925MainEmailState(mail2925MainEmail) {
  const value = String(mail2925MainEmail || '').trim();
  await setState({ mail2925MainEmail: value });
  broadcastDataUpdate({ mail2925MainEmail: value });
}

async function setEmailProviderState(emailProvider) {
  const nextProvider = normalizeEmailProvider(emailProvider);
  await setState({ emailProvider: nextProvider });
  broadcastDataUpdate({ emailProvider: nextProvider });
}

async function setPasswordState(password) {
  await setState({ password });
  broadcastDataUpdate({ password });
}

async function setHotmailApiBaseUrlState(hotmailApiBaseUrl, options = {}) {
  const { persist = true } = options;
  const value = normalizeHotmailApiBaseUrl(hotmailApiBaseUrl || DEFAULT_HOTMAIL_API_BASE_URL);
  await setState({ hotmailApiBaseUrl: value });
  if (persist) {
    await setPersistentHotmailSettings({ hotmailApiBaseUrl: value });
  }
  broadcastDataUpdate({ hotmailApiBaseUrl: value });
}

async function setHotmailEmailState(hotmailEmail, options = {}) {
  const { persist = true, syncSignupEmail = true } = options;
  const value = String(hotmailEmail || '').trim();
  await setState({ hotmailEmail: value });
  if (persist) {
    await setPersistentHotmailSettings({ hotmailEmail: value });
  }
  broadcastDataUpdate({ hotmailEmail: value });

  if (syncSignupEmail) {
    const state = await getState();
    if (normalizeEmailProvider(state.emailProvider) === EMAIL_PROVIDER_HOTMAIL) {
      await setEmailState(value || null);
    }
  }
}

async function setHotmailPasswordState(hotmailPassword, options = {}) {
  const { persist = true } = options;
  const value = hotmailPassword || '';
  await setState({ hotmailPassword: value });
  if (persist) {
    await setPersistentHotmailSettings({ hotmailPassword: value });
  }
  broadcastDataUpdate({ hotmailPassword: value });
}

function normalizeCpaBaseUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const parsed = new URL(candidate);
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return raw;
  }
}

function getCpaHeaders(state = {}) {
  const key = String(state.cpaManagementKey || '').trim();
  if (!key) {
    throw new Error('CPA management key is empty. Fill CPA Key in the side panel first.');
  }
  return {
    'Authorization': `Bearer ${key}`,
    'X-Management-Key': key,
  };
}

async function callCpaApi(path, options = {}) {
  const state = await getState();
  const baseUrl = normalizeCpaBaseUrl(state.cpaBaseUrl);
  if (!baseUrl) {
    throw new Error('CPA address is empty. Fill CPA in the side panel first.');
  }
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 15000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: options.method || (options.body ? 'POST' : 'GET'),
      headers: {
        ...getCpaHeaders(state),
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = {};
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    }
    if (!response.ok) {
      throw new Error(payload.error || payload.detail || payload.raw || response.statusText);
    }
    return payload;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`CPA API request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new Error(`CPA API request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function setHotmailAccessMethodState(hotmailAccessMethod, options = {}) {
  const { persist = true } = options;
  const value = String(hotmailAccessMethod || 'auto').trim() || 'auto';
  await setState({ hotmailAccessMethod: value });
  if (persist) {
    await setPersistentHotmailSettings({ hotmailAccessMethod: value });
  }
  broadcastDataUpdate({ hotmailAccessMethod: value });
}

async function setHotmailClientIdState(hotmailClientId, options = {}) {
  const { persist = true } = options;
  const value = String(hotmailClientId || '').trim();
  await setState({ hotmailClientId: value });
  if (persist) {
    await setPersistentHotmailSettings({ hotmailClientId: value });
  }
  broadcastDataUpdate({ hotmailClientId: value });
}

async function setHotmailRefreshTokenState(hotmailRefreshToken, options = {}) {
  const { persist = true } = options;
  const value = hotmailRefreshToken || '';
  await setState({ hotmailRefreshToken: value });
  if (persist) {
    await setPersistentHotmailSettings({ hotmailRefreshToken: value });
  }
  broadcastDataUpdate({ hotmailRefreshToken: value });
}

async function setHotmailBatchRawState(hotmailBatchRaw, options = {}) {
  const { persist = true } = options;
  const value = hotmailBatchRaw || '';
  await setState({
    hotmailBatchRaw: value,
  });
  if (persist) {
    await setPersistentHotmailSettings({ hotmailBatchRaw: value });
  }
  broadcastDataUpdate({
    hotmailBatchRaw: value,
    hotmailBatchCount: parseHotmailBatchRaw(value).length,
  });
}

async function applyHotmailBatchAccount(entry) {
  if (!entry?.email) {
    return null;
  }

  const nextAccessMethod = entry.clientId && entry.refreshToken ? 'graph' : 'playwright';
  const nextState = {
    hotmailEmail: entry.email,
    hotmailPassword: entry.password || '',
    hotmailClientId: entry.clientId || '',
    hotmailRefreshToken: entry.refreshToken || '',
    hotmailAccessMethod: nextAccessMethod,
    currentHotmailDbEmail: entry.email,
  };
  await setState(nextState);
  broadcastDataUpdate(nextState);
  await setEmailState(entry.email);
  return entry;
}

async function fetchHotmailDbSummary() {
  const summary = await callHotmailApi('/accounts/summary', null, { timeoutMs: 10000, method: 'GET' });
  const normalized = {
    total: Number(summary?.total || 0),
    pending: Number(summary?.pending || 0),
    claimed: Number(summary?.claimed || 0),
    success: Number(summary?.success || 0),
    failed: Number(summary?.failed || 0),
  };
  await setState({ hotmailDbSummary: normalized });
  broadcastDataUpdate({ hotmailDbSummary: normalized });
  return normalized;
}

async function syncHotmailBatchToDbIfNeeded(state = null) {
  const currentState = state || await getState();
  const raw = String(currentState.hotmailBatchRaw || '').trim();
  if (!raw) {
    return currentState.hotmailDbSummary || { total: 0, pending: 0, claimed: 0, success: 0, failed: 0 };
  }
  const imported = await callHotmailApi('/accounts/import', { raw_text: raw }, { timeoutMs: 20000, method: 'POST' });
  const normalized = {
    total: Number(imported?.total || 0),
    pending: Number(imported?.pending || 0),
    claimed: Number(imported?.claimed || 0),
    success: Number(imported?.success || 0),
    failed: Number(imported?.failed || 0),
  };
  await setState({ hotmailDbSummary: normalized });
  broadcastDataUpdate({ hotmailDbSummary: normalized });
  return normalized;
}

async function claimNextHotmailDbAccount(state = null) {
  const currentState = state || await getState();
  await syncHotmailBatchToDbIfNeeded(currentState);
  if (!currentState.currentHotmailDbEmail) {
    const resetResult = await callHotmailApi('/accounts/reset-claimed', null, { timeoutMs: 15000, method: 'POST' }).catch(() => null);
    if (resetResult) {
      const resetSummary = {
        total: Number(resetResult?.total || 0),
        pending: Number(resetResult?.pending || 0),
        claimed: Number(resetResult?.claimed || 0),
        success: Number(resetResult?.success || 0),
        failed: Number(resetResult?.failed || 0),
      };
      await setState({ hotmailDbSummary: resetSummary });
      broadcastDataUpdate({ hotmailDbSummary: resetSummary });
    }
  }
  const result = await callHotmailApi('/accounts/claim-next', null, { timeoutMs: 15000, method: 'POST' });
  const summary = {
    total: Number(result?.total || 0),
    pending: Number(result?.pending || 0),
    claimed: Number(result?.claimed || 0),
    success: Number(result?.success || 0),
    failed: Number(result?.failed || 0),
  };
  await setState({ hotmailDbSummary: summary });
  broadcastDataUpdate({ hotmailDbSummary: summary });
  if (result?.status !== 'ok' || !result?.account) {
    return null;
  }
  return applyHotmailBatchAccount({
    email: result.account.email,
    password: result.account.password,
    clientId: result.account.client_id,
    refreshToken: result.account.refresh_token,
  });
}

async function markCurrentHotmailDbAccount(workflowStatus, options = {}) {
  const state = await getState();
  const email = state.currentHotmailDbEmail;
  if (!email) {
    return;
  }
  const result = await callHotmailApi('/accounts/mark', {
    email,
    workflow_status: workflowStatus,
    tag: options.tag || null,
    note: options.note || null,
    openai_password: options.openaiPassword || null,
  }, { timeoutMs: 15000, method: 'POST' }).catch(() => null);
  const summary = result ? {
    total: Number(result?.total || 0),
    pending: Number(result?.pending || 0),
    claimed: Number(result?.claimed || 0),
    success: Number(result?.success || 0),
    failed: Number(result?.failed || 0),
  } : state.hotmailDbSummary;
  await setState({ currentHotmailDbEmail: '', hotmailDbSummary: summary });
  broadcastDataUpdate({ hotmailDbSummary: summary, currentHotmailDbEmail: '' });
}

async function resetClaimedHotmailIfIdle(options = {}) {
  const { force = false, reason = '' } = options;
  const state = await getState();
  const hasRunningSteps = Object.values(state.stepStatuses || {}).some((status) => status === 'running');
  const useHotmail = normalizeEmailProvider(state.emailProvider) === EMAIL_PROVIDER_HOTMAIL
    || state.mailProvider === MAIL_PROVIDER_HOTMAIL
    || Number(state.hotmailDbSummary?.claimed || 0) > 0
    || Number(state.hotmailDbSummary?.pending || 0) > 0;

  if (!useHotmail) {
    return null;
  }
  if (!force && (state.autoRunning || hasRunningSteps || state.currentHotmailDbEmail)) {
    return null;
  }

  const result = await callHotmailApi('/accounts/reset-claimed', null, { timeoutMs: 15000, method: 'POST' }).catch(() => null);
  if (!result) {
    return null;
  }
  const summary = {
    total: Number(result?.total || 0),
    pending: Number(result?.pending || 0),
    claimed: Number(result?.claimed || 0),
    success: Number(result?.success || 0),
    failed: Number(result?.failed || 0),
  };
  await setState({ currentHotmailDbEmail: '', hotmailDbSummary: summary });
  broadcastDataUpdate({ currentHotmailDbEmail: '', hotmailDbSummary: summary });
  if (Number(result?.reset_claimed || 0) > 0 && reason) {
    await addLog(`Hotmail DB: reset ${result.reset_claimed} claimed account(s) because ${reason}.`, 'info');
  }
  return result;
}

async function setActiveRelayMaskState(activeRelayMask) {
  await setState({ activeRelayMask: activeRelayMask || null });
}

async function setActiveCloudflareMailboxState(activeCloudflareMailbox) {
  await setState({ activeCloudflareMailbox: activeCloudflareMailbox || null });
}

function getCloudflareTempEmailAdminUrl(state = {}) {
  return normalizeCloudflareTempEmailAdminUrl(state.cloudflareTempEmailAdminUrl || '');
}

function getHotmailApiBaseUrl(state = {}) {
  return normalizeHotmailApiBaseUrl(state.hotmailApiBaseUrl || DEFAULT_HOTMAIL_API_BASE_URL);
}

function getHotmailAccessMethod(state = {}) {
  return String(state.hotmailAccessMethod || 'auto').trim() || 'auto';
}

function hasHotmailOauthCredentials(state = {}) {
  return Boolean(String(state.hotmailClientId || '').trim() && String(state.hotmailRefreshToken || '').trim());
}

function hasHotmailBatchAccounts(state = {}) {
  return Boolean(
    parseHotmailBatchRaw(state.hotmailBatchRaw).length > 0
    || Number(state.hotmailDbSummary?.pending || 0) > 0
  );
}

function shouldUseHotmailDbMode(state = {}) {
  return normalizeEmailProvider(state.emailProvider) === EMAIL_PROVIDER_HOTMAIL
    && (
      Boolean(String(state.hotmailBatchRaw || '').trim())
      || Number(state.hotmailDbSummary?.pending || 0) > 0
      || Number(state.hotmailDbSummary?.claimed || 0) > 0
    );
}

async function resetState() {
  console.log(LOG_PREFIX, 'Resetting all state');
  // Preserve settings and persistent data across resets
  const prev = await chrome.storage.session.get([
    'seenCodes',
    'seenInbucketMailIds',
    'accounts',
    'tabRegistry',
    'cpaBaseUrl',
    'cpaManagementKey',
    'customPassword',
    'emailProvider',
    'mailProvider',
    'mail2925MainEmail',
    'cloudflareTempEmailAdminUrl',
    'hotmailApiBaseUrl',
    'hotmailEmail',
    'hotmailPassword',
    'hotmailAccessMethod',
    'hotmailClientId',
    'hotmailRefreshToken',
    'hotmailBatchRaw',
    'hotmailDbSummary',
    'currentHotmailDbEmail',
    'inbucketHost',
    'inbucketMailbox',
  ]);
  await chrome.storage.session.clear();
  await chrome.storage.session.set({
    ...DEFAULT_STATE,
    seenCodes: prev.seenCodes || [],
    seenInbucketMailIds: prev.seenInbucketMailIds || [],
    accounts: prev.accounts || [],
    tabRegistry: prev.tabRegistry || {},
    cpaBaseUrl: prev.cpaBaseUrl || DEFAULT_STATE.cpaBaseUrl,
    cpaManagementKey: prev.cpaManagementKey || DEFAULT_STATE.cpaManagementKey,
    customPassword: prev.customPassword || '',
    emailProvider: normalizeEmailProvider(prev.emailProvider || DEFAULT_STATE.emailProvider),
    mailProvider: prev.mailProvider || DEFAULT_STATE.mailProvider,
    mail2925MainEmail: prev.mail2925MainEmail || '',
    cloudflareTempEmailAdminUrl: prev.cloudflareTempEmailAdminUrl || DEFAULT_STATE.cloudflareTempEmailAdminUrl,
    hotmailApiBaseUrl: prev.hotmailApiBaseUrl || DEFAULT_STATE.hotmailApiBaseUrl,
    hotmailEmail: prev.hotmailEmail || '',
    hotmailPassword: prev.hotmailPassword || '',
    hotmailAccessMethod: prev.hotmailAccessMethod || 'auto',
    hotmailClientId: prev.hotmailClientId || '',
    hotmailRefreshToken: prev.hotmailRefreshToken || '',
    hotmailBatchRaw: prev.hotmailBatchRaw || '',
    hotmailDbSummary: prev.hotmailDbSummary || DEFAULT_STATE.hotmailDbSummary,
    currentHotmailDbEmail: prev.currentHotmailDbEmail || '',
    inbucketHost: prev.inbucketHost || '',
    inbucketMailbox: prev.inbucketMailbox || '',
  });
}

/**
 * Generate a random password: 14 chars, mix of uppercase, lowercase, digits, symbols.
 */
function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*?';
  const all = upper + lower + digits + symbols;

  // Ensure at least one of each type
  let pw = '';
  pw += upper[Math.floor(Math.random() * upper.length)];
  pw += lower[Math.floor(Math.random() * lower.length)];
  pw += digits[Math.floor(Math.random() * digits.length)];
  pw += symbols[Math.floor(Math.random() * symbols.length)];

  // Fill remaining 10 chars
  for (let i = 0; i < 10; i++) {
    pw += all[Math.floor(Math.random() * all.length)];
  }

  // Shuffle
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}

function deriveSignupPasswordFromEmailPassword(emailPassword = '') {
  const raw = String(emailPassword || '');
  if (!raw) return '';
  return raw.length >= 12 ? raw : `${raw}${raw}`;
}

// ============================================================
// Tab Registry
// ============================================================

async function getTabRegistry() {
  const state = await getState();
  return state.tabRegistry || {};
}

async function registerTab(source, tabId) {
  const registry = await getTabRegistry();
  registry[source] = { tabId, ready: true };
  await setState({ tabRegistry: registry });
  console.log(LOG_PREFIX, `Tab registered: ${source} -> ${tabId}`);
}

async function isTabAlive(source) {
  const registry = await getTabRegistry();
  const entry = registry[source];
  if (!entry) return false;
  try {
    await chrome.tabs.get(entry.tabId);
    return true;
  } catch {
    // Tab no longer exists — clean up registry
    registry[source] = null;
    await setState({ tabRegistry: registry });
    return false;
  }
}

async function getTabId(source) {
  const registry = await getTabRegistry();
  return registry[source]?.tabId || null;
}

// ============================================================
// Command Queue (for content scripts not yet ready)
// ============================================================

const pendingCommands = new Map(); // source -> { message, resolve, reject, timer }

function queueCommand(source, message, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(source);
      const err = `Content script on ${source} did not respond in ${timeout / 1000}s. Try refreshing the tab and retry.`;
      console.error(LOG_PREFIX, err);
      reject(new Error(err));
    }, timeout);
    pendingCommands.set(source, { message, resolve, reject, timer });
    console.log(LOG_PREFIX, `Command queued for ${source} (waiting for ready)`);
  });
}

function flushCommand(source, tabId) {
  const pending = pendingCommands.get(source);
  if (pending) {
    clearTimeout(pending.timer);
    pendingCommands.delete(source);
    chrome.tabs.sendMessage(tabId, pending.message).then(pending.resolve).catch(pending.reject);
    console.log(LOG_PREFIX, `Flushed queued command to ${source} (tab ${tabId})`);
  }
}

function cancelPendingCommands(reason = STOP_ERROR_MESSAGE) {
  for (const [source, pending] of pendingCommands.entries()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
    pendingCommands.delete(source);
    console.log(LOG_PREFIX, `Cancelled queued command for ${source}`);
  }
}

// ============================================================
// Reuse or create tab
// ============================================================

function isHashOnlyNavigation(fromUrl, toUrl) {
  try {
    const from = new URL(fromUrl || '');
    const to = new URL(toUrl || '');
    return from.origin === to.origin
      && from.pathname === to.pathname
      && from.search === to.search
      && from.hash !== to.hash;
  } catch {
    return false;
  }
}

async function setTabReadyState(source, ready) {
  const registry = await getTabRegistry();
  if (!registry[source]) {
    return;
  }

  registry[source].ready = ready;
  await setState({ tabRegistry: registry });
}

async function probeInjectedContentScript(tabId, expectedSource = '') {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'PING',
      source: 'background',
      payload: {},
    });
    if (!response?.ok) {
      return false;
    }
    if (expectedSource && response.source && response.source !== expectedSource) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function injectContentScripts(tabId, files, injectSource) {
  if (injectSource) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (injectedSource) => {
        window.__MULTIPAGE_SOURCE = injectedSource;
      },
      args: [injectSource],
    });
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files,
  });
}

async function ensureDynamicInjection(source, tabId, options = {}) {
  const {
    inject,
    injectSource,
    sameUrl = false,
    reloadIfSameUrl = false,
    hashOnlyNavigation = false,
  } = options;

  if (!inject?.length) {
    return false;
  }

  const contentScriptResponsive = await probeInjectedContentScript(tabId, injectSource);
  if (shouldSkipDynamicInjection({
    sameUrl,
    reloadIfSameUrl,
    hashOnlyNavigation,
    contentScriptResponsive,
  })) {
    await setTabReadyState(source, true);
    return false;
  }

  await setTabReadyState(source, false);
  await injectContentScripts(tabId, inject, injectSource);
  await new Promise((resolve) => setTimeout(resolve, 500));
  return true;
}

async function reuseOrCreateTab(source, url, options = {}) {
  const activate = options.activate !== false;
  const alive = await isTabAlive(source);
  if (alive) {
    const tabId = await getTabId(source);
    const currentTab = await chrome.tabs.get(tabId);
    const sameUrl = currentTab.url === url;
    const shouldReloadOnReuse = sameUrl && options.reloadIfSameUrl;
    if (sameUrl) {
      if (activate) {
        await chrome.tabs.update(tabId, { active: true });
      }
      console.log(LOG_PREFIX, `Reused tab ${source} (${tabId}) on same URL`);

      if (shouldReloadOnReuse) {
        await setTabReadyState(source, false);
        await chrome.tabs.reload(tabId);

        await new Promise((resolve) => {
          const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
          const listener = (tid, info) => {
            if (tid === tabId && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              clearTimeout(timer);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
        });
      }

      if (options.inject) {
        await ensureDynamicInjection(source, tabId, {
          inject: options.inject,
          injectSource: options.injectSource,
          sameUrl: true,
          reloadIfSameUrl: shouldReloadOnReuse,
        });
      }

      return tabId;
    }

    const hashOnlyNavigation = isHashOnlyNavigation(currentTab.url, url);
    if (!hashOnlyNavigation) {
      await setTabReadyState(source, false);
    }

    // Navigate existing tab to new URL
    await chrome.tabs.update(tabId, activate ? { url, active: true } : { url });
    console.log(LOG_PREFIX, `Reused tab ${source} (${tabId}), navigated to ${url.slice(0, 60)}`);

    if (hashOnlyNavigation) {
      // SPA hash-route switches often do not emit a full "complete" load state.
      await new Promise((resolve) => setTimeout(resolve, 900));
    } else {
      // Wait for page load complete (with 30s timeout)
      await new Promise((resolve) => {
        const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
        const listener = (tid, info) => {
          if (tid === tabId && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timer);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
    }

    if (options.inject) {
      await ensureDynamicInjection(source, tabId, {
        inject: options.inject,
        injectSource: options.injectSource,
        hashOnlyNavigation,
      });
      return tabId;
    }

    // Wait a bit for content script to inject and send READY
    await new Promise(r => setTimeout(r, 500));

    return tabId;
  }

  // Create new tab
  const tab = await chrome.tabs.create({ url, active: activate });
  console.log(LOG_PREFIX, `Created new tab ${source} (${tab.id})`);

  // If dynamic injection needed (VPS panel), inject scripts after load
  if (options.inject) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timer);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    await setTabReadyState(source, false);
    await injectContentScripts(tab.id, options.inject, options.injectSource);
  }

  return tab.id;
}

// ============================================================
// Send command to content script (with readiness check)
// ============================================================

async function sendToContentScript(source, message) {
  const registry = await getTabRegistry();
  const entry = registry[source];

  if (!entry || !entry.ready) {
    console.log(LOG_PREFIX, `${source} not ready, queuing command`);
    return queueCommand(source, message);
  }

  // Verify tab is still alive
  const alive = await isTabAlive(source);
  if (!alive) {
    // Tab was closed — queue the command, it will be sent when tab is reopened
    console.log(LOG_PREFIX, `${source} tab was closed, queuing command`);
    return queueCommand(source, message);
  }

  console.log(LOG_PREFIX, `Sending to ${source} (tab ${entry.tabId}):`, message.type);
  return chrome.tabs.sendMessage(entry.tabId, message);
}

// ============================================================
// Logging
// ============================================================

async function addLog(message, level = 'info') {
  const state = await getState();
  const logs = state.logs || [];
  const entry = { message, level, timestamp: Date.now() };
  logs.push(entry);
  // Keep last 500 logs
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  await setState({ logs });
  // Broadcast to side panel
  chrome.runtime.sendMessage({ type: 'LOG_ENTRY', payload: entry }).catch(() => {});
}

async function completeStepFromBackground(step, payload = {}, options = {}) {
  const { logMessage = null, logLevel = 'info' } = options;

  if (logMessage) {
    await addLog(logMessage, logLevel);
  }

  await clearErrorPageRetryCount(step);
  await setStepStatus(step, 'completed');
  await addLog(`Step ${step} completed`, 'ok');
  await handleStepData(step, payload);
  if (Number(step) === 9) {
    const state = await getState();
    if (normalizeEmailProvider(state.emailProvider) === EMAIL_PROVIDER_HOTMAIL) {
      await markCurrentHotmailDbAccount('success', {
        tag: 'registered',
        note: 'registration completed',
        openaiPassword: state.password || null,
      });
    }
  }
  notifyStepComplete(step, payload);
}

async function getSignupPageState() {
  const tabId = await getTabId('signup-page');
  if (!tabId) {
    return { url: '', hasVisibleContinueButton: false, hasVisibleRetryButton: false, isConsentPage: false, isErrorPage: false, isPhoneRequiredPage: false, isVerificationPage: false, isProfileSetupPage: false, errorMessage: '' };
  }

  const alive = await isTabAlive('signup-page');
  if (!alive) {
    return { url: '', hasVisibleContinueButton: false, hasVisibleRetryButton: false, isConsentPage: false, isErrorPage: false, isPhoneRequiredPage: false, isVerificationPage: false, isProfileSetupPage: false, errorMessage: '' };
  }

  const tab = await chrome.tabs.get(tabId);
  const currentUrl = tab?.url || '';
  if (MultiPageOAuthFlow.isConsentUrl(currentUrl)) {
    return { url: currentUrl, hasVisibleContinueButton: false, isConsentPage: true };
  }

  try {
    const pageState = await sendToContentScript('signup-page', {
      type: 'GET_PAGE_STATE',
      source: 'background',
      payload: {},
    });

    return {
      url: pageState?.url || currentUrl,
      hasVisibleContinueButton: Boolean(pageState?.hasVisibleContinueButton),
      hasVisibleRetryButton: Boolean(pageState?.hasVisibleRetryButton),
      isConsentPage: Boolean(pageState?.isConsentPage),
      isErrorPage: Boolean(pageState?.isErrorPage),
      isPhoneRequiredPage: Boolean(pageState?.isPhoneRequiredPage),
      isVerificationPage: Boolean(pageState?.isVerificationPage),
      isProfileSetupPage: Boolean(pageState?.isProfileSetupPage),
      errorMessage: String(pageState?.errorMessage || ''),
    };
  } catch (err) {
    console.warn(LOG_PREFIX, 'Consent page state check failed:', err?.message || err);
    return {
      url: currentUrl,
      hasVisibleContinueButton: false,
      isConsentPage: false,
      hasVisibleRetryButton: false,
      isErrorPage: false,
      isPhoneRequiredPage: false,
      isVerificationPage: false,
      isProfileSetupPage: false,
      errorMessage: '',
    };
  }
}

async function isSignupConsentPageReady() {
  const pageState = await getSignupPageState();
  return pageState.isConsentPage;
}

async function waitForConsentPageReady(timeoutMs = 12000, pollMs = 300) {
  const observedStates = [];
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    throwIfStopped();

    const pageState = await getSignupPageState();
    observedStates.push(pageState);

    if (MultiPageOAuthFlow.hasAnyConsentPageState(observedStates)) {
      return true;
    }

    await sleepWithStop(pollMs);
  }

  return false;
}

function resolveStepAfterStep3FromPageState(pageState = {}) {
  if (!pageState || typeof pageState !== 'object') {
    return 0;
  }

  if (pageState.isConsentPage) {
    return 8;
  }

  const url = String(pageState.url || '');
  try {
    const parsed = new URL(url);
    const path = String(parsed.pathname || '').toLowerCase();
    const search = String(parsed.search || '').toLowerCase();
    const combined = `${path}${search}`;

    if (path.includes('/sign-in-with-chatgpt/')) {
      return 8;
    }

    if (
      /\/onboarding(?:\/|$)/.test(path)
      || /\/profile(?:\/|$)/.test(path)
      || /\/welcome(?:\/|$)/.test(path)
      || /signup\/details/.test(combined)
      || /account\/details/.test(combined)
      || /user\/details/.test(combined)
      || /birthday/.test(combined)
      || /(?:^|[/?=&_-])age(?:[/?=&_-]|$)/.test(combined)
    ) {
      return 5;
    }

    if (
      /\/verify(?:\/|$)/.test(path)
      || /\/verification(?:\/|$)/.test(path)
      || /verify-email/.test(combined)
      || /email-verification/.test(combined)
      || /\/otp(?:\/|$)/.test(path)
      || /(?:^|[/?=&_-])code(?:[/?=&_-]|$)/.test(combined)
      || /confirm-email/.test(combined)
    ) {
      return 4;
    }
  } catch {}

  if (pageState.isProfileSetupPage) {
    return 5;
  }

  if (pageState.isVerificationPage) {
    return 4;
  }

  return 0;
}

async function waitForResolvedStepAfterStep3(timeoutMs = 8000, pollMs = 300) {
  const start = Date.now();
  let latestPageState = null;

  while (Date.now() - start < timeoutMs) {
    throwIfStopped();
    latestPageState = await getSignupPageState();
    const resolvedStep = resolveStepAfterStep3FromPageState(latestPageState);
    if (resolvedStep) {
      return { resolvedStep, pageState: latestPageState };
    }
    await sleepWithStop(pollMs);
  }

  if (!latestPageState) {
    latestPageState = await getSignupPageState().catch(() => null);
  }

  return {
    resolvedStep: resolveStepAfterStep3FromPageState(latestPageState) || 4,
    pageState: latestPageState || {},
  };
}

async function confirmNoPhoneRequirementAfterStep7(timeoutMs = 5000, pollMs = 300) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    throwIfStopped();
    const pageState = await getSignupPageState();

    if (pageState.isPhoneRequiredPage) {
      return 'fail';
    }

    if (pageState.isConsentPage || pageState.isErrorPage) {
      return '';
    }

    await sleepWithStop(pollMs);
  }

  return '';
}

async function skipStepBecauseConsentReady(step) {
  await completeStepFromBackground(step, { skipped: true, reason: 'consent_ready' }, {
    logMessage: `Step ${step} skipped: consent page already ready`,
  });
}

async function clearErrorPageRetryCount(step) {
  const state = await getState();
  const current = { ...(state.errorPageRetryCounts || {}) };
  if (current[String(step)] === undefined) {
    return;
  }
  delete current[String(step)];
  await setState({ errorPageRetryCounts: current });
}

function getRetryPreviousStep(step) {
  const currentStep = Number(step);
  if (currentStep <= 2) return null;
  return currentStep - 1;
}

async function recoverFromSignupErrorPage(step) {
  const currentStep = Number(step);
  if (![2, 3, 4, 5, 6, 7, 8].includes(currentStep)) {
    return false;
  }
  const previousStep = getRetryPreviousStep(currentStep);
  if (!previousStep) {
    return false;
  }

  const pageState = await getSignupPageState();
  const retryResult = await triggerSignupErrorPageRetry(currentStep, pageState, { previousStep });
  if (!retryResult.triggered) {
    return false;
  }
  await sleepWithStop(2000);

  await setStepStatus(previousStep, 'pending');
  await setStepStatus(currentStep, 'pending');
  await executeStep(previousStep, { allowErrorPageRecovery: false });
  await executeStep(currentStep, { allowErrorPageRecovery: false });
  return true;
}

async function triggerSignupErrorPageRetry(step, pageState = null, options = {}) {
  const currentStep = Number(step);
  const previousStep = options.previousStep === undefined
    ? getRetryPreviousStep(currentStep)
    : options.previousStep;
  const resolvedPageState = pageState || await getSignupPageState();

  if (!resolvedPageState.isErrorPage || !resolvedPageState.hasVisibleRetryButton) {
    return { triggered: false, reason: 'not_retryable' };
  }

  if (/max_check_attempts/i.test(String(resolvedPageState.errorMessage || ''))) {
    await addLog(`Step ${currentStep}: OpenAI error page indicates max_check_attempts. Marking step as failed without retry.`, 'error');
    return { triggered: false, reason: 'max_check_attempts' };
  }

  const state = await getState();
  const currentCounts = { ...(state.errorPageRetryCounts || {}) };
  const retryCount = Number(currentCounts[String(currentStep)] || 0);
  if (retryCount >= MAX_ERROR_PAGE_RETRIES_PER_STEP) {
    await addLog(`Step ${currentStep}: OpenAI error page retry limit reached (${MAX_ERROR_PAGE_RETRIES_PER_STEP}/${MAX_ERROR_PAGE_RETRIES_PER_STEP}). Marking step as failed.`, 'error');
    return { triggered: false, reason: 'retry_limit' };
  }

  currentCounts[String(currentStep)] = retryCount + 1;
  await setState({ errorPageRetryCounts: currentCounts });
  extendRunTimeoutForErrorRefresh();

  const rollbackSuffix = previousStep ? ` and rolling back to step ${previousStep}` : '';
  await addLog(
    `Step ${currentStep}: Detected OpenAI error page (${resolvedPageState.errorMessage || 'unknown error'}). Clicking retry${rollbackSuffix}. Auto retry ${retryCount + 1}/${MAX_ERROR_PAGE_RETRIES_PER_STEP}.`,
    'warn'
  );
  await sendToContentScript('signup-page', {
    type: 'RETRY_ERROR_PAGE',
    step: currentStep,
    source: 'background',
    reportStepError: false,
    payload: {},
  });

  return { triggered: true, retryCount: retryCount + 1 };
}

async function getImmediateFailureReasonForSignupErrorPage(step) {
  const currentStep = Number(step);
  if (![2, 3, 4, 5, 6, 7, 8].includes(currentStep)) {
    return '';
  }
  const pageState = await getSignupPageState().catch(() => null);
  if (!pageState?.isErrorPage) {
    return '';
  }
  if (/max_check_attempts/i.test(String(pageState.errorMessage || ''))) {
    return `OpenAI error page: ${pageState.errorMessage}`;
  }
  return '';
}

// ============================================================
// Step Status Management
// ============================================================

async function setStepStatus(step, status) {
  const state = await getState();
  const statuses = { ...state.stepStatuses };
  statuses[step] = status;
  await setState({ stepStatuses: statuses, currentStep: step });
  // Broadcast to side panel
  chrome.runtime.sendMessage({
    type: 'STEP_STATUS_CHANGED',
    payload: { step, status },
  }).catch(() => {});
}

function isStopError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return message === STOP_ERROR_MESSAGE;
}

function isRunTimeoutError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return message === RUN_TIMEOUT_ERROR_MESSAGE
    || message === 'Registration exceeded 120s limit.'
    || message === 'Registration exceeded 150s limit.';
}

function clearStopRequest() {
  stopRequested = false;
}

function clearRunTimeoutState() {
  runTimedOut = false;
  runTimeoutDeadlineMs = 0;
  if (runTimeoutHandle) {
    clearTimeout(runTimeoutHandle);
    runTimeoutHandle = null;
  }
}

function scheduleRunTimeout() {
  if (!runTimeoutDeadlineMs) return;
  if (runTimeoutHandle) {
    clearTimeout(runTimeoutHandle);
    runTimeoutHandle = null;
  }
  const remainingMs = Math.max(0, runTimeoutDeadlineMs - Date.now());
  runTimeoutHandle = setTimeout(() => {
    triggerRunTimeout().catch((err) => {
      console.warn(LOG_PREFIX, 'Run timeout handler failed:', err?.message || err);
    });
  }, remainingMs);
}

function extendRunTimeoutForErrorRefresh() {
  if (!runTimeoutDeadlineMs) return;
  runTimeoutDeadlineMs += ERROR_PAGE_TIMEOUT_BONUS_MS;
  scheduleRunTimeout();
}

function getCachedHotmailHealth(baseUrl) {
  if (!hotmailHealthCache) return null;
  if (hotmailHealthCache.baseUrl !== baseUrl) return null;
  if (Date.now() - hotmailHealthCache.timestamp > HOTMAIL_HEALTH_CACHE_TTL_MS) return null;
  return hotmailHealthCache.payload;
}

function setCachedHotmailHealth(baseUrl, payload) {
  hotmailHealthCache = {
    baseUrl,
    payload,
    timestamp: Date.now(),
  };
}

function throwIfStopped() {
  if (stopRequested) {
    throw new Error(STOP_ERROR_MESSAGE);
  }
  if (runTimedOut) {
    throw new Error(RUN_TIMEOUT_ERROR_MESSAGE);
  }
}

async function sleepWithStop(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    throwIfStopped();
    await new Promise(r => setTimeout(r, Math.min(100, ms - (Date.now() - start))));
  }
}

async function humanStepDelay(min = HUMAN_STEP_DELAY_MIN, max = HUMAN_STEP_DELAY_MAX) {
  const duration = Math.floor(Math.random() * (max - min + 1)) + min;
  await sleepWithStop(duration);
}

async function clickWithDebugger(tabId, rect) {
  if (!tabId) {
    throw new Error('No auth tab found for debugger click.');
  }
  if (!rect || !Number.isFinite(rect.centerX) || !Number.isFinite(rect.centerY)) {
    throw new Error('Step 8 debugger fallback needs a valid button position.');
  }

  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (err) {
    throw new Error(
      `Debugger attach failed during step 8 fallback: ${err.message}. ` +
      'If DevTools is open on the auth tab, close it and retry.'
    );
  }

  try {
    const x = Math.round(rect.centerX);
    const y = Math.round(rect.centerY);

    await chrome.debugger.sendCommand(target, 'Page.bringToFront');
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
      clickCount: 0,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function broadcastStopToContentScripts() {
  const registry = await getTabRegistry();
  for (const entry of Object.values(registry)) {
    if (!entry?.tabId) continue;
    try {
      await chrome.tabs.sendMessage(entry.tabId, {
        type: 'STOP_FLOW',
        source: 'background',
        payload: {},
      });
    } catch {}
  }
}

let stopRequested = false;
let runTimedOut = false;
let runTimeoutHandle = null;
let runTimeoutDeadlineMs = 0;
let hotmailHealthCache = null;

// ============================================================
// Message Handler (central router)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(LOG_PREFIX, `Received: ${message.type} from ${message.source || 'sidepanel'}`, message);

  handleMessage(message, sender).then(response => {
    sendResponse(response);
  }).catch(err => {
    console.error(LOG_PREFIX, 'Handler error:', err);
    sendResponse({ error: err.message });
  });

  return true; // async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'CONTENT_SCRIPT_READY': {
      const tabId = sender.tab?.id;
      if (tabId && message.source) {
        await registerTab(message.source, tabId);
        flushCommand(message.source, tabId);
        await addLog(`Content script ready: ${message.source} (tab ${tabId})`);
      }
      return { ok: true };
    }

    case 'LOG': {
      const { message: msg, level } = message.payload;
      await addLog(`[${message.source}] ${msg}`, level);
      return { ok: true };
    }

    case 'STEP_COMPLETE': {
      if (stopRequested) {
        await setStepStatus(message.step, 'stopped');
        notifyStepError(message.step, STOP_ERROR_MESSAGE);
        return { ok: true };
      }
      await clearErrorPageRetryCount(message.step);
      await setStepStatus(message.step, 'completed');
      await addLog(`Step ${message.step} completed`, 'ok');
      await handleStepData(message.step, message.payload);
      if (Number(message.step) === 9) {
        const state = await getState();
        if (normalizeEmailProvider(state.emailProvider) === EMAIL_PROVIDER_HOTMAIL) {
          await markCurrentHotmailDbAccount('success', {
            tag: 'registered',
            note: 'registration completed',
            openaiPassword: state.password || null,
          });
        }
      }
      notifyStepComplete(message.step, message.payload);
      return { ok: true };
    }

    case 'STEP_ERROR': {
      if (isStopError(message.error)) {
        await setStepStatus(message.step, 'stopped');
        await addLog(`Step ${message.step} stopped by user`, 'warn');
        notifyStepError(message.step, message.error);
      } else {
        await setStepStatus(message.step, 'failed');
        await addLog(`Step ${message.step} failed: ${message.error}`, 'error');
        const state = await getState();
        if (normalizeEmailProvider(state.emailProvider) === EMAIL_PROVIDER_HOTMAIL && Number(message.step) >= 3 && state.currentHotmailDbEmail) {
          await markCurrentHotmailDbAccount('failed', {
            tag: `failed-step-${message.step}`,
            note: message.error,
            openaiPassword: state.password || null,
          });
        }
        notifyStepError(message.step, message.error);
      }
      return { ok: true };
    }

    case 'GET_STATE': {
      await resetClaimedHotmailIfIdle({ reason: 'sidepanel opened while idle' });
      return await getState();
    }

    case 'RESET': {
      clearStopRequest();
      await resetState();
      await resetClaimedHotmailIfIdle({ force: true, reason: 'flow reset' });
      await addLog('Flow reset', 'info');
      return { ok: true };
    }

    case 'EXECUTE_STEP': {
      clearStopRequest();
      const step = message.payload.step;
      // Save email if provided (from side panel step 3)
      if (message.payload.email) {
        await setEmailState(message.payload.email);
      }
      await executeStep(step);
      return { ok: true };
    }

    case 'AUTO_RUN': {
      clearStopRequest();
      const totalRuns = message.payload?.totalRuns || 1;
      autoRunLoop(totalRuns);  // fire-and-forget
      return { ok: true };
    }

    case 'RESUME_AUTO_RUN': {
      clearStopRequest();
      if (message.payload.email) {
        await setEmailState(message.payload.email);
        const state = await getState();
        if (isRelayFirefoxProvider(state.emailProvider) && !state.activeRelayMask) {
          await setActiveRelayMaskState({ email: message.payload.email, label: null, inferred: true });
        }
        if (isCloudflareTempEmailProvider(state.emailProvider)) {
          await setActiveCloudflareMailboxState({
            email: message.payload.email,
            addressId: null,
            provenance: 'manual_existing',
            acquiredAt: Date.now(),
          });
        }
      }
      resumeAutoRun();  // fire-and-forget
      return { ok: true };
    }

    case 'SAVE_SETTING': {
      const updates = {};
      if (message.payload.cpaBaseUrl !== undefined) updates.cpaBaseUrl = normalizeCpaBaseUrl(message.payload.cpaBaseUrl);
      if (message.payload.cpaManagementKey !== undefined) updates.cpaManagementKey = message.payload.cpaManagementKey;
      if (message.payload.customPassword !== undefined) updates.customPassword = message.payload.customPassword;
      if (message.payload.emailProvider !== undefined) {
        updates.emailProvider = normalizeEmailProvider(message.payload.emailProvider);
      }
      if (message.payload.mailProvider !== undefined) updates.mailProvider = message.payload.mailProvider;
      if (message.payload.mail2925MainEmail !== undefined) {
        updates.mail2925MainEmail = String(message.payload.mail2925MainEmail || '').trim();
      }
      if (message.payload.cloudflareTempEmailAdminUrl !== undefined) {
        updates.cloudflareTempEmailAdminUrl = String(message.payload.cloudflareTempEmailAdminUrl || '').trim();
      }
      if (message.payload.hotmailApiBaseUrl !== undefined) {
        await setHotmailApiBaseUrlState(message.payload.hotmailApiBaseUrl);
      }
      if (message.payload.hotmailEmail !== undefined) {
        await setHotmailEmailState(message.payload.hotmailEmail);
      }
      if (message.payload.hotmailPassword !== undefined) {
        await setHotmailPasswordState(message.payload.hotmailPassword);
      }
      if (message.payload.hotmailAccessMethod !== undefined) {
        await setHotmailAccessMethodState(message.payload.hotmailAccessMethod);
      }
      if (message.payload.hotmailClientId !== undefined) {
        await setHotmailClientIdState(message.payload.hotmailClientId);
      }
      if (message.payload.hotmailRefreshToken !== undefined) {
        await setHotmailRefreshTokenState(message.payload.hotmailRefreshToken);
      }
      if (message.payload.hotmailBatchRaw !== undefined) {
        await setHotmailBatchRawState(message.payload.hotmailBatchRaw);
      }
      if (message.payload.inbucketHost !== undefined) updates.inbucketHost = message.payload.inbucketHost;
      if (message.payload.inbucketMailbox !== undefined) updates.inbucketMailbox = message.payload.inbucketMailbox;
      await setState(updates);
      if (updates.emailProvider !== undefined) {
        broadcastDataUpdate({ emailProvider: updates.emailProvider });
        if (updates.emailProvider === EMAIL_PROVIDER_HOTMAIL) {
          const state = await getState();
          if (state.hotmailEmail) {
            await setEmailState(state.hotmailEmail);
          }
        }
      }
      if (updates.mailProvider !== undefined) {
        broadcastDataUpdate({ mailProvider: updates.mailProvider });
      }
      if (updates.mail2925MainEmail !== undefined) {
        broadcastDataUpdate({ mail2925MainEmail: updates.mail2925MainEmail });
      }
      return { ok: true };
    }

    case 'SAVE_CPA_PERSISTENT': {
      await setPersistentCpaSettings({
        cpaBaseUrl: message.payload?.cpaBaseUrl,
        cpaManagementKey: message.payload?.cpaManagementKey,
      });
      const updates = {
        cpaBaseUrl: normalizeCpaBaseUrl(message.payload?.cpaBaseUrl || ''),
        cpaManagementKey: message.payload?.cpaManagementKey || '',
      };
      await setState(updates);
      broadcastDataUpdate(updates);
      return { ok: true };
    }

    // Side panel data updates
    case 'SAVE_EMAIL': {
      await setEmailState(message.payload.email);
      return { ok: true, email: message.payload.email };
    }

    case 'FETCH_PROVIDER_EMAIL': {
      clearStopRequest();
      const email = await fetchEmailFromProvider(message.payload || {});
      return { ok: true, email };
    }

    case 'IMPORT_HOTMAIL_DB': {
      await setHotmailBatchRawState(message.payload?.rawText || '');
      const summary = await syncHotmailBatchToDbIfNeeded(await getState());
      return { ok: true, summary };
    }

    case 'REFRESH_HOTMAIL_DB_SUMMARY': {
      const summary = await fetchHotmailDbSummary();
      return { ok: true, summary };
    }

    case 'FETCH_DUCK_EMAIL': {
      clearStopRequest();
      const email = await fetchEmailFromProvider({
        ...(message.payload || {}),
        provider: EMAIL_PROVIDER_DUCK,
      });
      return { ok: true, email };
    }

    case 'STOP_FLOW': {
      await requestStop();
      return { ok: true };
    }

    default:
      console.warn(LOG_PREFIX, `Unknown message type: ${message.type}`);
      return { error: `Unknown message type: ${message.type}` };
  }
}

// ============================================================
// Step Data Handlers
// ============================================================

async function handleStepData(step, payload) {
  switch (step) {
    case 1:
      if (payload.oauthUrl || payload.oauthState) {
        await setState({ oauthUrl: payload.oauthUrl || null, oauthState: payload.oauthState || null });
        broadcastDataUpdate({ oauthUrl: payload.oauthUrl || null });
      }
      break;
    case 3:
      if (payload.email) await setEmailState(payload.email);
      break;
    case 4:
      if (payload.emailTimestamp) await setState({ lastEmailTimestamp: payload.emailTimestamp });
      if (payload.code) await setState({ lastVerificationCode: payload.code });
      break;
    case 8:
      if (payload.localhostUrl) {
        await setState({ localhostUrl: payload.localhostUrl });
        broadcastDataUpdate({ localhostUrl: payload.localhostUrl });
      }
      break;
  }
}

// ============================================================
// Step Completion Waiting
// ============================================================

// Map of step -> { resolve, reject } for waiting on step completion
const stepWaiters = new Map();
let resumeWaiter = null;

function waitForStepComplete(step, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    throwIfStopped();
    const timer = setTimeout(() => {
      stepWaiters.delete(step);
      reject(new Error(`Step ${step} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    stepWaiters.set(step, {
      resolve: (data) => { clearTimeout(timer); stepWaiters.delete(step); resolve(data); },
      reject: (err) => { clearTimeout(timer); stepWaiters.delete(step); reject(err); },
    });
  });
}

function notifyStepComplete(step, payload) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.resolve(payload);
}

function notifyStepError(step, error) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.reject(new Error(error));
}

async function markRunningStepsStopped() {
  const state = await getState();
  const runningSteps = Object.entries(state.stepStatuses || {})
    .filter(([, status]) => status === 'running')
    .map(([step]) => Number(step));

  for (const step of runningSteps) {
    await setStepStatus(step, 'stopped');
  }
}

async function markRunningStepsFailed() {
  const state = await getState();
  const runningSteps = Object.entries(state.stepStatuses || {})
    .filter(([, status]) => status === 'running')
    .map(([step]) => Number(step));

  for (const step of runningSteps) {
    await setStepStatus(step, 'failed');
  }
}

async function triggerRunTimeout() {
  if (runTimedOut || stopRequested) return;
  runTimedOut = true;
  await broadcastStopToContentScripts();
  for (const waiter of stepWaiters.values()) {
    waiter.reject(new Error(RUN_TIMEOUT_ERROR_MESSAGE));
  }
  stepWaiters.clear();
  if (resumeWaiter) {
    resumeWaiter.reject(new Error(RUN_TIMEOUT_ERROR_MESSAGE));
    resumeWaiter = null;
  }
}

function getStepCompletionTimeoutMs(step) {
  switch (Number(step)) {
    case 4:
      return STEP4_COMPLETION_TIMEOUT_MS;
    case 7:
      return STEP7_COMPLETION_TIMEOUT_MS;
    default:
      return DEFAULT_STEP_COMPLETION_TIMEOUT_MS;
  }
}

async function requestStop() {
  if (stopRequested) return;

  stopRequested = true;
  cancelPendingCommands();
  if (webNavListener) {
    chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
    webNavListener = null;
  }

  await addLog('Stop requested. Cancelling current operations...', 'warn');
  await broadcastStopToContentScripts();

  for (const waiter of stepWaiters.values()) {
    waiter.reject(new Error(STOP_ERROR_MESSAGE));
  }
  stepWaiters.clear();

  if (resumeWaiter) {
    resumeWaiter.reject(new Error(STOP_ERROR_MESSAGE));
    resumeWaiter = null;
  }

  await markRunningStepsStopped();
  autoRunActive = false;
  await setState({ autoRunning: false });
  await resetClaimedHotmailIfIdle({ force: true, reason: 'flow stopped' });
  chrome.runtime.sendMessage({
    type: 'AUTO_RUN_STATUS',
    payload: { phase: 'stopped', currentRun: autoRunCurrentRun, totalRuns: autoRunTotalRuns },
  }).catch(() => {});
}

// ============================================================
// Step Execution
// ============================================================

async function executeStep(step, options = {}) {
  const { allowErrorPageRecovery = true } = options;
  console.log(LOG_PREFIX, `Executing step ${step}`);
  throwIfStopped();
  await setStepStatus(step, 'running');
  await addLog(`Step ${step} started`);
  await humanStepDelay();

  const state = await getState();

  // Set flow start time on first step
  if (step === 1 && !state.flowStartTime) {
    await setState({ flowStartTime: Date.now() });
  }

  try {
    switch (step) {
      case 1: await executeStep1(state); break;
      case 2: await executeStep2(state); break;
      case 3: await executeStep3(state); break;
      case 4: await executeStep4(state); break;
      case 5: await executeStep5(state); break;
      case 6: await executeStep6(state); break;
      case 7: await executeStep7(state); break;
      case 8: await executeStep8(state); break;
      case 9: await executeStep9(state); break;
      default:
        throw new Error(`Unknown step: ${step}`);
    }
  } catch (err) {
    const immediateFailureReason = await getImmediateFailureReasonForSignupErrorPage(step).catch(() => '');
    if (immediateFailureReason) {
      err = new Error(immediateFailureReason);
    }
    if (allowErrorPageRecovery && await recoverFromSignupErrorPage(step).catch(() => false)) {
      return;
    }
    if (isStopError(err)) {
      await setStepStatus(step, 'stopped');
      await addLog(`Step ${step} stopped by user`, 'warn');
      throw err;
    }
    await setStepStatus(step, 'failed');
    await addLog(`Step ${step} failed: ${err.message}`, 'error');
    const latestState = await getState();
    if (normalizeEmailProvider(latestState.emailProvider) === EMAIL_PROVIDER_HOTMAIL && Number(step) >= 3 && latestState.currentHotmailDbEmail) {
      await markCurrentHotmailDbAccount('failed', {
        tag: `failed-step-${step}`,
        note: err.message,
        openaiPassword: latestState.password || null,
      });
    }
    throw err;
  }
}

/**
 * Execute a step and wait for it to complete before returning.
 * @param {number} step
 * @param {number} delayAfter - ms to wait after completion (for page transitions)
 */
async function executeStepAndWait(step, delayAfter = 2000) {
  throwIfStopped();
  const promise = waitForStepComplete(step, getStepCompletionTimeoutMs(step));
  await executeStep(step);
  await promise;
  // Extra delay for page transitions / DOM updates
  if (delayAfter > 0) {
    await sleepWithStop(delayAfter + Math.floor(Math.random() * 1200));
  }
}

async function fetchEmailFromProvider(options = {}) {
  const state = await getState();
  const provider = normalizeEmailProvider(options.provider || state.emailProvider);

  if (is2925EmailProvider(provider)) {
    return fetch2925ChildEmail(options);
  }

  if (isCloudflareTempEmailProvider(provider)) {
    return fetchCloudflareTempEmail(options);
  }

  if (isHotmailEmailProvider(provider)) {
    await setActiveCloudflareMailboxState(null);
    await setActiveRelayMaskState(null);
    return fetchHotmailEmail(options);
  }

  if (isRelayFirefoxProvider(provider)) {
    await setActiveCloudflareMailboxState(null);
    return fetchRelayMaskEmail(options);
  }

  await setActiveCloudflareMailboxState(null);
  await setActiveRelayMaskState(null);
  return fetchDuckEmail(options);
}

function buildHotmailApiUrl(baseUrl, path) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

function mapHotmailApiResultToError(result) {
  const status = String(result?.status || '').trim();
  const reason = String(result?.reason || '').trim();

  switch (status) {
    case 'login_failed':
      return `Hotmail login failed. ${reason || 'Check the configured Hotmail email and password.'}`;
    case 'security_challenge':
      return `Hotmail security challenge detected. ${reason || 'Microsoft requires additional verification for this account.'}`;
    case 'mailbox_load_failed':
      return `Hotmail mailbox load failed. ${reason || 'The companion service could not load the Outlook mailbox.'}`;
    case 'no_code_found':
      return `No matching verification email was found in Hotmail. ${reason || ''}`.trim();
    case 'timeout':
      return `No matching verification email was found in Hotmail before timeout. ${reason || ''}`.trim();
    default:
      return reason || `Hotmail API returned status: ${status || 'unknown'}`;
  }
}

async function callHotmailApi(path, body = null, options = {}) {
  const {
    timeoutMs = 15000,
    method = body ? 'POST' : 'GET',
    signal: externalSignal = null,
    abortMessage = 'Hotmail API request aborted.',
  } = options;
  const state = await getState();
  const baseUrl = getHotmailApiBaseUrl(state);
  const url = buildHotmailApiUrl(baseUrl, path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(externalSignal?.reason || abortMessage);
    }
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      onExternalAbort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  try {
    const response = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const rawText = await response.text();
    let payload = null;

    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = { raw: rawText };
      }
    }

    if (!response.ok) {
      const detail = payload?.detail || payload?.reason || payload?.raw || response.statusText;
      throw new Error(`Hotmail API ${path} failed (${response.status}): ${detail}`);
    }

    return payload || {};
  } catch (err) {
    if (err?.name === 'AbortError') {
      if (externalSignal?.aborted) {
        throw new Error(abortMessage);
      }
      throw new Error(`Hotmail API request timed out after ${Math.round(timeoutMs / 1000)}s: ${url}`);
    }
    throw new Error(`Hotmail API request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

async function ensureHotmailServiceHealthy(state, options = {}) {
  const { requireEmail = true } = options;
  const baseUrl = getHotmailApiBaseUrl(state);
  const email = String(state.hotmailEmail || '').trim();
  const password = state.hotmailPassword || '';
  const accessMethod = getHotmailAccessMethod(state);
  const clientId = String(state.hotmailClientId || '').trim();
  const refreshToken = state.hotmailRefreshToken || '';
  const needOAuth = accessMethod === 'graph' || accessMethod === 'imap_new' || accessMethod === 'imap_old';
  const needPassword = accessMethod === 'playwright' || (accessMethod === 'auto' && !hasHotmailOauthCredentials(state));

  if (requireEmail && !email) {
    throw new Error('Hotmail Email is empty. Fill it in the side panel first.');
  }
  if (needPassword && !password) {
    throw new Error('Hotmail Password is empty. Fill it in the side panel first.');
  }
  if (needOAuth && (!clientId || !refreshToken)) {
    throw new Error('Hotmail Graph / IMAP mode requires both Client ID and Refresh Token.');
  }

  let health = getCachedHotmailHealth(baseUrl);
  if (!health) {
    health = await callHotmailApi('/health', null, { timeoutMs: 10000 });
    setCachedHotmailHealth(baseUrl, health);
  }
  if (health && health.browser_ready === false) {
    throw new Error(`Hotmail companion service browser is not ready. ${health.browser_reason || ''}`.trim());
  }

  await setState({
    hotmailApiBaseUrl: baseUrl,
    hotmailEmail: email,
    hotmailPassword: password,
    hotmailAccessMethod: accessMethod,
    hotmailClientId: clientId,
    hotmailRefreshToken: refreshToken,
  });

  return { baseUrl, email, password, accessMethod, clientId, refreshToken, health };
}

async function fetchHotmailEmail(options = {}) {
  throwIfStopped();
  let state = await getState();
  if (shouldUseHotmailDbMode(state)) {
    if (!state.currentHotmailDbEmail) {
      const claimed = await claimNextHotmailDbAccount(state);
      if (!claimed?.email) {
        throw new Error('账号不足：数据库中没有可运行的 pending Hotmail 账号。');
      }
    }
    state = await getState();
  }
  const { email } = await ensureHotmailServiceHealthy(state, { requireEmail: true, ...options });
  await setEmailState(email);
  await addLog(`Hotmail: Ready ${email}`, 'ok');
  return email;
}

function shouldUseHotmailForVerification(state = {}) {
  return normalizeEmailProvider(state.emailProvider) === EMAIL_PROVIDER_HOTMAIL
    || state.mailProvider === MAIL_PROVIDER_HOTMAIL;
}

async function pollCodeFromHotmail(step, state, options = {}) {
  const currentState = state || await getState();
  const { email, password, accessMethod, clientId, refreshToken } = await ensureHotmailServiceHealthy(currentState, {
    requireEmail: true,
  });

  if (currentState.email && currentState.email.trim().toLowerCase() !== email.toLowerCase()) {
    throw new Error('Mail = Hotmail requires the signup email to match the configured Hotmail Email.');
  }

  const payload = {
    email,
    password: password || undefined,
    access_method: accessMethod,
    client_id: clientId || undefined,
    refresh_token: refreshToken || undefined,
    max_wait_seconds: options.maxWaitSeconds || 90,
    poll_interval_seconds: options.pollIntervalSeconds || 5,
    min_created_at_ms: options.filterAfterTimestamp || undefined,
    exclude_codes: options.excludeCodes || [],
  };

  await addLog(`Step ${step}: Polling Hotmail via companion service...`);
  const result = await callHotmailApi('/fetch-code-direct', payload, {
    timeoutMs: (payload.max_wait_seconds + 30) * 1000,
    method: 'POST',
    signal: options.signal,
    abortMessage: options.abortMessage || 'Hotmail polling aborted.',
  });

  if (result?.status !== 'ok' || !result?.code) {
    throw new Error(mapHotmailApiResultToError(result));
  }

  return {
    ...result,
    code: result.code,
    emailTimestamp: result.received_at_ms || Date.now(),
  };
}

async function pollHotmailStep7WithActiveErrorRecovery(state, options = {}) {
  const controller = new AbortController();
  let watcherStopped = false;
  let watcherTriggered = false;

  const watcher = (async () => {
    while (!watcherStopped) {
      throwIfStopped();

      const pageState = await getSignupPageState().catch(() => null);
      if (pageState?.isErrorPage && pageState?.hasVisibleRetryButton) {
        const retryResult = await triggerSignupErrorPageRetry(7, pageState, { previousStep: null });
        if (retryResult.triggered) {
          watcherTriggered = true;
          controller.abort(STEP7_ERROR_PAGE_RECOVERY_ABORT_MESSAGE);
          return;
        }
        if (retryResult.reason === 'max_check_attempts' || retryResult.reason === 'retry_limit') {
          return;
        }
      }

      await sleepWithStop(500);
    }
  })();

  try {
    return await pollCodeFromHotmail(7, state, {
      ...options,
      signal: controller.signal,
      abortMessage: STEP7_ERROR_PAGE_RECOVERY_ABORT_MESSAGE,
    });
  } catch (err) {
    if (watcherTriggered && err?.message === STEP7_ERROR_PAGE_RECOVERY_ABORT_MESSAGE) {
      throw err;
    }
    throw err;
  } finally {
    watcherStopped = true;
    controller.abort('done');
    await Promise.allSettled([watcher]);
  }
}

async function fetch2925MainEmailFromPage(options = {}) {
  throwIfStopped();
  const mail = getMailConfig({ mailProvider: MAIL_PROVIDER_2925 });

  try {
    await addLog('2925邮箱: 正在打开 2925 页面识别主邮箱...', 'info');
    await reuseOrCreateTab(mail.source, mail.url, {
      activate: options.activate !== false,
    });
  } catch {
    throw new Error('2925 页面打开失败，请确认 https://www.2925.com/#/mailList 可以正常访问并已登录。');
  }

  const result = await sendToContentScript(mail.source, {
    type: 'FETCH_2925_MAIN_EMAIL',
    source: 'background',
    reportStepError: false,
  });

  if (!result) {
    throw new Error('未检测到 2925 主邮箱，请先登录 2925 邮箱并打开收件箱页面。');
  }
  if (result?.error) {
    throw new Error(result.error);
  }

  const mainMailbox = parse2925MainEmail(result?.email || '');
  if (!mainMailbox?.email) {
    throw new Error('当前识别到的邮箱不是有效的 2925 主邮箱，请确认你打开的是正确的 2925 邮箱账号。');
  }

  await set2925MainEmailState(mainMailbox.email);
  await setState({ mailProvider: MAIL_PROVIDER_2925 });
  broadcastDataUpdate({ mailProvider: MAIL_PROVIDER_2925 });

  if (result?.detectionMode === 'fallback') {
    await addLog(`2925邮箱: 未识别到当前账号区域，已退回使用第一个合法主邮箱 ${mainMailbox.email}`, 'warn');
  } else {
    await addLog(`2925邮箱: 已从页面识别主邮箱 ${mainMailbox.email}`, 'ok');
  }

  return {
    ...mainMailbox,
    detectionMode: result?.detectionMode || 'preferred',
  };
}

async function fetch2925ChildEmail(options = {}) {
  throwIfStopped();
  const mainMailbox = parse2925MainEmail(options.mainEmail || '')
    || await fetch2925MainEmailFromPage({ activate: options.activate });

  const result = build2925ChildEmail(mainMailbox.email);
  if (!result?.childEmail) {
    throw new Error('2925 主邮箱获取失败，无法生成子邮箱。');
  }

  await setActiveCloudflareMailboxState(null);
  await setActiveRelayMaskState(null);
  await setState({ mailProvider: MAIL_PROVIDER_2925 });
  broadcastDataUpdate({ mailProvider: MAIL_PROVIDER_2925 });
  await setEmailState(result.childEmail);
  await addLog(`2925邮箱: 已基于主邮箱 ${mainMailbox.email} 生成子邮箱 ${result.childEmail}`, 'ok');
  return result.childEmail;
}

async function fetchDuckEmail(options = {}) {
  throwIfStopped();
  const { generateNew = true } = options;

  await addLog(`Duck Mail: Opening autofill settings (${generateNew ? 'generate new' : 'reuse current'})...`);
  await reuseOrCreateTab('duck-mail', DUCK_AUTOFILL_URL);

  const result = await sendToContentScript('duck-mail', {
    type: 'FETCH_DUCK_EMAIL',
    source: 'background',
    payload: { generateNew },
  });

  if (result?.error) {
    throw new Error(result.error);
  }
  if (!result?.email) {
    throw new Error('Duck email not returned.');
  }

  await setEmailState(result.email);
  await addLog(`Duck Mail: ${result.generated ? 'Generated' : 'Loaded'} ${result.email}`, 'ok');
  return result.email;
}

async function fetchRelayMaskEmail(options = {}) {
  throwIfStopped();
  const { generateNew = true } = options;

  await setActiveCloudflareMailboxState(null);
  await addLog(`Relay: Opening profile page (${generateNew ? 'create new mask' : 'reuse current'})...`);
  await reuseOrCreateTab('relay-firefox', RELAY_FIREFOX_PROFILE_URL);

  const result = await sendToContentScript('relay-firefox', {
    type: 'CREATE_RELAY_MASK',
    source: 'background',
    payload: { generateNew },
  });

  if (result?.error) {
    throw new Error(result.error);
  }
  if (!result?.email) {
    throw new Error('Relay mask email not returned.');
  }

  await setEmailState(result.email);
  await setActiveRelayMaskState({
    email: result.email,
    label: result.label || null,
  });
  await addLog(`Relay: Created ${result.email}${result.label ? ` (${result.label})` : ''}`, 'ok');
  return result.email;
}

async function fetchCloudflareTempEmail(options = {}) {
  throwIfStopped();
  const { generateNew = true } = options;
  const state = await getState();
  const adminUrl = getCloudflareTempEmailAdminUrl(state);

  await addLog(`Cloudflare Temp Email: Opening admin page (${generateNew ? 'create new mailbox' : 'reuse current'})...`);
  await reuseOrCreateTab('cloudflare-temp-email', adminUrl, {
    inject: CLOUDFLARE_TEMP_EMAIL_INJECT_FILES,
    injectSource: 'cloudflare-temp-email',
    reloadIfSameUrl: true,
  });

  const result = await sendToContentScript('cloudflare-temp-email', {
    type: 'CREATE_CLOUDFLARE_TEMP_EMAIL',
    source: 'background',
    payload: { generateNew },
  });

  if (result?.error) {
    throw new Error(result.error);
  }
  if (!result?.email) {
    throw new Error('Cloudflare Temp Email mailbox was not returned.');
  }

  await setActiveRelayMaskState(null);
  await setEmailState(result.email);
  await setActiveCloudflareMailboxState({
    email: result.email,
    addressId: result.addressId ?? null,
    provenance: result.provenance || 'created',
    acquiredAt: Date.now(),
  });
  await addLog(`Cloudflare Temp Email: ${result.generated ? 'Created' : 'Loaded'} ${result.email}`, 'ok');
  return result.email;
}

async function deleteRelayMask(activeRelayMask) {
  throwIfStopped();
  if (!activeRelayMask?.email) {
    throw new Error('No Relay mask recorded for cleanup.');
  }

  await addLog(`Relay: Opening profile page to delete ${activeRelayMask.email}...`);
  await reuseOrCreateTab('relay-firefox', RELAY_FIREFOX_PROFILE_URL);

  const result = await sendToContentScript('relay-firefox', {
    type: 'DELETE_RELAY_MASK',
    source: 'background',
    payload: { email: activeRelayMask.email },
  });

  if (result?.error) {
    throw new Error(result.error);
  }
  if (!result?.deleted) {
    throw new Error(`Relay mask ${activeRelayMask.email} was not deleted.`);
  }

  await setActiveRelayMaskState(null);
  await addLog(`Relay: Deleted ${activeRelayMask.email}`, 'ok');
}

async function openVpsPanel(vpsUrl, options = {}) {
  const targetUrl = String(vpsUrl || '').trim();
  if (!targetUrl) {
    throw new Error('No VPS URL configured. Enter VPS address in Side Panel first.');
  }

  await reuseOrCreateTab('vps-panel', targetUrl, {
    inject: VPS_PANEL_INJECT_FILES,
    injectSource: 'vps-panel',
    reloadIfSameUrl: options.reloadIfSameUrl === true,
  });
}

// ============================================================
// Auto Run Flow
// ============================================================

let autoRunActive = false;
let autoRunCurrentRun = 0;
let autoRunTotalRuns = 1;

// Outer loop: runs the full flow N times
async function autoRunLoop(totalRuns) {
  if (autoRunActive) {
    await addLog('Auto run already in progress', 'warn');
    return;
  }

  clearStopRequest();
  autoRunActive = true;
  autoRunTotalRuns = totalRuns;
  let allRunsSucceeded = true;
  let failedRuns = 0;
  if (totalRuns > 0) {
    const initialState = await getState();
    if (shouldUseHotmailDbMode(initialState)) {
      const available = Number(initialState.hotmailDbSummary?.pending || 0) || parseHotmailBatchRaw(initialState.hotmailBatchRaw).length;
      if (available < totalRuns) {
        await addLog(`Hotmail batch has ${available} accounts but run count is ${totalRuns}; later runs will reuse the last available account.`, 'warn');
      }
    }
  }
  await setState({ autoRunning: true });

  for (let run = 1; run <= totalRuns; run++) {
    autoRunCurrentRun = run;
    clearRunTimeoutState();
    runTimeoutDeadlineMs = Date.now() + MAX_REGISTRATION_DURATION_MS;
    scheduleRunTimeout();

    // Reset everything at the start of each run (keep VPS/mail settings)
    const prevState = await getState();
    const keepSettings = {
      cpaBaseUrl: prevState.cpaBaseUrl,
      cpaManagementKey: prevState.cpaManagementKey,
      emailProvider: normalizeEmailProvider(prevState.emailProvider),
      mailProvider: prevState.mailProvider,
      hotmailApiBaseUrl: prevState.hotmailApiBaseUrl,
      hotmailEmail: prevState.hotmailEmail,
      hotmailPassword: prevState.hotmailPassword,
      hotmailAccessMethod: prevState.hotmailAccessMethod,
      hotmailClientId: prevState.hotmailClientId,
      hotmailRefreshToken: prevState.hotmailRefreshToken,
      hotmailBatchRaw: prevState.hotmailBatchRaw,
      hotmailDbSummary: prevState.hotmailDbSummary,
      currentHotmailDbEmail: '',
      inbucketHost: prevState.inbucketHost,
      inbucketMailbox: prevState.inbucketMailbox,
      autoRunning: true,
    };
    await resetState();
    await setState(keepSettings);
    if (shouldUseHotmailDbMode(prevState)) {
      const selected = await claimNextHotmailDbAccount(prevState);
      if (!selected?.email) {
        await addLog(`Run ${run}/${totalRuns} stopped: 账号不足，数据库中没有 pending Hotmail 账号。`, 'error');
        allRunsSucceeded = false;
        break;
      }
      if (selected?.email) {
        await addLog(`Hotmail batch selected for run ${run}/${totalRuns}: ${selected.email}`, 'info');
      }
    }
    // Tell side panel to reset all UI
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_RESET' }).catch(() => {});
    await sleepWithStop(500);

    await addLog(`=== Auto Run ${run}/${totalRuns} — Phase 1: Get OAuth link & open signup ===`, 'info');
    const status = (phase) => ({ type: 'AUTO_RUN_STATUS', payload: { phase, currentRun: run, totalRuns } });

    try {
      throwIfStopped();
      chrome.runtime.sendMessage(status('running')).catch(() => {});

      await executeStepAndWait(1, 2000);
      await executeStepAndWait(2, 2000);

      const currentState = await getState();
      const emailProvider = normalizeEmailProvider(currentState.emailProvider);
      const providerName = getEmailProviderDisplayName(emailProvider);
      let emailReady = false;
      try {
        const providerEmail = await fetchEmailFromProvider({
          provider: emailProvider,
          generateNew: true,
        });
        await addLog(`=== Run ${run}/${totalRuns} — ${providerName} email ready: ${providerEmail} ===`, 'ok');
        emailReady = true;
      } catch (err) {
        await addLog(`${providerName} auto-fetch failed: ${err.message}`, 'warn');
      }

      if (!emailReady) {
        await addLog(`=== Run ${run}/${totalRuns} PAUSED: Fetch ${providerName} email or paste manually, then continue ===`, 'warn');
        chrome.runtime.sendMessage(status('waiting_email')).catch(() => {});

        // Wait for RESUME_AUTO_RUN — sets a promise that resumeAutoRun resolves
        await waitForResume();

        const resumedState = await getState();
        if (!resumedState.email) {
          await addLog('Cannot resume: no email address.', 'error');
          allRunsSucceeded = false;
          break;
        }
      }

      await addLog(`=== Run ${run}/${totalRuns} — Phase 2: Register, verify, login, complete ===`, 'info');
      chrome.runtime.sendMessage(status('running')).catch(() => {});

      const signupTabId = await getTabId('signup-page');
      if (signupTabId) {
        await chrome.tabs.update(signupTabId, { active: true });
      }

      await executeStepAndWait(3, 3000);
      const postStep3Resolution = await waitForResolvedStepAfterStep3(8000, 300);
      const postStep3DirectConsent = postStep3Resolution.resolvedStep === 8;
      await addLog(
        `Step 3 post-submit resolved next step ${postStep3Resolution.resolvedStep} from URL: ${postStep3Resolution.pageState?.url || 'unknown'}`,
        'info'
      );

      if (postStep3DirectConsent) {
        await addLog('Consent page detected directly after step 3; skipping steps 4, 5, 6 and 7', 'info');
        await skipStepBecauseConsentReady(4);
        await skipStepBecauseConsentReady(5);
        await skipStepBecauseConsentReady(6);
        await skipStepBecauseConsentReady(7);
      } else {
        if (postStep3Resolution.resolvedStep === 5) {
          await completeStepFromBackground(4, {
            skipped: true,
            reason: 'post_step3_resolved_to_step5',
            resolvedStep: 5,
            resolvedUrl: postStep3Resolution.pageState?.url || '',
          }, {
            logMessage: `Step 4 skipped: step 3 jumped directly to step 5 (${postStep3Resolution.pageState?.url || 'unknown url'})`,
          });
        } else {
          await executeStepAndWait(4, 2000);
        }
      }

      if (postStep3DirectConsent) {
        await addLog('Consent page already confirmed after step 3; continuing from step 8', 'info');
      } else if (await waitForConsentPageReady(8000, 300)) {
        await addLog('Consent page detected after step 4; skipping steps 5, 6 and 7', 'info');
        await skipStepBecauseConsentReady(5);
        await skipStepBecauseConsentReady(6);
        await skipStepBecauseConsentReady(7);
      } else {
        await executeStepAndWait(5, 3000);
        if (await waitForConsentPageReady()) {
          await addLog('Consent page detected after step 5; skipping steps 6 and 7', 'info');
          await skipStepBecauseConsentReady(6);
          await skipStepBecauseConsentReady(7);
        } else {
          await executeStepAndWait(6, 3000);
          await executeStepAndWait(7, 2000);
        }
      }
      await executeStepAndWait(8, 2000);
      await executeStepAndWait(9, 1000);

      await addLog(`=== Run ${run}/${totalRuns} COMPLETE! ===`, 'ok');

    } catch (err) {
      allRunsSucceeded = false;
      if (isStopError(err)) {
        await addLog(`Run ${run}/${totalRuns} stopped by user`, 'warn');
        chrome.runtime.sendMessage(status('stopped')).catch(() => {});
        break;
      }
      if (isRunTimeoutError(err)) {
        failedRuns += 1;
        await markRunningStepsFailed();
        await addLog(`Run ${run}/${totalRuns} failed: exceeded time limit`, 'error');
        const latestState = await getState();
        if (normalizeEmailProvider(latestState.emailProvider) === EMAIL_PROVIDER_HOTMAIL && latestState.currentHotmailDbEmail) {
          await markCurrentHotmailDbAccount('failed', {
            tag: 'failed-timeout',
            note: 'registration exceeded dynamic time limit',
            openaiPassword: latestState.password || null,
          });
        }
        continue;
      }

      failedRuns += 1;
      await addLog(`Run ${run}/${totalRuns} failed: ${err.message}`, 'error');
    } finally {
      clearRunTimeoutState();
    }
  }

  const completedRuns = autoRunCurrentRun;
  if (stopRequested) {
    await addLog(`=== Stopped after ${Math.max(0, completedRuns - 1)}/${autoRunTotalRuns} runs ===`, 'warn');
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'stopped', currentRun: completedRuns, totalRuns: autoRunTotalRuns } }).catch(() => {});
  } else if (allRunsSucceeded && completedRuns >= autoRunTotalRuns) {
    await addLog(`=== All ${autoRunTotalRuns} runs completed successfully ===`, 'ok');
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'complete', currentRun: completedRuns, totalRuns: autoRunTotalRuns } }).catch(() => {});
  } else if (completedRuns >= autoRunTotalRuns && failedRuns > 0) {
    const succeededRuns = Math.max(0, completedRuns - failedRuns);
    await addLog(`=== Auto run finished: ${succeededRuns} succeeded, ${failedRuns} failed ===`, 'warn');
    chrome.runtime.sendMessage({
      type: 'AUTO_RUN_STATUS',
      payload: { phase: 'complete', currentRun: completedRuns, totalRuns: autoRunTotalRuns, failedRuns, succeededRuns },
    }).catch(() => {});
  } else {
    await addLog(`=== Stopped after ${completedRuns}/${autoRunTotalRuns} runs ===`, 'warn');
    chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'stopped', currentRun: completedRuns, totalRuns: autoRunTotalRuns } }).catch(() => {});
  }
  autoRunActive = false;
  await setState({ autoRunning: false });
  await resetClaimedHotmailIfIdle({ force: true, reason: 'auto run finished' });
  clearStopRequest();
}

function waitForResume() {
  return new Promise((resolve, reject) => {
    throwIfStopped();
    resumeWaiter = { resolve, reject };
  });
}

async function resumeAutoRun() {
  throwIfStopped();
  const state = await getState();
  if (!state.email) {
    await addLog('Cannot resume: no email address. Paste email in Side Panel first.', 'error');
    return;
  }
  if (resumeWaiter) {
    resumeWaiter.resolve();
    resumeWaiter = null;
  }
}

// ============================================================
// Step 1: Get OAuth Link (via CPA management API)
// ============================================================

async function executeStep1(state) {
  if (!state.cpaBaseUrl) {
    throw new Error('No CPA address configured. Enter CPA in the side panel first.');
  }
  await addLog(`Step 1: Requesting OAuth URL from CPA API...`);
  const result = await callCpaApi('/v0/management/codex-auth-url?is_webui=true', {
    method: 'GET',
    timeoutMs: 20000,
  });
  if (result?.status !== 'ok' || !result?.url || !result?.state) {
    throw new Error(result?.error || result?.detail || 'CPA API did not return oauth url/state.');
  }
  await completeStepFromBackground(1, {
    oauthUrl: result.url,
    oauthState: result.state,
  }, {
    logMessage: `Step 1: OAuth URL obtained from CPA API`,
    logLevel: 'ok',
  });
}

// ============================================================
// Step 2: Open Signup Page (Background opens tab, signup-page.js clicks Register)
// ============================================================

async function executeStep2(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }
  await addLog(`Step 2: Opening auth URL...`);
  await reuseOrCreateTab('signup-page', state.oauthUrl, { reloadIfSameUrl: true });

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 2,
    source: 'background',
    payload: {},
  });
}

// ============================================================
// Step 3: Fill Email & Password (via signup-page.js)
// ============================================================

async function executeStep3(state) {
  const emailProvider = normalizeEmailProvider(state.emailProvider);
  let email = state.email;
  let signupPasswordSource = state.customPassword ? 'customized' : 'generated';

  if (is2925EmailProvider(emailProvider)) {
    const knownMainMailbox = parse2925MainEmail(state.mail2925MainEmail || '');

    if (knownMainMailbox?.email && is2925ChildEmailForMain(state.email, knownMainMailbox.email)) {
      email = state.email;
      await setState({ mailProvider: MAIL_PROVIDER_2925 });
      broadcastDataUpdate({ mailProvider: MAIL_PROVIDER_2925 });
      await addLog(`Step 3: Reusing 2925 child mailbox ${email}`, 'info');
    } else {
      const mainMailbox = await fetch2925MainEmailFromPage();
      email = await fetch2925ChildEmail({ generateNew: true, mainEmail: mainMailbox.email });
    }
  } else if (isRelayFirefoxProvider(emailProvider)) {
    if (state.activeRelayMask?.email) {
      email = state.activeRelayMask.email;
      await setEmailState(email);
      await addLog(`Step 3: Reusing Relay mask ${email}`, 'info');
    } else {
      email = await fetchRelayMaskEmail({ generateNew: true });
    }
  } else if (isCloudflareTempEmailProvider(emailProvider)) {
    const activeMailbox = state.activeCloudflareMailbox;
    const canReuseCloudflareMailbox = activeMailbox?.email
      && activeMailbox.email === state.email
      && (activeMailbox.provenance === 'created' || activeMailbox.provenance === 'manual_existing');

    if (canReuseCloudflareMailbox) {
      email = activeMailbox.email;
      await setEmailState(email);
      await addLog(`Step 3: Reusing Cloudflare Temp Email mailbox ${email}`, 'info');
    } else {
      email = await fetchCloudflareTempEmail({ generateNew: true });
    }
  } else if (isHotmailEmailProvider(emailProvider)) {
    if (shouldUseHotmailDbMode(state)) {
      if (!state.currentHotmailDbEmail) {
        const claimed = await claimNextHotmailDbAccount(state);
        if (!claimed?.email) {
          throw new Error('账号不足：数据库中没有可运行的 pending Hotmail 账号。');
        }
      }
      state = await getState();
    }
    if (state.hotmailEmail) {
      email = state.hotmailEmail.trim();
      await setEmailState(email);
      await setState({ mailProvider: MAIL_PROVIDER_HOTMAIL });
      broadcastDataUpdate({ mailProvider: MAIL_PROVIDER_HOTMAIL });
      await addLog(`Step 3: Reusing Hotmail account ${email}`, 'info');
    } else {
      email = await fetchHotmailEmail();
      await setState({ mailProvider: MAIL_PROVIDER_HOTMAIL });
      broadcastDataUpdate({ mailProvider: MAIL_PROVIDER_HOTMAIL });
    }
  } else if (!email) {
    throw new Error('No email address. Paste email in Side Panel first.');
  }

  let password = state.customPassword || generatePassword();
  if (isHotmailEmailProvider(emailProvider)) {
    const derivedPassword = deriveSignupPasswordFromEmailPassword(state.hotmailPassword);
    if (derivedPassword) {
      password = derivedPassword;
      signupPasswordSource = state.hotmailPassword.length >= 12 ? 'hotmail-same' : 'hotmail-repeated';
    } else if (!state.customPassword) {
      signupPasswordSource = 'generated';
    }
  }
  await setPasswordState(password);

  // Save account record
  const accounts = state.accounts || [];
  accounts.push({ email, password, emailProvider, createdAt: new Date().toISOString() });
  await setState({ accounts });

  await addLog(
    `Step 3: Filling email ${email}, password ${signupPasswordSource} (${password.length} chars)`
  );
  if (isHotmailEmailProvider(emailProvider)) {
    await addLog(`Step 3: Hotmail batch/email source in use => ${email}`, 'info');
  }
  const signupTabId = await getTabId('signup-page');
  if (signupTabId) {
    await chrome.tabs.update(signupTabId, { active: true });
  }
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 3,
    source: 'background',
    payload: { email, password },
  });
}

// ============================================================
// Step 4: Get Signup Verification Code (qq-mail.js polls, then fills in signup-page.js)
// ============================================================

function getMailConfig(state) {
  const provider = state.mailProvider || 'qq';
  if (provider === '2925') {
    return {
      source: 'mail-2925',
      url: 'https://www.2925.com/#/mailList',
      label: '2925 Mail',
    };
  }
  if (provider === '163') {
    return { source: 'mail-163', url: 'https://mail.163.com/js6/main.jsp?df=mail163_letter#module=mbox.ListModule%7C%7B%22fid%22%3A1%2C%22order%22%3A%22date%22%2C%22desc%22%3Atrue%7D', label: '163 Mail' };
  }
  if (provider === 'inbucket') {
    const host = normalizeInbucketOrigin(state.inbucketHost);
    const mailbox = (state.inbucketMailbox || '').trim();
    if (!host) {
      return { error: 'Inbucket host is empty or invalid.' };
    }
    if (!mailbox) {
      return { error: 'Inbucket mailbox name is empty.' };
    }
    return {
      source: 'inbucket-mail',
      url: `${host}/m/${encodeURIComponent(mailbox)}/`,
      label: `Inbucket Mailbox (${mailbox})`,
      navigateOnReuse: true,
      inject: ['content/utils.js', 'content/inbucket-mail.js'],
      injectSource: 'inbucket-mail',
    };
  }
  return { source: 'qq-mail', url: 'https://wx.mail.qq.com/', label: 'QQ Mail' };
}

function normalizeInbucketOrigin(rawValue) {
  const value = (rawValue || '').trim();
  if (!value) return '';

  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value) ? value : `https://${value}`;

  try {
    const parsed = new URL(candidate);
    return parsed.origin;
  } catch {
    return '';
  }
}

async function pollCodeFromCloudflareAdmin(step, state, options = {}) {
  if (!state.email) {
    throw new Error('No email. Complete step 3 first.');
  }
  const adminUrl = getCloudflareTempEmailAdminUrl(state);

  await addLog(`Step ${step}: Opening Cloudflare Temp Email admin...`);
  await reuseOrCreateTab('cloudflare-temp-email', adminUrl, {
    inject: CLOUDFLARE_TEMP_EMAIL_INJECT_FILES,
    injectSource: 'cloudflare-temp-email',
    reloadIfSameUrl: true,
  });

  const result = await sendToContentScript('cloudflare-temp-email', {
    type: 'POLL_EMAIL',
    step,
    source: 'background',
    reportStepError: false,
    payload: {
      filterAfterTimestamp: options.filterAfterTimestamp || 0,
      senderFilters: options.senderFilters || [],
      subjectFilters: options.subjectFilters || [],
      targetEmail: state.email,
      maxAttempts: options.maxAttempts || 20,
      intervalMs: options.intervalMs || 3000,
    },
  });

  if (result?.error) {
    throw new Error(result.error);
  }
  if (!result?.code) {
    throw new Error(`Cloudflare Temp Email did not return a verification code for step ${step}.`);
  }

  return result;
}

async function pollCodeFrom2925Mail(step, state, options = {}) {
  if (!state.email) {
    throw new Error('未找到当前子邮箱，请先执行 Step 3 生成 2925 子邮箱。');
  }

  const mail = getMailConfig({ ...state, mailProvider: MAIL_PROVIDER_2925 });
  await addLog(`Step ${step}: Opening ${mail.label}...`);
  await reuseOrCreateTab(mail.source, mail.url);

  const result = await sendToContentScript(mail.source, {
    type: 'POLL_2925_EMAIL',
    step,
    source: 'background',
    reportStepError: false,
    payload: {
      filterAfterTimestamp: options.filterAfterTimestamp || 0,
      senderFilters: options.senderFilters || [],
      subjectFilters: options.subjectFilters || [],
      targetEmail: state.email,
      maxAttempts: options.maxAttempts || 20,
      intervalMs: options.intervalMs || 3000,
    },
  });

  if (result?.error) {
    throw new Error(result.error);
  }
  if (!result?.code) {
    throw new Error(`2925 收件箱中暂未找到当前子邮箱的验证码邮件。`);
  }

  return result;
}

async function requestVerificationCodeResendFromSignupPage(step) {
  const signupTabId = await getTabId('signup-page');
  if (!signupTabId) {
    throw new Error('Signup page tab was closed. Cannot resend verification code.');
  }

  await chrome.tabs.update(signupTabId, { active: true });
  const resendTriggeredAt = Date.now();
  const result = await sendToContentScript('signup-page', {
    type: 'RESEND_CODE',
    step,
    source: 'background',
    reportStepError: false,
    payload: {},
  });

  if (result?.error) {
    throw new Error(result.error);
  }

  return resendTriggeredAt;
}

const STEP4_RESEND_POLL_MAX_ATTEMPTS = 10;
const STEP4_RESEND_MAX_RESENDS = 4;
const STEP7_RESEND_MAX_RESENDS = 2;

function shouldRetryHotmailStep7WithResend(errorMessage, resendCount, maxResends = STEP7_RESEND_MAX_RESENDS) {
  const message = String(errorMessage || '').replace(/\s+/g, ' ').trim();
  return Number(resendCount) < Number(maxResends)
    && /^No matching verification email was found in Hotmail\b/i.test(message);
}

async function executeStep4(state) {
  const postStep3Resolution = await waitForResolvedStepAfterStep3(3500, 250);
  if (postStep3Resolution.resolvedStep === 5) {
    await completeStepFromBackground(4, {
      skipped: true,
      reason: 'post_step3_resolved_to_step5',
      resolvedStep: 5,
      resolvedUrl: postStep3Resolution.pageState?.url || '',
    }, {
      logMessage: `Step 4 skipped: URL after step 3 resolved directly to step 5 (${postStep3Resolution.pageState?.url || 'unknown url'})`,
    });
    return;
  }

  if (postStep3Resolution.resolvedStep === 8) {
    await completeStepFromBackground(4, {
      skipped: true,
      reason: 'post_step3_resolved_to_step8',
      resolvedStep: 8,
      resolvedUrl: postStep3Resolution.pageState?.url || '',
    }, {
      logMessage: `Step 4 skipped: URL after step 3 resolved directly to consent (${postStep3Resolution.pageState?.url || 'unknown url'})`,
    });
    return;
  }

  let result = null;
  const emailProvider = normalizeEmailProvider(state.emailProvider);

  if (shouldUseHotmailForVerification(state)) {
    let resendCount = 0;
    let filterAfterTimestamp = state.flowStartTime || 0;

    while (!result) {
      try {
        result = await pollCodeFromHotmail(4, state, {
          filterAfterTimestamp,
          maxWaitSeconds: 90,
          pollIntervalSeconds: 5,
        });
      } catch (err) {
        if (!shouldRetryStep4VerificationWithResend({
          errorMessage: err.message,
          resendCount,
          maxResends: STEP4_RESEND_MAX_RESENDS,
          step: 4,
        })) {
          throw err;
        }

        const currentRound = resendCount + 1;
        const nextRound = currentRound + 1;
        resendCount += 1;
        await addLog(
          `Step 4: No verification email found after polling round ${currentRound}/5. Requesting resend ${resendCount}/4 and starting round ${nextRound}/5...`,
          'warn'
        );
        filterAfterTimestamp = await requestVerificationCodeResendFromSignupPage(4);
      }
    }
  } else if (is2925EmailProvider(emailProvider)) {
    let resendCount = 0;
    let filterAfterTimestamp = state.flowStartTime || 0;
    const pollOptions = {
      senderFilters: ['openai', 'noreply', 'verify', 'auth', 'duckduckgo', 'forward'],
      subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm'],
    };

    while (!result) {
      try {
        result = await pollCodeFrom2925Mail(4, state, {
          ...pollOptions,
          filterAfterTimestamp,
          maxAttempts: STEP4_RESEND_POLL_MAX_ATTEMPTS,
        });
      } catch (err) {
        if (!shouldRetryStep4VerificationWithResend({
          errorMessage: err.message,
          resendCount,
          maxResends: STEP4_RESEND_MAX_RESENDS,
          step: 4,
        })) {
          throw err;
        }

        const currentRound = resendCount + 1;
        const nextRound = currentRound + 1;
        resendCount += 1;
        await addLog(
          `Step 4: No verification email found after polling round ${currentRound}/5. Requesting resend ${resendCount}/4 and starting round ${nextRound}/5...`,
          'warn'
        );
        filterAfterTimestamp = await requestVerificationCodeResendFromSignupPage(4);
      }
    }
  } else if (isCloudflareTempEmailProvider(emailProvider)) {
    let resendCount = 0;
    let filterAfterTimestamp = state.flowStartTime || 0;
    const pollOptions = {
      senderFilters: ['openai', 'noreply', 'verify', 'auth', 'duckduckgo', 'forward'],
      subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm'],
    };

    while (!result) {
      try {
        result = await pollCodeFromCloudflareAdmin(4, state, {
          ...pollOptions,
          filterAfterTimestamp,
          maxAttempts: STEP4_RESEND_POLL_MAX_ATTEMPTS,
        });
      } catch (err) {
        if (!shouldRetryStep4VerificationWithResend({
          errorMessage: err.message,
          resendCount,
          maxResends: STEP4_RESEND_MAX_RESENDS,
          step: 4,
        })) {
          throw err;
        }

        const currentRound = resendCount + 1;
        const nextRound = currentRound + 1;
        resendCount += 1;
        await addLog(
          `Step 4: No verification email found after polling round ${currentRound}/5. Requesting resend ${resendCount}/4 and starting round ${nextRound}/5...`,
          'warn'
        );
        filterAfterTimestamp = await requestVerificationCodeResendFromSignupPage(4);
      }
    }
  } else {
    const mail = getMailConfig(state);
    if (mail.error) throw new Error(mail.error);
    await addLog(`Step 4: Opening ${mail.label}...`);

    // For mail tabs, only create if not alive — don't navigate (preserves login session)
    const alive = await isTabAlive(mail.source);
    if (alive) {
      if (mail.navigateOnReuse) {
        await reuseOrCreateTab(mail.source, mail.url, {
          inject: mail.inject,
          injectSource: mail.injectSource,
        });
      } else {
        const tabId = await getTabId(mail.source);
        await chrome.tabs.update(tabId, { active: true });
      }
    } else {
      await reuseOrCreateTab(mail.source, mail.url, {
        inject: mail.inject,
        injectSource: mail.injectSource,
      });
    }

    result = await sendToContentScript(mail.source, {
      type: 'POLL_EMAIL',
      step: 4,
      source: 'background',
      reportStepError: false,
      payload: {
        filterAfterTimestamp: state.flowStartTime || 0,
        senderFilters: ['openai', 'noreply', 'verify', 'auth', 'duckduckgo', 'forward'],
        subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm'],
        targetEmail: state.email,
        maxAttempts: 20,
        intervalMs: 3000,
      },
    });

    if (result && result.error) {
      throw new Error(result.error);
    }
  }

  if (result && result.code) {
    await setState({ lastEmailTimestamp: result.emailTimestamp });
    await setState({ lastVerificationCode: result.code });
    await addLog(`Step 4: Got verification code: ${result.code}`);

    // Switch to signup tab and fill code
    const signupTabId = await getTabId('signup-page');
    if (signupTabId) {
      await chrome.tabs.update(signupTabId, { active: true });
      await sendToContentScript('signup-page', {
        type: 'FILL_CODE',
        step: 4,
        source: 'background',
        reportStepError: false,
        payload: { code: result.code },
      });
    } else {
      throw new Error('Signup page tab was closed. Cannot fill verification code.');
    }
  }
}

// ============================================================
// Step 5: Fill Name & Birthday (via signup-page.js)
// ============================================================

async function executeStep5(state) {
  if (await isSignupConsentPageReady()) {
    await skipStepBecauseConsentReady(5);
    return;
  }

  const { firstName, lastName } = generateRandomName();
  const { year, month, day } = generateRandomBirthday();

  await addLog(`Step 5: Generated name: ${firstName} ${lastName}, Birthday: ${year}-${month}-${day}`);

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 5,
    source: 'background',
    payload: { firstName, lastName, year, month, day },
  });
}

// ============================================================
// Step 6: Login ChatGPT (Background opens tab, chatgpt.js handles login)
// ============================================================

async function executeStep6(state) {
  if (await isSignupConsentPageReady()) {
    await skipStepBecauseConsentReady(6);
    return;
  }

  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }
  if (!state.email) {
    throw new Error('No email. Complete step 3 first.');
  }

  await addLog(`Step 6: Opening OAuth URL for login...`);
  // Reuse the signup-page tab — navigate it to the OAuth URL
  await reuseOrCreateTab('signup-page', state.oauthUrl, { reloadIfSameUrl: true });

  // signup-page.js will inject (same auth.openai.com domain) and handle login
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 6,
    source: 'background',
    payload: { email: state.email, password: state.password },
  });
}

// ============================================================
// Step 7: Get Login Verification Code (qq-mail.js polls, then fills in chatgpt.js)
// ============================================================

async function executeStep7(state) {
  if (await isSignupConsentPageReady()) {
    await skipStepBecauseConsentReady(7);
    return;
  }

  if (await waitForConsentPageReady(8000, 300)) {
    await addLog('Step 7 skipped: consent page became ready without requiring a login verification code', 'info');
    await skipStepBecauseConsentReady(7);
    return;
  }

  let result = null;
  const emailProvider = normalizeEmailProvider(state.emailProvider);

  if (shouldUseHotmailForVerification(state)) {
    let resendCount = 0;
    let filterAfterTimestamp = state.lastEmailTimestamp || state.flowStartTime || 0;
    const excludeCodes = state.lastVerificationCode ? [state.lastVerificationCode] : [];

    while (!result) {
      try {
        result = await pollHotmailStep7WithActiveErrorRecovery(state, {
          filterAfterTimestamp,
          maxWaitSeconds: 90,
          pollIntervalSeconds: 5,
          excludeCodes,
        });
      } catch (err) {
        if (err?.message === STEP7_ERROR_PAGE_RECOVERY_ABORT_MESSAGE) {
          await addLog('Step 7: OpenAI timeout page detected during Hotmail polling. Retry clicked immediately; restarting polling...', 'warn');
          await sleepWithStop(1500);
          if (await waitForConsentPageReady(5000, 300)) {
            await addLog('Step 7 skipped after error-page retry: consent page became ready without a login verification code', 'info');
            await skipStepBecauseConsentReady(7);
            return;
          }
          continue;
        }

        if (await waitForConsentPageReady(5000, 300)) {
          await addLog('Step 7 skipped after retry wait: consent page became ready without a login verification code', 'info');
          await skipStepBecauseConsentReady(7);
          return;
        }

        if (!shouldRetryHotmailStep7WithResend(err.message, resendCount)) {
          throw err;
        }

        resendCount += 1;
        await addLog(
          `Step 7: No login verification email found. Requesting resend ${resendCount}/${STEP7_RESEND_MAX_RESENDS} and retrying Hotmail polling...`,
          'warn'
        );
        filterAfterTimestamp = await requestVerificationCodeResendFromSignupPage(7);
      }
    }
  } else if (is2925EmailProvider(emailProvider)) {
    result = await pollCodeFrom2925Mail(7, state, {
      filterAfterTimestamp: state.lastEmailTimestamp || state.flowStartTime || 0,
      senderFilters: ['openai', 'noreply', 'verify', 'auth', 'chatgpt', 'duckduckgo', 'forward'],
      subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm', 'login'],
    });
  } else if (isCloudflareTempEmailProvider(emailProvider)) {
    result = await pollCodeFromCloudflareAdmin(7, state, {
      filterAfterTimestamp: state.lastEmailTimestamp || state.flowStartTime || 0,
      senderFilters: ['openai', 'noreply', 'verify', 'auth', 'chatgpt', 'duckduckgo', 'forward'],
      subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm', 'login'],
    });
  } else {
    const mail = getMailConfig(state);
    if (mail.error) throw new Error(mail.error);
    await addLog(`Step 7: Opening ${mail.label}...`);

    const alive = await isTabAlive(mail.source);
    if (alive) {
      if (mail.navigateOnReuse) {
        await reuseOrCreateTab(mail.source, mail.url, {
          inject: mail.inject,
          injectSource: mail.injectSource,
        });
      } else {
        const tabId = await getTabId(mail.source);
        await chrome.tabs.update(tabId, { active: true });
      }
    } else {
      await reuseOrCreateTab(mail.source, mail.url, {
        inject: mail.inject,
        injectSource: mail.injectSource,
      });
    }

    result = await sendToContentScript(mail.source, {
      type: 'POLL_EMAIL',
      step: 7,
      source: 'background',
      reportStepError: false,
      payload: {
        filterAfterTimestamp: state.lastEmailTimestamp || state.flowStartTime || 0,
        senderFilters: ['openai', 'noreply', 'verify', 'auth', 'chatgpt', 'duckduckgo', 'forward'],
        subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm', 'login'],
        targetEmail: state.email,
        maxAttempts: 20,
        intervalMs: 3000,
      },
    });

    if (result && result.error) {
      throw new Error(result.error);
    }
  }

  if (result && result.code) {
    await addLog(`Step 7: Got login verification code: ${result.code}`);

    // Switch to signup/auth tab and fill code
    const signupTabId = await getTabId('signup-page');
    if (signupTabId) {
      await chrome.tabs.update(signupTabId, { active: true });
      const fillResult = await sendToContentScript('signup-page', {
        type: 'FILL_CODE',
        step: 7,
        source: 'background',
        reportStepError: false,
        payload: { code: result.code },
      });
      if (fillResult && fillResult.error) {
        throw new Error(fillResult.error);
      }

      const step7PostCheckResult = await confirmNoPhoneRequirementAfterStep7();
      if (step7PostCheckResult === 'fail') {
        await addLog('Step 7: phone number is required after verification submission; returning fail', 'error');
        throw new Error('fail');
      }
    } else {
      throw new Error('Auth page tab was closed. Cannot fill verification code.');
    }
  }
}

// ============================================================
// Step 8: Complete OAuth (auto click + localhost listener)
// ============================================================

let webNavListener = null;

async function executeStep8(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }

  await addLog('Step 8: Preparing consent confirmation...');

  return new Promise((resolve, reject) => {
    let resolved = false;
    let timeout = null;

    const cleanupListener = () => {
      if (webNavListener) {
        chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
        webNavListener = null;
      }
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
    };

    const finishStep8WithCallbackUrl = async (url) => {
      const matchedUrl = MultiPageOAuthFlow.findLoopbackCallbackUrl([url]);
      if (!matchedUrl || resolved) {
        return false;
      }
      resolved = true;
      cleanupListener();
      try {
        await completeStepFromBackground(8, { localhostUrl: matchedUrl }, {
          logMessage: `Step 8: Captured callback URL: ${matchedUrl}`,
          logLevel: 'ok',
        });
        resolve();
      } catch (err) {
        reject(err);
      }
      return true;
    };

    const startRedirectListener = () => {
      webNavListener = (details) => {
        if (MultiPageOAuthFlow.isLoopbackCallbackUrl(details.url)) {
          void finishStep8WithCallbackUrl(details.url);
        }
      };
      chrome.webNavigation.onBeforeNavigate.addListener(webNavListener);
      timeout = setTimeout(() => {
        cleanupListener();
        resolved = true;
        reject(new Error('Loopback callback URL not captured after 120s. Step 8 click may have been blocked.'));
      }, 120000);
    };

    (async () => {
      try {
        let signupTabId = await getTabId('signup-page');
        if (signupTabId) {
          await chrome.tabs.update(signupTabId, { active: true });
        } else {
          signupTabId = await reuseOrCreateTab('signup-page', state.oauthUrl);
        }

        const clickResult = await sendToContentScript('signup-page', {
          type: 'STEP8_FIND_AND_CLICK',
          source: 'background',
          payload: {},
        });
        if (clickResult?.error) {
          throw new Error(clickResult.error);
        }

        if (!resolved) {
          startRedirectListener();
          await addLog('Step 8: Localhost redirect listener ready. Dispatching debugger click...');
          await clickWithDebugger(signupTabId, clickResult?.rect);
          await addLog('Step 8: Debugger click dispatched, waiting for redirect...');

          (async () => {
            while (!resolved) {
              const tab = await chrome.tabs.get(signupTabId).catch(() => null);
              const matchedUrl = MultiPageOAuthFlow.findLoopbackCallbackUrl([tab?.url || '']);
              if (matchedUrl) {
                await finishStep8WithCallbackUrl(matchedUrl);
                return;
              }
              await new Promise((resume) => setTimeout(resume, 250));
            }
          })().catch((err) => {
            if (!resolved) {
              cleanupListener();
              reject(err);
            }
          });
        }
      } catch (err) {
        cleanupListener();
        reject(err);
      }
    })();
  });
}

async function executeStep9(state) {
  if (!state.localhostUrl) {
    throw new Error('No localhost URL. Complete step 8 first.');
  }
  if (!state.cpaBaseUrl) {
    throw new Error('CPA address not set. Please enter CPA in the side panel.');
  }
  if (!state.oauthState) {
    throw new Error('No oauth state found. Complete step 1 first.');
  }

  await addLog('Step 9: Uploading callback URL to CPA API...');
  await callCpaApi('/v0/management/oauth-callback', {
    method: 'POST',
    timeoutMs: 20000,
    body: {
      provider: 'codex',
      redirect_url: state.localhostUrl,
      state: state.oauthState,
    },
  });

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const statusResult = await callCpaApi(`/v0/management/get-auth-status?state=${encodeURIComponent(state.oauthState)}`, {
      method: 'GET',
      timeoutMs: 15000,
    });
    if (statusResult?.status === 'ok') {
      await completeStepFromBackground(9, { uploaded: true }, {
        logMessage: 'Step 9: CPA OAuth verification completed.',
        logLevel: 'ok',
      });
      return;
    }
    if (statusResult?.status === 'error') {
      throw new Error(statusResult.error || 'CPA reported oauth callback failure.');
    }
    await addLog(`Step 9: CPA status = ${statusResult?.status || 'wait'}, retrying...`, 'info');
    await sleepWithStop(2000);
  }

  throw new Error('Step 9 timed out while waiting for CPA OAuth status to become ok.');
}

// ============================================================
// Open Side Panel on extension icon click
// ============================================================

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
