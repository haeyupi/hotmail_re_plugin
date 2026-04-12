// content/vps-panel.js — Content script for VPS panel (steps 1, 9)
// Injected on: VPS panel (user-configured URL)
//
// Actual DOM structure (after login click):
// <div class="card">
//   <div class="card-header">
//     <span class="OAuthPage-module__cardTitle___yFaP0">Codex OAuth</span>
//     <button class="btn btn-primary"><span>登录</span></button>
//   </div>
//   <div class="OAuthPage-module__cardContent___1sXLA">
//     <div class="OAuthPage-module__authUrlBox___Iu1d4">
//       <div class="OAuthPage-module__authUrlLabel___mYFJB">授权链接:</div>
//       <div class="OAuthPage-module__authUrlValue___axvUJ">https://auth.openai.com/...</div>
//       <div class="OAuthPage-module__authUrlActions___venPj">
//         <button class="btn btn-secondary btn-sm"><span>复制链接</span></button>
//         <button class="btn btn-secondary btn-sm"><span>打开链接</span></button>
//       </div>
//     </div>
//     <div class="OAuthPage-module__callbackSection___8kA31">
//       <input class="input" placeholder="http://localhost:1455/auth/callback?code=...&state=...">
//       <button class="btn btn-secondary btn-sm"><span>提交回调 URL</span></button>
//     </div>
//   </div>
// </div>

console.log('[MultiPage:vps-panel] Content script loaded on', location.href);

// Listen for commands from Background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_CODEX_OAUTH_STATUS') {
    resetStopState();
    getCodexOAuthStatus().then((status) => {
      sendResponse(status);
    }).catch((err) => {
      sendResponse({
        error: err.message,
        waiting: false,
        statusText: '',
        reason: 'status_check_failed',
        url: location.href,
      });
    });
    return true;
  }

  if (message.type === 'EXECUTE_STEP') {
    resetStopState();
    handleStep(message.step, message.payload).then(() => {
      sendResponse({ ok: true });
    }).catch(err => {
      if (isStopError(err)) {
        log(`Step ${message.step}: Stopped by user.`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      reportError(message.step, err.message);
      sendResponse({ error: err.message });
    });
    return true;
  }
});

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getCodexOAuthStatus() {
  let header = null;
  try {
    header = await waitForElementByText('.card-header', /codex\s*oauth|codex/i, 10000);
  } catch {
    return {
      waiting: false,
      statusText: '',
      reason: 'codex_card_not_found',
      url: location.href,
    };
  }

  const card = header.closest('.card') || header.parentElement || document.body;
  const cardText = normalizeText(card.textContent);
  const waitingMatch = cardText.match(/等待认证中(?:\.{3}|…)?|waiting for authentication(?:\.{3})?/i);
  const statusCandidates = Array.from(
    card.querySelectorAll('.status-badge, [class*="status"], [class*="Status"], [class*="hint"], [class*="Hint"]')
  )
    .map((el) => normalizeText(el.textContent))
    .filter(Boolean);
  const statusText = waitingMatch?.[0]
    || statusCandidates.find((text) => /等待认证中|waiting for authentication|认证成功|authentication successful|失败|failed|error/i.test(text))
    || '';

  return {
    waiting: Boolean(waitingMatch),
    statusText,
    reason: waitingMatch ? 'waiting' : 'not_waiting',
    url: location.href,
  };
}

async function handleStep(step, payload) {
  switch (step) {
    case 1: return await step1_getOAuthLink();
    case 9: return await step9_vpsVerify(payload);
    default:
      throw new Error(`vps-panel.js does not handle step ${step}`);
  }
}

// ============================================================
// Step 1: Get OAuth Link
// ============================================================

