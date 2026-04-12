(function attachEmailProviderHelpers(globalScope) {
  const DEFAULT_CLOUDFLARE_TEMP_EMAIL_ADMIN_URL = 'https://mail.cloudflare.com/admin';
  const DEFAULT_HOTMAIL_API_BASE_URL = 'http://127.0.0.1:8001';
  const EMAIL_PROVIDER_2925 = 'mail_2925';
  const EMAIL_PROVIDER_DUCK = 'duckduckgo';
  const EMAIL_PROVIDER_HOTMAIL = 'hotmail';
  const MAIL_PROVIDER_2925 = '2925';
  const MAIL_PROVIDER_CLOUDFLARE_TEMP_EMAIL = 'cloudflare_temp_email';
  const MAIL_PROVIDER_HOTMAIL = 'hotmail';
  const EMAIL_PROVIDER_RELAY_FIREFOX = 'relay_firefox';
  const EMAIL_PROVIDER_CLOUDFLARE_TEMP_EMAIL = 'cloudflare_temp_email';

  function normalizeEmailProvider(value) {
    if (value === EMAIL_PROVIDER_2925) {
      return EMAIL_PROVIDER_2925;
    }
    if (value === EMAIL_PROVIDER_RELAY_FIREFOX) {
      return EMAIL_PROVIDER_RELAY_FIREFOX;
    }
    if (value === EMAIL_PROVIDER_CLOUDFLARE_TEMP_EMAIL) {
      return EMAIL_PROVIDER_CLOUDFLARE_TEMP_EMAIL;
    }
    if (value === EMAIL_PROVIDER_HOTMAIL) {
      return EMAIL_PROVIDER_HOTMAIL;
    }
    return EMAIL_PROVIDER_DUCK;
  }

  function isRelayFirefoxProvider(value) {
    return normalizeEmailProvider(value) === EMAIL_PROVIDER_RELAY_FIREFOX;
  }

  function is2925EmailProvider(value) {
    return normalizeEmailProvider(value) === EMAIL_PROVIDER_2925;
  }

  function isCloudflareTempEmailProvider(value) {
    return normalizeEmailProvider(value) === EMAIL_PROVIDER_CLOUDFLARE_TEMP_EMAIL;
  }

  function isHotmailEmailProvider(value) {
    return normalizeEmailProvider(value) === EMAIL_PROVIDER_HOTMAIL;
  }

  function getEmailProviderDisplayName(value) {
    if (is2925EmailProvider(value)) {
      return '2925邮箱';
    }
    if (isRelayFirefoxProvider(value)) {
      return 'Firefox Relay';
    }
    if (isCloudflareTempEmailProvider(value)) {
      return 'Cloudflare Temp Email';
    }
    if (isHotmailEmailProvider(value)) {
      return 'Hotmail';
    }
    return 'DuckDuckGo';
  }

  function shouldUseEmailSourceForVerification(value) {
    return is2925EmailProvider(value)
      || isCloudflareTempEmailProvider(value)
      || isHotmailEmailProvider(value);
  }

  function shouldSkipStep9Cleanup(value) {
    return !isRelayFirefoxProvider(value);
  }

  function normalizeCloudflareTempEmailAdminUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return DEFAULT_CLOUDFLARE_TEMP_EMAIL_ADMIN_URL;
    }

    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;

    try {
      const parsed = new URL(candidate);
      parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
      return parsed.toString();
    } catch {
      return DEFAULT_CLOUDFLARE_TEMP_EMAIL_ADMIN_URL;
    }
  }

  function normalizeHotmailApiBaseUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return DEFAULT_HOTMAIL_API_BASE_URL;
    }

    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;

    try {
      const parsed = new URL(candidate);
      parsed.pathname = parsed.pathname.replace(/\/+$/, '');
      parsed.hash = '';
      parsed.search = '';
      return parsed.toString().replace(/\/$/, '');
    } catch {
      return DEFAULT_HOTMAIL_API_BASE_URL;
    }
  }

  function getNextRelayMaskLabel(labels = []) {
    const used = new Set();

    for (const rawLabel of labels) {
      const match = String(rawLabel || '').trim().match(/^t(\d+)$/i);
      if (!match) continue;
      const nextValue = Number(match[1]);
      if (Number.isInteger(nextValue) && nextValue > 0) {
        used.add(nextValue);
      }
    }

    let candidate = 1;
    while (used.has(candidate)) {
      candidate += 1;
    }
    return `t${candidate}`;
  }

  const api = {
    DEFAULT_CLOUDFLARE_TEMP_EMAIL_ADMIN_URL,
    DEFAULT_HOTMAIL_API_BASE_URL,
    EMAIL_PROVIDER_2925,
    EMAIL_PROVIDER_CLOUDFLARE_TEMP_EMAIL,
    EMAIL_PROVIDER_DUCK,
    EMAIL_PROVIDER_HOTMAIL,
    EMAIL_PROVIDER_RELAY_FIREFOX,
    MAIL_PROVIDER_2925,
    MAIL_PROVIDER_CLOUDFLARE_TEMP_EMAIL,
    MAIL_PROVIDER_HOTMAIL,
    getEmailProviderDisplayName,
    getNextRelayMaskLabel,
    is2925EmailProvider,
    isCloudflareTempEmailProvider,
    isHotmailEmailProvider,
    isRelayFirefoxProvider,
    normalizeCloudflareTempEmailAdminUrl,
    normalizeHotmailApiBaseUrl,
    normalizeEmailProvider,
    shouldUseEmailSourceForVerification,
    shouldSkipStep9Cleanup,
  };

  globalScope.MultiPageEmailProvider = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
