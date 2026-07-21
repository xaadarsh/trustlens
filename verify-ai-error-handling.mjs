// verify-ai-error-handling.mjs
//
// Live automated verification (real installed Brave, real extension build,
// same convention as verify.mjs) for the shared AI error-classification +
// retry + model-fallback funnel in lib/ai-request.ts, exercised through both
// callers:
//   - the "Test connection" button (Settings -> lib/byo-key.ts)
//   - the real "Run AI deep dive" flow (TrustPanel -> lib/deep-analysis.ts)
// ...plus the Pro-card "Remove key" button (lib/byo-key.ts's
// clearProviderKey) added alongside the fallback fix.
//
// Network calls to Gemini/OpenAI/Gumroad are never made for real here —
// every case mocks the fetch via Playwright route interception so the exact
// status code / body / network failure / model URL for each scenario is
// fully controlled and the attempt count + which models were hit can be
// counted precisely.
//
// Does NOT fix anything it finds — it only reports.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-profile-ai-errors');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const BRAVE_PATH = 'C:\\Users\\Asus\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
const PRODUCT_URL = process.env.TL_VERIFY_URL || 'https://www.amazon.com/dp/B00FLYWNYQ';

const GEMINI_PATTERN = '**/generativelanguage.googleapis.com/**';
const OPENAI_PATTERN = '**/api.openai.com/**';
const GUMROAD_PATTERN = '**/api.gumroad.com/**';

// Must match lib/ai-request.ts's GEMINI_MODEL_FALLBACK_CHAIN exactly — kept
// as a literal here (this is a plain .mjs script, not compiled TS) rather
// than importing, so if the source list ever changes this constant needs a
// matching update.
const GEMINI_MODEL_FALLBACK_CHAIN = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.0-flash'];

const results = {};
const consoleLog = [];

function log(line) {
  console.log(line);
  consoleLog.push(line);
}

function record(name, pass, detail) {
  results[name] = pass;
  log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function modelFromUrl(url) {
  const match = url.match(/\/models\/([^:]+):/);
  return match ? match[1] : null;
}

async function clickThroughAmazonInterstitial(page) {
  const continueBtn = page.locator('button:has-text("Continue shopping"), input[value="Continue shopping"]');
  if ((await continueBtn.count()) > 0) {
    await continueBtn.first().click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
}

// --- Mocked route factories -------------------------------------------------
// Every factory records the exact request URL hit each call, so assertions
// can check WHICH model was tried (proving fallback actually switched
// models), not just how many calls were made.

function statusRoute(status, bodyObj) {
  const urls = [];
  const handler = async (route) => {
    urls.push(route.request().url());
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(bodyObj ?? { error: { code: status, message: 'mocked', status: 'MOCKED' } }),
    });
  };
  return { handler, urls: () => urls, attempts: () => urls.length };
}

function networkThrowRoute() {
  const urls = [];
  const handler = async (route) => {
    urls.push(route.request().url());
    await route.abort('failed');
  };
  return { handler, urls: () => urls, attempts: () => urls.length };
}

function sequenceRoute(steps) {
  const urls = [];
  const handler = async (route) => {
    const step = steps[Math.min(urls.length, steps.length - 1)];
    urls.push(route.request().url());
    if (step.abort) {
      await route.abort('failed');
      return;
    }
    await route.fulfill({
      status: step.status,
      contentType: 'application/json',
      body: JSON.stringify(step.body ?? { error: { code: step.status, message: 'mocked', status: 'MOCKED' } }),
    });
  };
  return { handler, urls: () => urls, attempts: () => urls.length };
}

const OVERLOADED_BODY = { error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } };
const KEY_REJECTED_BODY = { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } };
const RATE_LIMIT_BODY = { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } };
const OPENAI_UNAVAILABLE_BODY = { error: { message: 'The server is currently overloaded.', type: 'server_error', code: 'overloaded' } };
const GEMINI_SUCCESS_BODY = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'OK' }] } }] };
const GEMINI_DEEPDIVE_SUCCESS_BODY = {
  candidates: [{
    finishReason: 'STOP',
    content: { parts: [{ text: 'Reviews look mostly organic overall.\n✅ **Verified purchases** dominate the sample\n⚠️ A **timing cluster** is worth a look\n🔍 Similar phrasing in a **few reviews**' }] },
  }],
};
const GUMROAD_SUCCESS_BODY = { success: true, message: 'ok', purchase: { refunded: false, chargebacked: false } };