async function step1_getOAuthLink() {
  log('Step 1: Waiting for VPS panel to load (auto-login may take a moment)...');

  // The page may start at #/login and auto-redirect to #/oauth.
  // Wait for the Codex OAuth card to appear (up to 30s for auto-login + redirect).
  let loginBtn = null;
  try {
    // Wait for any card-header containing "Codex" to appear
    const header = await waitForElementByText('.card-header', /codex/i, 30000);
    loginBtn = header.querySelector('button.btn.btn-primary, button.btn');
    log('Step 1: Found Codex OAuth card');
  } catch {
    throw new Error(
      'Codex OAuth card did not appear after 30s. Page may still be loading or not logged in. ' +
      'Current URL: ' + location.href
    );
  }

  if (!loginBtn) {
    throw new Error('Found Codex OAuth card but no login button inside it. URL: ' + location.href);
  }

  // Check if button is disabled (already clicked / loading)
  if (loginBtn.disabled) {
    log('Step 1: Login button is disabled (already loading), waiting for auth URL...');
  } else {
    await humanPause(500, 1400);
    simulateClick(loginBtn);
    log('Step 1: Clicked login button, waiting for auth URL...');
  }

  // Wait for the auth URL to appear in the specific div
  let authUrlEl = null;
  try {
    authUrlEl = await waitForElement('[class*="authUrlValue"]', 15000);
  } catch {
    throw new Error(
      'Auth URL did not appear after clicking login. ' +
      'Check if VPS panel is logged in and Codex service is running. URL: ' + location.href
    );
  }

  const oauthUrl = (authUrlEl.textContent || '').trim();
  if (!oauthUrl || !oauthUrl.startsWith('http')) {
    throw new Error(`Invalid OAuth URL found: "${oauthUrl.slice(0, 50)}". Expected URL starting with http.`);
  }

  log(`Step 1: OAuth URL obtained: ${oauthUrl.slice(0, 80)}...`, 'ok');
  reportComplete(1, { oauthUrl });
}

// ============================================================
// Step 9: VPS Verify — paste localhost URL and submit
// ============================================================

async function step9_vpsVerify(payload) {
  // Get localhostUrl from payload (passed directly by background) or fallback to state
  let localhostUrl = payload?.localhostUrl;
  if (!localhostUrl) {
    log('Step 9: localhostUrl not in payload, fetching from state...');
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    localhostUrl = state.localhostUrl;
  }
  if (!localhostUrl) {
    throw new Error('No localhost URL found. Complete step 8 first.');
  }
  log(`Step 9: Got localhostUrl: ${localhostUrl.slice(0, 60)}...`);

  log('Step 9: Looking for callback URL input...');

  // Find the callback URL input
  // Actual DOM: <input class="input" placeholder="http://localhost:1455/auth/callback?code=...&state=...">
  let urlInput = null;
  try {
    urlInput = await waitForElement('[class*="callbackSection"] input.input', 10000);
  } catch {
    try {
      urlInput = await waitForElement('input[placeholder*="localhost"]', 5000);
    } catch {
      throw new Error('Could not find callback URL input on VPS panel. URL: ' + location.href);
    }
  }

  await humanPause(600, 1500);
  fillInput(urlInput, localhostUrl);
  log(`Step 9: Filled callback URL: ${localhostUrl.slice(0, 80)}...`);

  const submitButtonPattern = /提交|submit/i;
  const submitButtonFallbackPattern = /提交回调|submit callback/i;
  const successPattern = /认证成功|authentication successful|success/i;
  const collectStatusTexts = () => Array.from(
    document.querySelectorAll('.status-badge, [class*="status"], .card, .card *, main, main *')
  ).map((el) => String(el.textContent || '').replace(/\s+/g, ' ').trim());
  const initialStatusText = collectStatusTexts().join(' ');

  if (successPattern.test(initialStatusText)) {
    log('Step 9: Authentication successful!', 'ok');
    reportComplete(9);
    return;
  }

  // Find and click "提交回调 URL" / "Submit Callback URL" button
  let submitBtn = null;
  try {
    submitBtn = await waitForElementByText(
      '[class*="callbackActions"] button, [class*="callbackSection"] button',
      submitButtonPattern,
      5000
    );
  } catch {
    try {
      submitBtn = await waitForElementByText('button.btn', submitButtonFallbackPattern, 5000);
    } catch {
      throw new Error('Could not find callback submit button on VPS panel. URL: ' + location.href);
    }
  }

  await humanPause(450, 1200);
  simulateClick(submitBtn);
  log('Step 9: Clicked callback submit button, waiting for authentication result...');

  // Wait for the VPS panel success copy to appear
  try {
    await waitForElementByText('.status-badge, [class*="status"], .card, .card *, main, main *', successPattern, 30000);
    log('Step 9: Authentication successful!', 'ok');
  } catch {
    const statusText = collectStatusTexts().join(' ') || 'unknown';
    if (successPattern.test(statusText)) {
      log('Step 9: Authentication successful!', 'ok');
    } else {
      log(`Step 9: Status after submit: "${statusText}". May still be processing.`, 'warn');
    }
  }

  reportComplete(9);
}
