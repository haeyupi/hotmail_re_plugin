(function attachOAuthFlowHelpers(globalScope) {
  const EXACT_CONSENT_PATH = '/sign-in-with-chatgpt/codex/consent';
  const SIGN_IN_WITH_CHATGPT_PATH_SEGMENT = '/sign-in-with-chatgpt/';

  function parseUrl(input) {
    if (!input || typeof input !== 'string') {
      return null;
    }

    try {
      return new URL(input);
    } catch {
      return null;
    }
  }

  function isConsentUrl(url) {
    const parsed = parseUrl(url);
    if (!parsed) {
      return false;
    }

    return parsed.pathname === EXACT_CONSENT_PATH;
  }

  function isConsentPageState(state = {}) {
    const { hasVisibleContinueButton = false, url = '' } = state;
    if (isConsentUrl(url)) {
      return true;
    }

    const parsed = parseUrl(url);
    if (!parsed) {
      return false;
    }

    return parsed.pathname.includes(SIGN_IN_WITH_CHATGPT_PATH_SEGMENT) && Boolean(hasVisibleContinueButton);
  }

  function hasAnyConsentPageState(states = []) {
    return states.some((state) => isConsentPageState(state));
  }

  function isLoopbackCallbackUrl(url) {
    const parsed = parseUrl(url);
    if (!parsed) {
      return false;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    return parsed.hostname === 'localhost'
      || parsed.hostname === '127.0.0.1'
      || parsed.hostname === '::1'
      || parsed.hostname === '[::1]';
  }

  function findLoopbackCallbackUrl(candidates = []) {
    for (const candidate of candidates) {
      if (isLoopbackCallbackUrl(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  const api = {
    EXACT_CONSENT_PATH,
    SIGN_IN_WITH_CHATGPT_PATH_SEGMENT,
    findLoopbackCallbackUrl,
    hasAnyConsentPageState,
    isConsentPageState,
    isConsentUrl,
    isLoopbackCallbackUrl,
  };

  globalScope.MultiPageOAuthFlow = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
