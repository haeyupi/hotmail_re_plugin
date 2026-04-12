// content/relay-firefox.js — Content script for Firefox Relay profile page

console.log('[MultiPage:relay-firefox] Content script loaded on', location.href);

const {
  getNextRelayMaskLabel = (labels = []) => `t${labels.length + 1}`,
} = globalThis.MultiPageEmailProvider || {};

const LABEL_INPUT_SELECTOR = 'input[placeholder="Add account name"], input[aria-label="Edit the label for this mask"]';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'CREATE_RELAY_MASK' && message.type !== 'DELETE_RELAY_MASK') return;

  resetStopState();

  const handler = message.type === 'CREATE_RELAY_MASK'
    ? createRelayMask
    : deleteRelayMask;

  handler(message.payload || {}).then(result => {
    sendResponse(result);
  }).catch(err => {
    if (isStopError(err)) {
      log('Relay: Stopped by user.', 'warn');
      sendResponse({ stopped: true, error: err.message });
      return;
    }
    sendResponse({ error: err.message });
  });

  return true;
});

function getElementText(el) {
  return [
    el?.innerText,
    el?.textContent,
    el?.getAttribute?.('aria-label'),
    el?.getAttribute?.('title'),
    el?.getAttribute?.('description'),
  ].filter(Boolean).join(' ');
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

function extractMozmail(text) {
  const match = String(text || '').match(/[A-Z0-9._%+-]+@mozmail\.com/i);
  return match ? match[0].toLowerCase() : '';
}

function getMaskButtons(root = document) {
  return Array.from(root.querySelectorAll('button')).filter((button) => extractMozmail(getElementText(button)));
}

function getMaskEmails(root = document) {
  return Array.from(new Set(
    getMaskButtons(root)
      .map((button) => extractMozmail(getElementText(button)))
      .filter(Boolean)
  ));
}

function getVisibleLabelInputs(root = document) {
  return Array.from(root.querySelectorAll(LABEL_INPUT_SELECTOR)).filter(isVisible);
}

function getExistingLabels() {
  return Array.from(document.querySelectorAll(LABEL_INPUT_SELECTOR))
    .map((input) => input.value.trim())
    .filter(Boolean);
}

function findGenerateButton() {
  return document.querySelector('button[title="Generate new mask"]')
    || Array.from(document.querySelectorAll('button')).find((button) => /generate new mask/i.test(getElementText(button)));
}

function findDeleteButton(root) {
  return Array.from(root.querySelectorAll('button')).find((button) => /^delete$/i.test(getElementText(button).trim()));
}

function getMaskButtonsIn(root) {
  return Array.from(root.querySelectorAll('button')).filter((button) => extractMozmail(getElementText(button)));
}

function findMaskContainerForButton(button) {
  let current = button?.parentElement || null;

  while (current && current !== document.body) {
    const maskButtons = getMaskButtonsIn(current);
    if (maskButtons.length === 1 && (current.querySelector(LABEL_INPUT_SELECTOR) || findDeleteButton(current))) {
      return current;
    }
    current = current.parentElement;
  }

  return button?.closest('li') || button?.parentElement || null;
}

function findMaskRowByEmail(email) {
  const normalizedEmail = String(email || '').toLowerCase();
  const button = getMaskButtons().find((candidate) => extractMozmail(getElementText(candidate)) === normalizedEmail);
  if (!button) return null;
  return findMaskContainerForButton(button);
}

async function waitForNewMaskEmail(previousEmails = new Set(), timeout = 15000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    throwIfStopped();
    const currentEmails = getMaskEmails();
    const nextEmail = currentEmails.find((email) => !previousEmails.has(email));
    if (nextEmail) {
      return nextEmail;
    }
    await sleep(150);
  }

  throw new Error('Timed out waiting for a new Relay mask to appear.');
}

async function waitForMaskRow(email, timeout = 10000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    throwIfStopped();
    const row = findMaskRowByEmail(email);
    if (row) {
      return row;
    }
    await sleep(150);
  }

  throw new Error(`Timed out waiting for Relay mask row: ${email}`);
}

