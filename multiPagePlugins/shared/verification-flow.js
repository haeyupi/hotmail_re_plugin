(function attachVerificationFlowHelpers(globalScope) {
  function normalizeActionLabel(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function isVerificationPollingTimeoutError(errorMessage) {
    const message = String(errorMessage || '')
      .replace(/\s+/g, ' ')
      .trim();

    return /^No matching verification email\b/i.test(message)
      || /暂未找到.*验证码邮件。?$/u.test(message);
  }

  function shouldRetryStep4VerificationWithResend(options = {}) {
    const {
      errorMessage = '',
      resendCount = 0,
      maxResends = 4,
      step = 0,
    } = options;

    return Number(step) === 4
      && Number(resendCount) < Number(maxResends)
      && isVerificationPollingTimeoutError(errorMessage);
  }

  function isResendVerificationButtonLabel(value) {
    const label = normalizeActionLabel(value);
    if (!label) {
      return false;
    }

    return /^(?:resend(?: verification)?(?: code| email)?|send again|send (?:another|a new|new) code|重新发送(?:验证码)?|重发(?:验证码)?|再次发送(?:验证码)?|重新获取(?:验证码)?)$/i.test(label);
  }

  const api = {
    isResendVerificationButtonLabel,
    isVerificationPollingTimeoutError,
    normalizeActionLabel,
    shouldRetryStep4VerificationWithResend,
  };

  globalScope.MultiPageVerificationFlow = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