// --- Settings-page "Test connection" scenarios ------------------------------

async function clickTestAndAwaitSettled(page) {
  const testBtn = page.locator('button[title="Test connection"]');
  const startedAt = Date.now();
  await testBtn.click();
  await page.waitForFunction(() => {
    const btn = document.querySelector('button[title="Test connection"]');
    return btn && btn.disabled;
  }, { timeout: 3000 }).catch(() => {});
  await page.waitForFunction(() => {
    const btn = document.querySelector('button[title="Test connection"]');
    return btn && !btn.disabled;
  }, { timeout: 25000 });
  const wallClockMs = Date.now() - startedAt;
  const message = (await page.locator('.key-row-feedback').textContent().catch(() => '') ?? '').trim();
  return { message, wallClockMs };
}

async function runTestScenario(page, { name, pattern, route, assertMessage, expectedAttempts, expectedModels, maxWallClockMs }) {
  await page.route(pattern, route.handler);
  try {
    const { message, wallClockMs } = await clickTestAndAwaitSettled(page);
    const messageOk = assertMessage(message);
    const attempts = route.attempts();
    const attemptsOk = attempts === expectedAttempts;
    const hitModels = route.urls().map(modelFromUrl);
    const modelsOk = !expectedModels || JSON.stringify(hitModels) === JSON.stringify(expectedModels);
    const wallClockOk = !maxWallClockMs || wallClockMs <= maxWallClockMs;
    record(
      name,
      messageOk && attemptsOk && modelsOk && wallClockOk,
      `message="${message}" attempts=${attempts} models=${JSON.stringify(hitModels)} wallClockMs=${wallClockMs}`,
    );
  } finally {
    await page.unroute(pattern, route.handler);
  }
}

// --- Deep-dive scenarios -----------------------------------------------------

async function readTrialsRemaining(page) {
  const text = (await page.locator('.gradelens-trials-inline').textContent().catch(() => '')) ?? '';
  const match = text.match(/(\d+)\s+of/);
  return match ? Number(match[1]) : null;
}

async function clickDeepDiveAndAwaitSettled(page) {
  const btn = page.locator('.gradelens-button');
  await btn.click();
  await page.waitForFunction(() => {
    const button = document.querySelector('.gradelens-button');
    return button && button.disabled;
  }, { timeout: 3000 }).catch(() => {});
  await page.waitForFunction(() => {
    const button = document.querySelector('.gradelens-button');
    return button && !button.disabled;
  }, { timeout: 30000 });
  const status = (await page.locator('.gradelens-status').textContent().catch(() => '')) ?? '';
  const deepDive = (await page.locator('.gradelens-deep-dive').count()) > 0;
  return { status: status.trim(), deepDive };
}

