(function attachQQMailHelpers(globalScope) {
  function normalizeText(value) {
    return (value || '').toLowerCase();
  }

  function extractVerificationCode(text) {
    const matchCn = text.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
    if (matchCn) return matchCn[1];

    const matchEn = text.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
    if (matchEn) return matchEn[1] || matchEn[2];

    const match6 = text.match(/\b(\d{6})\b/);
    if (match6) return match6[1];

    return null;
  }

  function findNewQQVerificationCode(messages = [], options = {}) {
    const existingMailIds = new Set(options.existingMailIds || []);
    const senderFilters = options.senderFilters || [];
    const subjectFilters = options.subjectFilters || [];

    for (const message of messages) {
      const mailId = message.mailId || '';
      if (!mailId || existingMailIds.has(mailId)) {
        continue;
      }

      const sender = normalizeText(message.sender);
      const subject = normalizeText(message.subject);
      const digest = message.digest || '';

      const senderMatch = senderFilters.some((filter) => sender.includes(normalizeText(filter)));
      const subjectMatch = subjectFilters.some((filter) => subject.includes(normalizeText(filter)));

      if (!senderMatch && !subjectMatch) {
        continue;
      }

      const code = extractVerificationCode(`${message.subject || ''} ${digest}`);
      if (!code) {
        continue;
      }

      return {
        code,
        mailId,
        source: 'new',
        subject: message.subject || '',
      };
    }

    return null;
  }

  const api = {
    extractVerificationCode,
    findNewQQVerificationCode,
  };

  globalScope.MultiPageQQMail = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
