// verify.mjs
//
// Live automated verification against the REAL installed Brave browser
// (not Playwright's bundled Chromium — that failed to load extensions
// headlessly on this machine in an earlier attempt). Builds the extension,
// launches Brave with it loaded via a persistent context, then drives the
// popup, options page, and a live Amazon product page.
//
// Does NOT fix anything it finds — it only reports.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const PRODUCT_URL = process.env.TL_VERIFY_URL || 'https://www.amazon.com/dp/B09B8V1LZ3';
const BRAVE_PATH = 'C:\\Users\\Asus\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';

const consoleLog = [];

function log(line) {
  console.log(line);
  consoleLog.push(line);
}

function recordConsole(tag, msg) {
  const line = `[${tag}] [${msg.type()}] ${msg.text()}`;
  consoleLog.push(line);
  if (msg.type() === 'warning' || msg.type() === 'error' || msg.text().includes('[TrustLens]')) {
    console.log(line);
  }
}

async function clickThroughAmazonInterstitial(page) {
  const continueBtn = page.locator('button:has-text("Continue shopping"), input[value="Continue shopping"]');
  if ((await continueBtn.count()) > 0) {
    log('Amazon interstitial ("Continue shopping") detected — clicking through.');
    await continueBtn.first().click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
}

async function main() {
  log('=== Building extension (npm run build) ===');
  execSync('npm run build', { stdio: 'inherit', cwd: __dirname });

  if (!fs.existsSync(EXTENSION_PATH)) {
    throw new Error(`Build output not found at ${EXTENSION_PATH}`);
  }
  if (!fs.existsSync(BRAVE_PATH)) {
    throw new Error(`Brave not found at ${BRAVE_PATH}`);
  }

  fs.mkdirSync(VERIFICATION_DIR, { recursive: true });
  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });

  log(`\n=== Launching real Brave (headed) with extension loaded ===`);
  log(`Brave path: ${BRAVE_PATH}`);
  log(`Extension path: ${EXTENSION_PATH}`);

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: BRAVE_PATH,
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });

  log('Brave launched successfully.');

  // Get the extension ID from its background service worker.
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  }
  if (!sw) {
    throw new Error('Could not find the extension service worker — extension may not have loaded.');
  }
  const extensionId = new URL(sw.url()).hostname;
  log(`Extension ID resolved: ${extensionId}`);

  const results = {};

  try {
    // --- Popup ---
    const popupPage = await context.newPage();
    popupPage.on('console', (msg) => recordConsole('popup', msg));
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await popupPage.waitForTimeout(500);
    await popupPage.screenshot({ path: path.join(VERIFICATION_DIR, 'popup.png') });
    log('Screenshot saved: verification/popup.png');

    const popupBodyText = await popupPage.locator('body').innerText();
    results.popup_has_toggle = /Enabled|Disabled/.test(popupBodyText);
    results.popup_has_badge = /Free|Pro/.test(popupBodyText);
    results.popup_has_open_settings = /Open Settings/.test(popupBodyText);
    results.popup_has_no_key_inputs = (await popupPage.locator('input[type="password"], input[type="text"]').count()) === 0;
    log(`Popup check: toggle=${results.popup_has_toggle}, badge=${results.popup_has_badge}, openSettingsBtn=${results.popup_has_open_settings}, noKeyInputs=${results.popup_has_no_key_inputs}`);

    // --- Options / Settings page ---
    const optionsPage = await context.newPage();
    optionsPage.on('console', (msg) => recordConsole('options', msg));
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
    await optionsPage.waitForTimeout(500);
    await optionsPage.screenshot({ path: path.join(VERIFICATION_DIR, 'options.png') });
    log('Screenshot saved: verification/options.png');

    const optionsBodyText = await optionsPage.locator('body').innerText();
    results.options_has_gemini_key = /Gemini API key/.test(optionsBodyText);
    results.options_has_openai_key = /OpenAI API key/.test(optionsBodyText);
    results.options_has_provider_toggle = /Deep-dive provider/.test(optionsBodyText);
    results.options_has_license = /Gumroad license key/.test(optionsBodyText);
    log(`Options check: geminiKey=${results.options_has_gemini_key}, openaiKey=${results.options_has_openai_key}, provider=${results.options_has_provider_toggle}, license=${results.options_has_license}`);
    await optionsPage.close();

    // --- Amazon: enabled state ---
    const amazonPage = await context.newPage();
    amazonPage.on('console', (msg) => recordConsole('amazon-enabled', msg));
    log(`\n=== Navigating to live Amazon product page (TrustLens should be ENABLED by default) ===`);
    await amazonPage.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await clickThroughAmazonInterstitial(amazonPage);
    await amazonPage.waitForTimeout(3000);

    const panelLocatorEnabled = amazonPage.locator('#trustlens-root .trustlens-panel');
    let panelVisibleEnabled = false;
    try {
      await panelLocatorEnabled.waitFor({ state: 'visible', timeout: 20000 });
      panelVisibleEnabled = true;
    } catch {
      panelVisibleEnabled = false;
    }
    results.panel_visible_when_enabled = panelVisibleEnabled;
    await amazonPage.screenshot({ path: path.join(VERIFICATION_DIR, 'amazon-panel-enabled-initial.png') });
    log(`Screenshot saved: verification/amazon-panel-enabled-initial.png (panel visible: ${panelVisibleEnabled})`);

    let initialGradeText = '';
    if (panelVisibleEnabled) {
      initialGradeText = (await amazonPage.locator('.trustlens-grade').textContent().catch(() => '')) ?? '';
      log(`Initial grade badge text (before lazy-load window): "${initialGradeText.trim()}"`);
    }

    // Give the MutationObserver/IntersectionObserver watch (9s timeout + 500ms
    // debounce in content.tsx) time to resolve before checking the final state.
    log('Waiting up to ~11s for the lazy-load watch window to resolve...');
    await amazonPage.waitForTimeout(11000);

    const finalGradeText = (await amazonPage.locator('.trustlens-grade').textContent().catch(() => '')) ?? '';
    const reviewCountText = (await amazonPage.locator('.trustlens-summary').textContent().catch(() => '')) ?? '';
    log(`Final grade badge text (after lazy-load window): "${finalGradeText.trim()}"`);
    log(`Final review-count summary: "${reviewCountText.trim()}"`);
    results.real_grade_after_lazy_load = finalGradeText.trim().length > 0 && !finalGradeText.includes('Insufficient data');
    await amazonPage.screenshot({ path: path.join(VERIFICATION_DIR, 'amazon-panel-lazy-loaded.png') });
    log(`Screenshot saved: verification/amazon-panel-lazy-loaded.png`);
    await amazonPage.close();

    // --- Toggle OFF via popup ---
    log(`\n=== Toggling TrustLens OFF via popup ===`);
    await popupPage.bringToFront();
    await popupPage.locator('.switch').click();
    await popupPage.waitForTimeout(500);
    const toggleLabelAfterOff = await popupPage.locator('.toggle-label').textContent();
    log(`Popup toggle label now reads: "${toggleLabelAfterOff}"`);
    results.toggle_off_label_correct = toggleLabelAfterOff?.trim() === 'Disabled';

    // --- Amazon: disabled state (reload) ---
    const amazonPageOff = await context.newPage();
    const offConsoleMessages = [];
    amazonPageOff.on('console', (msg) => {
      recordConsole('amazon-disabled', msg);
      offConsoleMessages.push(`[${msg.type()}] ${msg.text()}`);
    });
    log('Reloading the same Amazon product page with TrustLens disabled...');
    await amazonPageOff.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await clickThroughAmazonInterstitial(amazonPageOff);
    await amazonPageOff.waitForTimeout(3000);

    const panelLocatorDisabled = amazonPageOff.locator('#trustlens-root');
    const panelCountDisabled = await panelLocatorDisabled.count();
    results.no_pill_when_disabled = panelCountDisabled === 0;
    results.no_console_activity_when_disabled = offConsoleMessages.filter((m) => m.includes('TrustLens')).length === 0;
    await amazonPageOff.screenshot({ path: path.join(VERIFICATION_DIR, 'amazon-panel-disabled.png') });
    log(`Screenshot saved: verification/amazon-panel-disabled.png (#trustlens-root count: ${panelCountDisabled}, TrustLens console messages: ${offConsoleMessages.filter((m) => m.includes('TrustLens')).length})`);
    await amazonPageOff.close();

    // --- Toggle back ON via popup ---
    log(`\n=== Toggling TrustLens back ON via popup ===`);
    await popupPage.bringToFront();
    await popupPage.locator('.switch').click();
    await popupPage.waitForTimeout(500);
    const toggleLabelAfterOn = await popupPage.locator('.toggle-label').textContent();
    log(`Popup toggle label now reads: "${toggleLabelAfterOn}"`);
    results.toggle_on_label_correct = toggleLabelAfterOn?.trim() === 'Enabled';
    await popupPage.close();

    // --- Amazon: re-enabled state (reload) ---
    const amazonPageOn = await context.newPage();
    amazonPageOn.on('console', (msg) => recordConsole('amazon-reenabled', msg));
    log('Reloading the same Amazon product page with TrustLens re-enabled...');
    await amazonPageOn.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await clickThroughAmazonInterstitial(amazonPageOn);
    await amazonPageOn.waitForTimeout(3000);

    const panelLocatorReenabled = amazonPageOn.locator('#trustlens-root .trustlens-panel');
    let panelVisibleReenabled = false;
    try {
      await panelLocatorReenabled.waitFor({ state: 'visible', timeout: 20000 });
      panelVisibleReenabled = true;
    } catch {
      panelVisibleReenabled = false;
    }
    results.panel_visible_after_re_enable = panelVisibleReenabled;
    await amazonPageOn.screenshot({ path: path.join(VERIFICATION_DIR, 'amazon-panel-reenabled.png') });
    log(`Screenshot saved: verification/amazon-panel-reenabled.png (panel visible: ${panelVisibleReenabled})`);
    await amazonPageOn.close();
  } finally {
    await context.close();
  }

  log('\n=== RESULTS ===');
  for (const [key, value] of Object.entries(results)) {
    log(`[${value ? 'PASS' : 'FAIL'}] ${key}`);
  }

  fs.writeFileSync(path.join(VERIFICATION_DIR, 'console-log.txt'), consoleLog.join('\n'));
  log('\nFull console log saved to verification/console-log.txt');
}

main().catch((err) => {
  console.error('\n=== VERIFY.MJS CRASHED ===');
  console.error(err);
  fs.mkdirSync(VERIFICATION_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(VERIFICATION_DIR, 'console-log.txt'),
    consoleLog.join('\n') + '\n\nCRASH:\n' + String(err.stack || err)
  );
  process.exitCode = 1;
});