async function main() {
  log('=== Building extension (npm run build) ===');
  execSync('npm run build', { stdio: 'inherit', cwd: __dirname });

  if (!fs.existsSync(EXTENSION_PATH)) throw new Error(`Build output not found at ${EXTENSION_PATH}`);
  if (!fs.existsSync(BRAVE_PATH)) throw new Error(`Brave not found at ${BRAVE_PATH}`);

  fs.mkdirSync(VERIFICATION_DIR, { recursive: true });
  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: BRAVE_PATH,
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  if (!sw) throw new Error('Could not find the extension service worker — extension may not have loaded.');
  const extensionId = new URL(sw.url()).hostname;
  log(`Extension ID resolved: ${extensionId}`);

  try {
    // --- Settings: save a fake Gemini key so the deep-dive path has a key to use ---
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
    await optionsPage.waitForTimeout(300);

    const geminiInput = optionsPage.locator('input[placeholder="Paste API key"]');
    await geminiInput.click();
    await geminiInput.fill('FAKE-GEMINI-KEY-FOR-VERIFICATION-0000');
    await optionsPage.locator('button[title="Save key"]').click();
    await optionsPage.waitForTimeout(300);
    const saveFeedback = (await optionsPage.locator('.key-row-feedback').textContent().catch(() => '')) ?? '';
    record('gemini_key_saved', /saved/i.test(saveFeedback), saveFeedback.trim());

    log('\n=== "Test connection" scenarios (Gemini) — shared classify+retry+model-fallback funnel ===');

    await runTestScenario(optionsPage, {
      name: 'test_all_models_503_overloaded_message',
      pattern: GEMINI_PATTERN,
      route: statusRoute(503, OVERLOADED_BODY),
      assertMessage: (m) => m.includes('Gemini') && /overload/i.test(m) && !/rejected/i.test(m),
      expectedAttempts: 3,
      expectedModels: GEMINI_MODEL_FALLBACK_CHAIN,
      maxWallClockMs: 10000,
    });

    await runTestScenario(optionsPage, {
      name: 'test_400_key_rejected_no_wasted_fallback',
      pattern: GEMINI_PATTERN,
      route: statusRoute(400, KEY_REJECTED_BODY),
      assertMessage: (m) => /rejected/i.test(m) && !/overload/i.test(m),
      expectedAttempts: 1,
      expectedModels: [GEMINI_MODEL_FALLBACK_CHAIN[0]],
    });

    await runTestScenario(optionsPage, {
      name: 'test_429_rate_limit_no_wasted_fallback',
      pattern: GEMINI_PATTERN,
      route: statusRoute(429, RATE_LIMIT_BODY),
      assertMessage: (m) => /rate limit/i.test(m) && !/rejected/i.test(m),
      expectedAttempts: 1,
      expectedModels: [GEMINI_MODEL_FALLBACK_CHAIN[0]],
    });

    await runTestScenario(optionsPage, {
      name: 'test_network_throw_timeout_message_tries_all_models',
      pattern: GEMINI_PATTERN,
      route: networkThrowRoute(),
      assertMessage: (m) => /timed out|connection/i.test(m),
      expectedAttempts: 3,
      expectedModels: GEMINI_MODEL_FALLBACK_CHAIN,
      maxWallClockMs: 10000,
    });

    await runTestScenario(optionsPage, {
      name: 'test_200_success_first_model',
      pattern: GEMINI_PATTERN,
      route: statusRoute(200, GEMINI_SUCCESS_BODY),
      assertMessage: (m) => /key works/i.test(m),
      expectedAttempts: 1,
      expectedModels: [GEMINI_MODEL_FALLBACK_CHAIN[0]],
    });

    await runTestScenario(optionsPage, {
      name: 'test_model1_503_model2_200_fallback_succeeds',
      pattern: GEMINI_PATTERN,
      route: sequenceRoute([{ status: 503, body: OVERLOADED_BODY }, { status: 200, body: GEMINI_SUCCESS_BODY }]),
      assertMessage: (m) => /key works/i.test(m),
      expectedAttempts: 2,
      expectedModels: [GEMINI_MODEL_FALLBACK_CHAIN[0], GEMINI_MODEL_FALLBACK_CHAIN[1]],
      maxWallClockMs: 10000,
    });

    log('\n=== "Test connection" scenario (OpenAI) — single-model retry unchanged, no fallback added ===');
    await optionsPage.locator('button:has-text("OpenAI")').first().click();
    await optionsPage.waitForTimeout(200);
    const openaiInput = optionsPage.locator('input[placeholder="Paste API key"]');
    await openaiInput.click();
    await openaiInput.fill('sk-FAKE-OPENAI-KEY-FOR-VERIFICATION-0000');
    await optionsPage.locator('button[title="Save key"]').click();
    await optionsPage.waitForTimeout(300);

    await runTestScenario(optionsPage, {
      name: 'test_openai_503_overloaded_message_retried_3x',
      pattern: OPENAI_PATTERN,
      route: statusRoute(503, OPENAI_UNAVAILABLE_BODY),
      assertMessage: (m) => m.includes('OpenAI') && /overload/i.test(m) && !/rejected/i.test(m),
      expectedAttempts: 3,
    });

    // Switch the provider tab back to Gemini before leaving Settings —
    // clicking the OpenAI tab above persisted provider:'openai' to storage
    // (AIProviderSetup's updateProvider saves immediately on tab click), and
    // the deep-dive scenarios below assume the Gemini key/mock are active.
    await optionsPage.locator('button:has-text("Gemini")').first().click();
    await optionsPage.waitForTimeout(200);
    await optionsPage.close();

    // --- Deep dive on a live Amazon page --------------------------------------
    log('\n=== Deep-dive flow on a live Amazon page (model fallback + trial-count behavior) ===');
    const amazonPage = await context.newPage();
    await amazonPage.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await clickThroughAmazonInterstitial(amazonPage);
    await amazonPage.waitForTimeout(3000);

    const panelLocator = amazonPage.locator('#gradelens-root .gradelens-panel');
    let panelVisible = false;
    try {
      await panelLocator.waitFor({ state: 'visible', timeout: 20000 });
      panelVisible = true;
    } catch {
      panelVisible = false;
    }
    log(`Panel visible: ${panelVisible}. Waiting ~11s for organic accumulation to produce a real grade...`);
    if (panelVisible) await amazonPage.waitForTimeout(11000);

    const deepDiveEnabled = panelVisible && (await amazonPage.locator('.gradelens-button').isEnabled().catch(() => false));

    if (!panelVisible || !deepDiveEnabled) {
      log('SOFT FAIL: panel not visible or deep-dive button disabled (insufficient live Amazon sample) — skipping deep-dive assertions rather than crashing.');
      record('deepdive_all_models_503_fail_trial_unchanged', false, 'skipped — panel/grade unavailable');
      record('deepdive_model1_503_retry_then_success_trial_decremented_once', false, 'skipped — panel/grade unavailable');
    } else {
      // Note: since the Test-button scenarios above already cleared the
      // Gemini key from storage via "Remove key", re-save it here so the
      // deep-dive path (which reads the key from the same storage) has one.
      // (This mirrors what a real user would do after removing a key.)
      const trialsBefore = await readTrialsRemaining(amazonPage);
      log(`Trials before any deep dive: ${trialsBefore}`);

      // Every model exhausts its 2 attempts-per-model with a 503 — must try
      // all 3 models (6 total calls), show the overloaded (not "key
      // rejected") message, and NOT consume a trial.
      const failRoute = statusRoute(503, OVERLOADED_BODY);
      await amazonPage.route(GEMINI_PATTERN, failRoute.handler);
      const failResult = await clickDeepDiveAndAwaitSettled(amazonPage);
      await amazonPage.unroute(GEMINI_PATTERN, failRoute.handler);
      const trialsAfterFail = await readTrialsRemaining(amazonPage);
      const failMessageOk = failResult.status.includes('Gemini') && /overload/i.test(failResult.status) && !/rejected/i.test(failResult.status);
      const failAttemptsOk = failRoute.attempts() === 6;
      const failModelsOk = JSON.stringify(failRoute.urls().map(modelFromUrl)) === JSON.stringify([
        GEMINI_MODEL_FALLBACK_CHAIN[0], GEMINI_MODEL_FALLBACK_CHAIN[0],
        GEMINI_MODEL_FALLBACK_CHAIN[1], GEMINI_MODEL_FALLBACK_CHAIN[1],
        GEMINI_MODEL_FALLBACK_CHAIN[2], GEMINI_MODEL_FALLBACK_CHAIN[2],
      ]);
      const failTrialOk = trialsAfterFail === trialsBefore;
      record(
        'deepdive_all_models_503_fail_trial_unchanged',
        failMessageOk && failAttemptsOk && failModelsOk && failTrialOk,
        `status="${failResult.status}" attempts=${failRoute.attempts()} models=${JSON.stringify(failRoute.urls().map(modelFromUrl))} trials ${trialsBefore}->${trialsAfterFail}`,
      );

      // Reload for a fresh TrustPanel mount, then: model1 attempt1 -> 503,
      // model1 attempt2 (its retry) -> 200. Must succeed via the SAME
      // model's retry (not needing to fall back to model2), and decrement
      // the trial count exactly once.
      await amazonPage.reload({ waitUntil: 'domcontentloaded' });
      await clickThroughAmazonInterstitial(amazonPage);
      await amazonPage.waitForTimeout(3000);
      await amazonPage.locator('#gradelens-root .gradelens-panel').waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
      await amazonPage.waitForTimeout(11000);

      const successRoute = sequenceRoute([{ status: 503, body: OVERLOADED_BODY }, { status: 200, body: GEMINI_DEEPDIVE_SUCCESS_BODY }]);
      await amazonPage.route(GEMINI_PATTERN, successRoute.handler);
      const successResult = await clickDeepDiveAndAwaitSettled(amazonPage);
      await amazonPage.unroute(GEMINI_PATTERN, successRoute.handler);
      const trialsAfterSuccess = await readTrialsRemaining(amazonPage);
      const successOk = successResult.deepDive && successResult.status === '';
      const successAttemptsOk = successRoute.attempts() === 2;
      const successModelsOk = JSON.stringify(successRoute.urls().map(modelFromUrl)) === JSON.stringify([GEMINI_MODEL_FALLBACK_CHAIN[0], GEMINI_MODEL_FALLBACK_CHAIN[0]]);
      const successTrialOk = trialsAfterSuccess === trialsAfterFail - 1;
      record(
        'deepdive_model1_503_retry_then_success_trial_decremented_once',
        successOk && successAttemptsOk && successModelsOk && successTrialOk,
        `deepDiveShown=${successResult.deepDive} attempts=${successRoute.attempts()} models=${JSON.stringify(successRoute.urls().map(modelFromUrl))} trials ${trialsAfterFail}->${trialsAfterSuccess}`,
      );
    }

    await amazonPage.close();

    // --- Pro license + "Remove key" ------------------------------------------
    // Deliberately run LAST: activating a Pro license makes TrustPanel skip
    // incrementUsage() entirely (hasProAccess short-circuits the trial-count
    // path), which would make the trial-count assertions above meaningless
    // if this ran first and left the profile in a Pro state.
    log('\n=== Pro license activation + "Remove key" (independent of license) ===');
    const settingsPage = await context.newPage();
    await settingsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
    await settingsPage.waitForTimeout(300);

    let gumroadCalled = 0;
    const gumroadHandler = async (route) => {
      gumroadCalled += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(GUMROAD_SUCCESS_BODY) });
    };
    await settingsPage.route(GUMROAD_PATTERN, gumroadHandler);
    try {
      await settingsPage.locator('input[placeholder="XXXX-XXXX-XXXX"]').fill('FAKE-LICENSE-KEY-0000');
      await settingsPage.locator('button:has-text("Verify")').click();
      await settingsPage.waitForFunction(() => document.querySelector('.pill.pro') !== null, { timeout: 10000 }).catch(() => {});
      const isPro = (await settingsPage.locator('.pill.pro').count()) > 0;
      record('license_activated_pro', isPro && gumroadCalled > 0, `proPillVisible=${isPro} gumroadCalls=${gumroadCalled}`);

      const removeBtn = settingsPage.locator('button:has-text("Remove key")');
      const removeBtnVisible = (await removeBtn.count()) > 0;
      record('remove_key_button_visible_on_pro_card', removeBtnVisible, 'requires the Gemini key saved earlier in this run to still be present');

      if (removeBtnVisible) {
        await removeBtn.click();
        await settingsPage.waitForTimeout(300);
        const removedFeedback = (await settingsPage.locator('.key-row-feedback').last().textContent().catch(() => '')) ?? '';
        const keyInputValue = await settingsPage.locator('input[placeholder="Paste API key"]').inputValue().catch(() => 'ERR');
        const stillPro = (await settingsPage.locator('.pill.pro').count()) > 0;
        const stillProMessage = (await settingsPage.locator('.pro-status-text').count()) > 0;
        record(
          'remove_key_clears_key_and_returns_to_empty_state',
          /removed/i.test(removedFeedback) && keyInputValue === '',
          `feedback="${removedFeedback.trim()}" keyInputValue="${keyInputValue}"`,
        );
        record(
          'remove_key_does_not_revoke_pro_license',
          stillPro && stillProMessage,
          `stillPro=${stillPro} stillProMessage=${stillProMessage}`,
        );
      } else {
        record('remove_key_clears_key_and_returns_to_empty_state', false, 'skipped — Remove key button not found');
        record('remove_key_does_not_revoke_pro_license', false, 'skipped — Remove key button not found');
      }
    } finally {
      await settingsPage.unroute(GUMROAD_PATTERN, gumroadHandler);
      await settingsPage.close();
    }
  } finally {
    await context.close();
  }

  log('\n=== RESULTS ===');
  const total = Object.keys(results).length;
  const passed = Object.values(results).filter(Boolean).length;
  for (const [key, value] of Object.entries(results)) {
    log(`[${value ? 'PASS' : 'FAIL'}] ${key}`);
  }
  log(`\n${passed}/${total} passed`);

  fs.writeFileSync(path.join(VERIFICATION_DIR, 'ai-error-handling-log.txt'), consoleLog.join('\n'));
  log('\nFull log saved to verification/ai-error-handling-log.txt');

  if (passed !== total) process.exitCode = 1;
}

main().catch((err) => {
  console.error('\n=== verify-ai-error-handling.mjs CRASHED ===');
  console.error(err);
  fs.mkdirSync(VERIFICATION_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(VERIFICATION_DIR, 'ai-error-handling-log.txt'),
    consoleLog.join('\n') + '\n\nCRASH:\n' + String(err.stack || err),
  );
  process.exitCode = 1;
});
