// verify-xss-hardening.mjs
//
// Live proof that untrusted content (Amazon review text/titles, and AI
// deep-dive output derived from them) cannot execute inside GradeLens's own
// DOM. Runs against the REAL installed Brave browser with the extension
// loaded, same pattern as verify.mjs. Does NOT fix anything it finds — it
// only reports.
//
// Three insertion points are exercised:
//  A) A malicious product title (as would be scraped via .textContent from
//     a hostile page) seeded into local history and rendered by the popup.
//  B) A malicious review card injected into a live Amazon page's DOM before
//     GradeLens scrapes it — proves the scraper + panel don't execute
//     anything even when Amazon's DOM itself is hostile.
//  C) A malicious AI deep-dive response (mocked Gemini network response)
//     containing a payload inside a **emphasis** marker — the exact
//     parse-then-render path (renderEmphasis in TrustPanel.tsx) that's the
//     highest-risk spot for this class of bug.
//
// A page-level `dialog` listener fails the whole run if any alert/confirm/
// prompt ever fires, and each case also asserts no actual <script>/<img
// onerror> element was created from the payload.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-xss-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const BRAVE_PATH = 'C:\\Users\\Asus\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
const PRODUCT_URL = 'https://www.amazon.com/dp/B09B8V1LZ3';

const SCRIPT_PAYLOAD = '<script>window.__xssFired = true;</script>';
const IMG_PAYLOAD = '<img src=x onerror="window.__xssFired = true">';
const MALICIOUS_TITLE = `Totally Normal Product ${SCRIPT_PAYLOAD}${IMG_PAYLOAD}`;