async function assignRelayLabel(maskRow) {
  const labelInput = Array.from(maskRow.querySelectorAll(LABEL_INPUT_SELECTOR)).find(isVisible)
    || maskRow.querySelector(LABEL_INPUT_SELECTOR);

  if (!labelInput) {
    throw new Error('Could not find Relay label input for the new mask.');
  }

  const currentValue = labelInput.value.trim();
  if (currentValue) {
    return currentValue;
  }

  const nextLabel = getNextRelayMaskLabel(getExistingLabels());

  await humanPause(200, 450);
  fillInput(labelInput, nextLabel);
  labelInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  labelInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
  labelInput.blur();

  for (let i = 0; i < 20; i++) {
    throwIfStopped();
    const labels = getExistingLabels();
    if (labels.includes(nextLabel) || labelInput.value.trim() === nextLabel) {
      log(`Relay: Assigned label ${nextLabel}`, 'ok');
      return nextLabel;
    }
    await sleep(150);
  }

  throw new Error(`Relay label ${nextLabel} was not saved.`);
}

async function createRelayMask(payload = {}) {
  const { generateNew = true } = payload;

  log(`Relay: ${generateNew ? 'Creating' : 'Reading'} mask...`);
  await waitForElement(LABEL_INPUT_SELECTOR + ', button[title="Generate new mask"]', 20000);

  const previousEmails = new Set(getMaskEmails());
  if (!generateNew && previousEmails.size > 0) {
    const email = Array.from(previousEmails)[0];
    return { email, label: null, generated: false };
  }

  const generatorButton = findGenerateButton();
  if (!generatorButton) {
    throw new Error('Could not find "Generate new mask" button on Firefox Relay.');
  }

  await humanPause(500, 1200);
  simulateClick(generatorButton);
  log('Relay: Clicked "Generate new mask"');

  const email = await waitForNewMaskEmail(previousEmails);
  const maskRow = await waitForMaskRow(email);
  const label = await assignRelayLabel(maskRow);

  log(`Relay: Ready mask ${email}`, 'ok');
  return { email, label, generated: true };
}

function findVisibleDialogDeleteButton() {
  const dialogButtons = Array.from(document.querySelectorAll('[role="dialog"] button, dialog button, [aria-modal="true"] button'));
  return dialogButtons.find((button) => isVisible(button) && /delete|confirm|remove/i.test(getElementText(button)));
}

async function waitForMaskRemoval(email, timeout = 15000) {
  const startedAt = Date.now();
  const normalizedEmail = String(email || '').toLowerCase();

  while (Date.now() - startedAt < timeout) {
    throwIfStopped();
    const exists = getMaskEmails().includes(normalizedEmail);
    if (!exists) {
      return;
    }
    await sleep(200);
  }

  throw new Error(`Timed out waiting for Relay mask deletion: ${email}`);
}

async function deleteRelayMask(payload = {}) {
  const email = String(payload.email || '').trim().toLowerCase();
  if (!email) {
    throw new Error('No Relay mask email provided for deletion.');
  }

  log(`Relay: Deleting ${email}...`);
  await waitForElement(LABEL_INPUT_SELECTOR + ', button[title="Generate new mask"]', 20000);

  const maskRow = await waitForMaskRow(email);
  const detailsButton = Array.from(maskRow.querySelectorAll('button')).find((button) => /show mask details/i.test(getElementText(button)));
  if (detailsButton && isVisible(detailsButton)) {
    await humanPause(150, 300);
    simulateClick(detailsButton);
    await sleep(250);
  }

  const deleteButton = findDeleteButton(maskRow);
  if (!deleteButton) {
    throw new Error(`Could not find Delete button for Relay mask ${email}.`);
  }

  await humanPause(200, 400);
  simulateClick(deleteButton);

  await sleep(300);
  const confirmButton = findVisibleDialogDeleteButton();
  if (confirmButton) {
    await humanPause(150, 300);
    simulateClick(confirmButton);
  }

  await waitForMaskRemoval(email);
  log(`Relay: Deleted ${email}`, 'ok');
  return { deleted: true, email };
}
