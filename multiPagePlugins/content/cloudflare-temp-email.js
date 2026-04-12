// content/cloudflare-temp-email.js — Content script for Cloudflare Temp Email admin page

const CLOUDFLARE_TEMP_EMAIL_PREFIX = '[MultiPage:cloudflare-temp-email]';
const isTopFrame = window === window.top;

const {
  combineDistinctTextParts = (parts = []) => parts
    .map((part) => String(part || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((part, index, values) => values.indexOf(part) === index)
    .join(' '),
  extractVerificationCode = () => null,
  generateReadableLocalPart = () => `mp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 18),
  normalizeDomainSuffix = (value) => String(value || '').trim().replace(/^@+/, '').toLowerCase(),
  parseCloudflareMailboxCredential = () => null,
  pickRandomSuffix = (options = []) => normalizeDomainSuffix(options[0] || ''),
  selectVerificationMessage = () => null,
} = globalThis.MultiPageCloudflareTempEmail || {};

console.log(CLOUDFLARE_TEMP_EMAIL_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

if (!isTopFrame) {
  console.log(CLOUDFLARE_TEMP_EMAIL_PREFIX, 'Skipping child frame');
} else {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== 'CREATE_CLOUDFLARE_TEMP_EMAIL' && message.type !== 'POLL_EMAIL') {
      return;
    }

    resetStopState();

    const handler = message.type === 'CREATE_CLOUDFLARE_TEMP_EMAIL'
      ? createCloudflareTempEmail
      : pollCloudflareTempEmail;

    handler(message.step, message.payload || {}).then((result) => {
      sendResponse(result);
    }).catch((err) => {
      if (isStopError(err)) {
        if (message.step) {
          log(`Step ${message.step}: Stopped by user.`, 'warn');
        } else {
          log('Cloudflare Temp Email: Stopped by user.', 'warn');
        }
        sendResponse({ stopped: true, error: err.message });
        return;
      }

      if (message.reportStepError !== false && message.step) {
        reportError(message.step, err.message);
      }
      sendResponse({ error: err.message });
    });

    return true;
  });

  function getElementText(el) {
    return combineDistinctTextParts([
      el?.innerText,
      el?.textContent,
      el?.getAttribute?.('aria-label'),
      el?.getAttribute?.('title'),
      el?.value,
    ]);
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeEmail(value) {
    return normalizeText(value).toLowerCase();
  }

  function isVisible(el) {
    if (!el) return false;
    if (el.hidden) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    return Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function findVisibleButton(pattern) {
    return Array.from(document.querySelectorAll('button'))
      .filter(isVisible)
      .find((button) => pattern.test(normalizeText(getElementText(button))));
  }

  function findVisibleTab(pattern, occurrence = 'first') {
    const tabs = Array.from(document.querySelectorAll('.n-tabs-tab'))
      .filter(isVisible)
      .filter((tab) => pattern.test(normalizeText(getElementText(tab))));

    return occurrence === 'last' ? tabs[tabs.length - 1] || null : tabs[0] || null;
  }

  async function waitForCondition(predicate, timeout, message) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeout) {
      throwIfStopped();
      const value = predicate();
      if (value) {
        return value;
      }
      await sleep(150);
    }

    throw new Error(message);
  }

  async function clickTab(pattern, occurrence = 'first', timeout = 10000) {
    await waitForCondition(
      () => findVisibleTab(pattern, occurrence),
      timeout,
      `Timed out waiting for tab ${pattern}`
    );

    const tab = findVisibleTab(pattern, occurrence);
    if (!tab) {
      throw new Error(`Could not find tab ${pattern}`);
    }

    await humanPause(120, 260);
    simulateClick(tab);
    await sleep(400);
    return tab;
  }

  function getCreateAddressInput() {
    return Array.from(document.querySelectorAll('input[placeholder="请输入"]')).find(isVisible) || null;
  }

  function getPrefixSwitch() {
    return Array.from(document.querySelectorAll('[role="switch"], .n-switch')).find(isVisible) || null;
  }

  function getCreateInputGroup() {
    return getCreateAddressInput()?.closest('.n-input-group') || null;
  }

  function getCreateDomainSelect() {
    const group = getCreateInputGroup();

    return Array.from(group?.querySelectorAll('.n-base-selection') || []).find(isVisible)
      || Array.from(group?.querySelectorAll('.n-select') || []).find(isVisible)
      || null;
  }

  function getCurrentDomain() {
    const groupText = normalizeText(getCreateInputGroup()?.textContent || '');
    const match = groupText.match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
    return normalizeDomainSuffix(match ? match[1] : '');
  }

  function getVisibleDomainOptionEntries() {
    const seen = new Set();
    const entries = [];

    for (const option of Array.from(document.querySelectorAll('.n-base-select-option, [role="option"]'))) {
      if (!isVisible(option)) {
        continue;
      }

      const value = normalizeDomainSuffix(getElementText(option));
      if (!value || seen.has(value)) {
        continue;
      }

      seen.add(value);
      entries.push({ option, value });
    }

    return entries;
  }

  async function ensureCreateAccountPage() {
    await clickTab(/^账号$/, 'first');
    await clickTab(/^创建账号$/);
    await waitForCondition(
      () => getCreateAddressInput(),
      10000,
      'Cloudflare Temp Email create form did not load.'
    );
  }

  async function ensureMailPage() {
    await clickTab(/^邮件$/, 'first');
    await clickTab(/^邮件$/, 'last');
    await waitForCondition(
      () => document.querySelector('input[placeholder="留空查询所有地址"]'),
      10000,
      'Cloudflare Temp Email mail page did not load.'
    );
  }

  async function ensurePrefixDisabled() {
    const prefixSwitch = getPrefixSwitch();
    if (!prefixSwitch) {
      log('Cloudflare Temp Email: Prefix switch not present, assuming prefix is already disabled', 'info');
      return;
    }

    if (prefixSwitch.getAttribute('aria-checked') === 'true') {
      await humanPause(120, 280);
      simulateClick(prefixSwitch);
      await waitForCondition(
        () => prefixSwitch.getAttribute('aria-checked') === 'false',
        5000,
        'Cloudflare Temp Email prefix switch did not turn off.'
      );
      log('Cloudflare Temp Email: Prefix disabled', 'ok');
    }
  }

  async function selectRandomDomainSuffix() {
    const domainSelect = await waitForCondition(
      () => getCreateDomainSelect(),
      5000,
      'Could not find the Cloudflare Temp Email suffix selector.'
    );

    await humanPause(120, 260);
    simulateClick(domainSelect);
    await sleep(300);

    const optionEntries = await waitForCondition(
      () => {
        const entries = getVisibleDomainOptionEntries();
        return entries.length > 0 ? entries : null;
      },
      5000,
      'Could not find any available Cloudflare Temp Email suffix options.'
    );

    const suffix = pickRandomSuffix(optionEntries.map((entry) => entry.value));
    const selectedEntry = optionEntries.find((entry) => entry.value === suffix);

    if (!suffix || !selectedEntry?.option) {
      throw new Error('Could not choose a Cloudflare Temp Email suffix from the available options.');
    }

    await humanPause(120, 260);
    simulateClick(selectedEntry.option);
    await waitForCondition(
      () => getCurrentDomain() === suffix,
      5000,
      `Cloudflare Temp Email suffix did not switch to ${suffix}.`
    );

    log(`Cloudflare Temp Email: Selected suffix ${suffix}`, 'info');
    return suffix;
  }

  function generateLocalPart() {
    return generateReadableLocalPart();
  }

  function findCredentialDialog() {
    return Array.from(
      document.querySelectorAll('[role="dialog"], .n-dialog, .n-modal, .n-base-modal, .n-card')
    ).find((el) => isVisible(el) && /邮箱地址凭证/.test(getElementText(el)));
  }

  function extractCredentialToken(root) {
    if (!root) return '';

    const candidates = [
      getElementText(root),
      ...Array.from(root.querySelectorAll('textarea, input, pre, code')).map((el) => el.value || el.textContent || ''),
    ];

    for (const candidate of candidates) {
      const match = String(candidate || '').match(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
      if (match) {
        return match[0];
      }
    }

    return '';
  }

  async function waitForCredentialDetails(timeout = 15000) {
    return waitForCondition(() => {
      const dialog = findCredentialDialog();
      const token = extractCredentialToken(dialog);
      const credential = parseCloudflareMailboxCredential(token);
      if (!credential?.email) {
        return null;
      }
      return credential;
    }, timeout, 'Timed out waiting for Cloudflare Temp Email credential dialog.');
  }

  async function dismissCredentialDialog() {
    const dialog = findCredentialDialog();
    if (!dialog) return;

    const closeButton = Array.from(dialog.querySelectorAll('button, .n-base-close'))
      .find((el) => isVisible(el) && (/关闭|确定|取消/.test(getElementText(el)) || el.classList?.contains('n-base-close')));

    if (closeButton) {
      simulateClick(closeButton);
      await sleep(300);
      return;
    }

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(300);
  }

  async function createCloudflareTempEmail(step, payload = {}) {
    const { generateNew = true } = payload;

    await ensureCreateAccountPage();
    await ensurePrefixDisabled();
    await selectRandomDomainSuffix();

    const input = getCreateAddressInput();
    if (!input) {
      throw new Error('Could not find the Cloudflare Temp Email address input.');
    }

    const createButton = findVisibleButton(/^创建新邮箱$/);
    if (!createButton) {
      throw new Error('Could not find the "创建新邮箱" button.');
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      const localPart = generateLocalPart();
      fillInput(input, localPart);
      await humanPause(120, 260);
      simulateClick(createButton);
      log(`Cloudflare Temp Email: Creating mailbox attempt ${attempt}`, 'info');

      try {
        const credential = await waitForCredentialDetails(10000);
        await dismissCredentialDialog();

        return {
          ...credential,
          domain: credential.domain || getCurrentDomain(),
          generated: Boolean(generateNew),
        };
      } catch (err) {
        if (attempt === 3) {
          throw err;
        }
        log(`Cloudflare Temp Email: Mailbox attempt ${attempt} did not complete, retrying`, 'warn');
        await dismissCredentialDialog().catch(() => {});
        await sleep(500);
      }
    }

    throw new Error('Cloudflare Temp Email mailbox creation did not succeed.');
  }

  function getMessageRows() {
    return Array.from(document.querySelectorAll('.n-thing')).filter(isVisible);
  }

  function parseMessageRow(row) {
    const rowText = row?.innerText || getElementText(row);
    const subject = normalizeText(
      row.querySelector('.n-thing-header__title')?.textContent
        || row.querySelector('h3, h4, h2')?.textContent
        || ''
    );
    const messageId = rowText.match(/ID:\s*([^\s]+)/i)?.[1] || null;
    const timestampText = rowText.match(/\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}:\d{2}/)?.[0] || '';
    const sender = normalizeText(rowText.match(/FROM:\s*([^\n]+)/i)?.[1] || '');
    const matchedEmail = normalizeEmail(rowText.match(/TO:\s*([^\n]+)/i)?.[1] || '');

    return {
      combinedText: normalizeText(rowText),
      emailTimestamp: null,
      matchedEmail,
      messageId,
      row,
      sender,
      subject,
      timestampText,
    };
  }

  function findMessageDetailRoot() {
    const deleteButton = Array.from(document.querySelectorAll('button'))
      .find((button) => isVisible(button) && /^删除$/.test(normalizeText(getElementText(button))));

    let current = deleteButton?.parentElement || null;
    while (current && current !== document.body) {
      const text = getElementText(current);
      if (/FROM:/i.test(text) && /TO:/i.test(text)) {
        return current;
      }
      current = current.parentElement;
    }

    return null;
  }

  async function openMessageRow(row, subject) {
    await humanPause(80, 180);
    simulateClick(row);
    await waitForCondition(() => {
      const detailRoot = findMessageDetailRoot();
      const detailText = normalizeText(getElementText(detailRoot));
      if (!detailText) return null;
      if (!subject || detailText.includes(subject)) {
        return detailRoot;
      }
      return null;
    }, 4000, `Timed out opening message ${subject || ''}`.trim());
  }

  function buildMessageDetailText() {
    return normalizeText(getElementText(findMessageDetailRoot()));
  }

  async function collectMessagesForTarget(targetEmail) {
    const normalizedTargetEmail = normalizeEmail(targetEmail);
    const rows = getMessageRows();
    const messages = [];

    for (const row of rows) {
      const message = parseMessageRow(row);
      if (!message.matchedEmail || message.matchedEmail !== normalizedTargetEmail) {
        continue;
      }

      if (!extractVerificationCode(`${message.subject} ${message.combinedText}`)) {
        await openMessageRow(row, message.subject);
        message.combinedText = `${message.combinedText} ${buildMessageDetailText()}`.trim();
      }

      messages.push(message);
    }

    return messages;
  }

  async function runMailQuery(targetEmail) {
    const queryInput = document.querySelector('input[placeholder="留空查询所有地址"]');
    if (!queryInput) {
      throw new Error('Could not find the admin mail query input.');
    }

    const queryButton = findVisibleButton(/^查询$/);
    if (!queryButton) {
      throw new Error('Could not find the admin mail query button.');
    }

    fillInput(queryInput, targetEmail);
    await humanPause(80, 180);
    simulateClick(queryButton);
    await sleep(800);
  }

  async function refreshMailList() {
    const refreshButton = findVisibleButton(/^刷新$/);
    if (!refreshButton) {
      throw new Error('Could not find the admin mail refresh button.');
    }

    simulateClick(refreshButton);
    await sleep(1000);
  }

  async function pollCloudflareTempEmail(step, payload = {}) {
    const {
      filterAfterTimestamp = 0,
      intervalMs = 3000,
      maxAttempts = 20,
      senderFilters = [],
      subjectFilters = [],
      targetEmail = '',
    } = payload;

    if (!targetEmail) {
      throw new Error('No target email provided for Cloudflare Temp Email polling.');
    }

    await ensureMailPage();
    await runMailQuery(targetEmail);

    log(`Step ${step}: Starting Cloudflare Temp Email poll for ${targetEmail}`, 'info');

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      log(`Step ${step}: Polling Cloudflare Temp Email... attempt ${attempt}/${maxAttempts}`, 'info');
      await refreshMailList();

      const messages = await collectMessagesForTarget(targetEmail);
      const match = selectVerificationMessage(messages, {
        filterAfterTimestamp,
        senderFilters,
        subjectFilters,
        targetEmail,
      });

      if (match?.code) {
        log(
          `Step ${step}: Code found: ${match.code} (subject: ${(match.subject || '').slice(0, 60)})`,
          'ok'
        );
        return {
          ok: true,
          code: match.code,
          emailTimestamp: match.emailTimestamp,
          matchedEmail: match.matchedEmail,
          messageId: match.messageId,
          subject: match.subject,
        };
      }

      if (attempt < maxAttempts) {
        await sleep(intervalMs);
      }
    }

    const newerSuffix = Number(filterAfterTimestamp) > 0
      ? ' newer than the previous verification message'
      : '';

    throw new Error(
      `No matching verification email${newerSuffix} was found for ${targetEmail} after ${(maxAttempts * intervalMs / 1000).toFixed(0)}s.`
    );
  }
}