const results = {};
const consoleLog = [];
function log(line) {
  console.log(line);
  consoleLog.push(line);
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
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  if (!sw) throw new Error('Could not find the extension service worker — extension may not have loaded.');
  const extensionId = new URL(sw.url()).hostname;
  log(`Extension ID resolved: ${extensionId}`);

  try {
    // --- Case A: malicious product title rendered in popup history ---
    log('\n=== Case A: malicious product title in popup "Recent checks" ===');
    await sw.evaluate(async (title) => {
      await chrome.storage.local.set({
        gradelens_history: [{ asin: 'B0XSSTEST01', title, grade: 'B', date: Date.now() }],
      });
    }, MALICIOUS_TITLE);

    const popupPage = await context.newPage();
    let dialogFiredA = false;
    popupPage.on('dialog', (dialog) => {
      dialogFiredA = true;
      dialog.dismiss().catch(() => {});
    });
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await popupPage.waitForTimeout(800);

    const historyTitleText = await popupPage.locator('.history-title').first().textContent().catch(() => '');
    const scriptElCountA = await popupPage.locator('.history-title script').count();
    const imgElCountA = await popupPage.locator('.history-title img').count();
    const xssFiredA = await popupPage.evaluate(() => Boolean(window.__xssFired)).catch(() => false);

    log(`[case-A] rendered text: "${historyTitleText}"`);
    log(`[case-A] <script> elements inside .history-title: ${scriptElCountA}, <img> elements: ${imgElCountA}, dialog fired: ${dialogFiredA}, window.__xssFired: ${xssFiredA}`);
    results.caseA_payload_rendered_as_visible_text = historyTitleText.includes('<script>') || historyTitleText.includes('<img');
    results.caseA_no_script_element_created = scriptElCountA === 0;
    results.caseA_no_img_element_created = imgElCountA === 0;
    results.caseA_no_dialog_or_execution = !dialogFiredA && !xssFiredA;
    await popupPage.screenshot({ path: path.join(VERIFICATION_DIR, 'xss-case-a-popup-history.png'), timeout: 10000 }).catch(() => log('[case-A] screenshot skipped (non-fatal).'));
    await popupPage.close();

    // --- Case B: malicious review card injected into a live Amazon page's
    // own DOM before GradeLens scrapes it (text() reads .textContent, so a
    // hostile <script>/<img onerror> planted as review markup should come
    // through as inert text, never execute). ---
    log('\n=== Case B: malicious review card injected into live Amazon DOM ===');
    const amazonPage = await context.newPage();
    let dialogFiredB = false;
    amazonPage.on('dialog', (dialog) => {
      dialogFiredB = true;
      dialog.dismiss().catch(() => {});
    });
    // Inject the hostile card BEFORE the content script mounts, via an init
    // script that runs on every document. Built with createElement +
    // textContent, NOT innerHTML — this matches how Amazon itself actually
    // renders review text (as escaped, inert DOM text; Amazon does not
    // execute markup from review content either). Using innerHTML here
    // would make the test harness itself the XSS source, parsing and
    // firing the payload before GradeLens's own document_idle scrape ever
    // runs — that would prove nothing about GradeLens's code.
    await amazonPage.addInitScript((payload) => {
      document.addEventListener('DOMContentLoaded', () => {
        const card = document.createElement('div');
        card.setAttribute('data-hook', 'review');
        card.id = 'customer_review-xsstest01';

        const titleEl = document.createElement('span');
        titleEl.setAttribute('data-hook', 'review-title');
        titleEl.textContent = payload;

        const bodyEl = document.createElement('span');
        bodyEl.setAttribute('data-hook', 'reviewText');
        bodyEl.textContent = `Malicious body ${payload}`;

        const starEl = document.createElement('span');
        starEl.setAttribute('data-hook', 'review-star-rating');
        starEl.textContent = '5.0 out of 5 stars';

        const dateEl = document.createElement('span');
        dateEl.setAttribute('data-hook', 'review-date');
        dateEl.textContent = 'Reviewed on January 1, 2025';

        card.append(titleEl, bodyEl, starEl, dateEl);
        const anchor = document.querySelector('#averageCustomerReviews, #reviewsMedley, #productTitle, body');
        anchor?.appendChild(card);
      });
    }, MALICIOUS_TITLE);

    await amazonPage.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const continueBtn = amazonPage.locator('button:has-text("Continue shopping"), input[value="Continue shopping"]');
    if ((await continueBtn.count()) > 0) {
      await continueBtn.first().click();
      await amazonPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    }
    await amazonPage.waitForTimeout(4000);

    const injectedCardExists = await amazonPage.locator('#customer_review-xsstest01').count();
    const xssFiredB = await amazonPage.evaluate(() => Boolean(window.__xssFired)).catch(() => false);
    log(`[case-B] injected review card present in page: ${injectedCardExists > 0}, dialog fired: ${dialogFiredB}, window.__xssFired: ${xssFiredB}`);
    results.caseB_injected_card_did_not_execute = !dialogFiredB && !xssFiredB;
    await amazonPage.screenshot({ path: path.join(VERIFICATION_DIR, 'xss-case-b-amazon-injected.png'), timeout: 10000 }).catch(() => log('[case-B] screenshot skipped (non-fatal).'));
    await amazonPage.close();

    // --- Case C: malicious AI deep-dive response — the highest-risk spot
    // per the audit, since renderEmphasis parses **marker** spans out of
    // untrusted model output before rendering. Mock the Gemini network
    // response so this doesn't depend on a real API key or the model
    // actually being manipulable. ---
    log('\n=== Case C: malicious payload inside AI deep-dive **emphasis** marker ===');
    await sw.evaluate(async () => {
      await chrome.storage.local.set({
        'gradelens.settings': { provider: 'gemini', enabled: true, theme: 'light', geminiKey: 'test-key-for-xss-verification' },
      });
    });

    const deepDivePage = await context.newPage();
    let dialogFiredC = false;
    deepDivePage.on('dialog', (dialog) => {
      dialogFiredC = true;
      dialog.dismiss().catch(() => {});
    });
    const maliciousDeepDive = `Findings look fine overall\n✅ **${SCRIPT_PAYLOAD}${IMG_PAYLOAD}** verified purchases dominate`;
    await deepDivePage.route('https://generativelanguage.googleapis.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          candidates: [{ content: { parts: [{ text: maliciousDeepDive }] }, finishReason: 'STOP' }],
        }),
      })
    );

    await deepDivePage.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const continueBtn2 = deepDivePage.locator('button:has-text("Continue shopping"), input[value="Continue shopping"]');
    if ((await continueBtn2.count()) > 0) {
      await continueBtn2.first().click();
      await deepDivePage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    }
    await deepDivePage.waitForTimeout(4000);

    const deepDiveButton = deepDivePage.locator('.gradelens-button');
    await deepDiveButton.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
    await deepDiveButton.click().catch(() => {});
    await deepDivePage.waitForTimeout(4000);

    const deepDiveEl = deepDivePage.locator('.gradelens-deep-dive');
    const deepDiveText = await deepDiveEl.textContent().catch(() => '');
    const scriptElCountC = await deepDivePage.locator('.gradelens-deep-dive script').count();
    const imgElCountC = await deepDivePage.locator('.gradelens-deep-dive img').count();
    const xssFiredC = await deepDivePage.evaluate(() => Boolean(window.__xssFired)).catch(() => false);

    log(`[case-C] rendered deep-dive text: "${deepDiveText.slice(0, 300)}"`);
    log(`[case-C] <script> elements: ${scriptElCountC}, <img> elements: ${imgElCountC}, dialog fired: ${dialogFiredC}, window.__xssFired: ${xssFiredC}`);
    results.caseC_deep_dive_rendered = deepDiveText.length > 0;
    results.caseC_payload_visible_as_text = deepDiveText.includes('<script>') || deepDiveText.includes('<img');
    results.caseC_no_script_element_created = scriptElCountC === 0;
    results.caseC_no_img_element_created = imgElCountC === 0;
    results.caseC_no_dialog_or_execution = !dialogFiredC && !xssFiredC;
    await deepDivePage.screenshot({ path: path.join(VERIFICATION_DIR, 'xss-case-c-deepdive.png'), timeout: 10000 }).catch(() => log('[case-C] screenshot skipped (non-fatal).'));
    await deepDivePage.close();
  } finally {
    await context.close();
  }

  log('\n=== RESULTS ===');
  for (const [key, value] of Object.entries(results)) {
    log(`[${value ? 'PASS' : 'FAIL'}] ${key}`);
  }
  fs.writeFileSync(path.join(VERIFICATION_DIR, 'xss-hardening-console-log.txt'), consoleLog.join('\n'));
  log('\nFull log saved to verification/xss-hardening-console-log.txt');

  const anyFail = Object.values(results).some((v) => !v);
  process.exitCode = anyFail ? 1 : 0;
}

main().catch((err) => {
  console.error('\n=== VERIFY-XSS-HARDENING.MJS CRASHED ===');
  console.error(err);
  fs.mkdirSync(VERIFICATION_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(VERIFICATION_DIR, 'xss-hardening-console-log.txt'),
    consoleLog.join('\n') + '\n\nCRASH:\n' + String(err.stack || err)
  );
  process.exitCode = 1;
});
