// content/qq-mail.js — Content script for QQ Mail (steps 4, 7)
// Injected on: mail.qq.com, wx.mail.qq.com
// NOTE: all_frames: true
//
// Strategy for avoiding stale codes:
// 1. On poll start, snapshot all existing mail IDs as "old"
// 2. On each poll cycle, refresh inbox and look for NEW items (not in snapshot)
// 3. Only extract codes from NEW items that match sender/subject filters
// 4. Never fall back to older matching emails

const QQ_MAIL_PREFIX = '[MultiPage:qq-mail]';
const isTopFrame = window === window.top;

console.log(QQ_MAIL_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

// ============================================================
// Message Handler
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'POLL_EMAIL') {
    if (!isTopFrame) {
      sendResponse({ ok: false, reason: 'wrong-frame' });
      return;
    }
    resetStopState();
    handlePollEmail(message.step, message.payload).then(result => {
      sendResponse(result);
    }).catch(err => {
      if (isStopError(err)) {
        log(`Step ${message.step}: Stopped by user.`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      if (message.reportStepError !== false) {
        reportError(message.step, err.message);
      }
      sendResponse({ error: err.message });
    });
    return true; // async response
  }
});

// ============================================================
// Get all current mail IDs from the list
// ============================================================

function getCurrentMailIds() {
  const ids = new Set();
  document.querySelectorAll('.mail-list-page-item[data-mailid]').forEach(item => {
    ids.add(item.getAttribute('data-mailid'));
  });
  return ids;
}

function collectMailItems() {
  return Array.from(document.querySelectorAll('.mail-list-page-item[data-mailid]')).map((item) => ({
    mailId: item.getAttribute('data-mailid') || '',
    sender: item.querySelector('.cmp-account-nick')?.textContent || '',
    subject: item.querySelector('.mail-subject')?.textContent || '',
    digest: item.querySelector('.mail-digest')?.textContent || '',
  }));
}

// ============================================================
// Email Polling
// ============================================================

async function handlePollEmail(step, payload) {
  const { senderFilters, subjectFilters, maxAttempts, intervalMs } = payload;

  log(`Step ${step}: Starting email poll (max ${maxAttempts} attempts, every ${intervalMs / 1000}s)`);

  // Wait for mail list to load
  try {
    await waitForElement('.mail-list-page-item', 10000);
    log(`Step ${step}: Mail list loaded`);
  } catch {
    throw new Error('Mail list did not load. Make sure QQ Mail inbox is open.');
  }

  // Step 1: Snapshot existing mail IDs BEFORE we start waiting for new email
  const existingMailIds = getCurrentMailIds();
  log(`Step ${step}: Snapshotted ${existingMailIds.size} existing emails as "old"`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`Polling QQ Mail... attempt ${attempt}/${maxAttempts}`);

    // Refresh inbox (skip on first attempt, list is fresh)
    if (attempt > 1) {
      await refreshInbox();
      await sleep(800);
    }

    const result = MultiPageQQMail.findNewQQVerificationCode(collectMailItems(), {
      existingMailIds: [...existingMailIds],
      senderFilters,
      subjectFilters,
    });

    if (result) {
      log(`Step ${step}: Code found: ${result.code} (${result.source}, subject: ${result.subject.slice(0, 40)})`, 'ok');
      return { ok: true, code: result.code, emailTimestamp: Date.now(), mailId: result.mailId };
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  throw new Error(
    `No new matching email found after ${(maxAttempts * intervalMs / 1000).toFixed(0)}s. ` +
    'Check QQ Mail manually. Email may be delayed or in spam folder.'
  );
}

// ============================================================
// Inbox Refresh
// ============================================================

async function refreshInbox() {
  // Try multiple strategies to refresh the mail list

  // Strategy 1: Click any visible refresh button
  const refreshBtn = document.querySelector('[class*="refresh"], [title*="刷新"]');
  if (refreshBtn) {
    simulateClick(refreshBtn);
    console.log(QQ_MAIL_PREFIX, 'Clicked refresh button');
    await sleep(500);
    return;
  }

  // Strategy 2: Click inbox in sidebar to reload list
  const sidebarInbox = document.querySelector('a[href*="inbox"], [class*="folder-item"][class*="inbox"], [title="收件箱"]');
  if (sidebarInbox) {
    simulateClick(sidebarInbox);
    console.log(QQ_MAIL_PREFIX, 'Clicked sidebar inbox');
    await sleep(500);
    return;
  }

  // Strategy 3: Click the folder name in toolbar
  const folderName = document.querySelector('.toolbar-folder-name');
  if (folderName) {
    simulateClick(folderName);
    console.log(QQ_MAIL_PREFIX, 'Clicked toolbar folder name');
    await sleep(500);
  }
}
