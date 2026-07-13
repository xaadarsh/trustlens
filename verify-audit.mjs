// verify-audit.mjs
//
// Pre-submission adversarial audit against the REAL installed Brave browser
// + live Amazon, same pattern as verify.mjs. Covers what the deterministic
// grading test (verify-grading-logic.mjs) can't:
//   - Panel MOUNTS across different real page layouts (standard, book).
//   - Panel does NOT mount on a search/category page.
//   - SPA re-mount: a History-API navigation to a different product re-grades
//     instead of showing a stale grade (the content.tsx nav-watcher fix).
//   - SPA teardown: navigating to a non-product URL removes the panel.
//   - Deep-dive double-submit guard: 5 rapid clicks fire exactly one request
//     and burn exactly one trial (mocked provider).
//   - No uncaught console errors / page errors on a normal run.
// Does NOT fix anything it finds — it only reports.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-audit-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const BRAVE_PATH = 'C:\\Users\\Asus\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';

const results = {};
const consoleLog = [];
function log(line) {
  console.log(line);
  consoleLog.push(line);
}

// Only GradeLens-originated errors count. Amazon's own product pages log
// plenty of their own console.errors (their read.amazon.com service-worker
// 404s, ajax-spinner telemetry, etc.) that have nothing to do with this
// extension — GradeLens itself never calls console.error anywhere (verified
// by grep: zero occurrences in entrypoints/ and components/), so any error
// referencing "gradelens" or the extension origin is unambiguously ours.
function isGradeLensError(text, extensionId) {
  const lower = text.toLowerCase();
  return lower.includes('gradelens') || (extensionId && lower.includes(extensionId.toLowerCase()));
}

function attachErrorListeners(page, tag, sink, extensionId) {
  page.on('console', (msg) => {
    if (msg.type() === 'error' && isGradeLensError(msg.text(), extensionId)) {
      sink.push(`[${tag}] console.error: ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => {
    if (isGradeLensError(`${err.message} ${err.stack ?? ''}`, extensionId)) {
      sink.push(`[${tag}] pageerror: ${err.message}`);
    }
  });
}

async function dismissInterstitials(page) {
  for (const label of ['Continue shopping', 'Dismiss']) {
    const btn = page.locator(`button:has-text("${label}"), input[value="${label}"]`);
    if ((await btn.count()) > 0) {
      await btn.first().click().catch(() => {});
      await page.waitForTimeout(1000);
    }
  }
}

async function readPanel(page) {
  const root = page.locator('#gradelens-root');
  const mounted = (await root.count()) > 0 && (await page.locator('#gradelens-root .gradelens-panel').count()) > 0;
  if (!mounted) return { mounted: false };
  await page.waitForTimeout(9000); // settle medallion phase sequence
  const grade = ((await page.locator('.gradelens-medallion-letter').first().textContent().catch(() => '')) ?? '').trim();
  const confidence = ((await page.locator('.gradelens-confidence-chip').first().textContent().catch(() => '')) ?? '').trim();
  const verdict = ((await page.locator('.gradelens-verdict').first().textContent().catch(() => '')) ?? '').trim();
  const rootCount = await page.locator('#gradelens-root').count();
  return { mounted: true, grade, confidence, verdict, rootCount };
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
  if (!sw) throw new Error('Could not find the extension service worker.');
  const extensionId = new URL(sw.url()).hostname;
  log(`Extension ID resolved: ${extensionId}`);

  const allErrors = [];

  try {
    // --- A1: search page must NOT mount ---
    log('\n=== A1: search/category page must NOT mount ===');
    const searchPage = await context.newPage();
    attachErrorListeners(searchPage, 'search', allErrors, extensionId);
    await searchPage.goto('https://www.amazon.com/s?k=usb+cable', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismissInterstitials(searchPage);
    await searchPage.waitForTimeout(4000);
    const searchRoot = await searchPage.locator('#gradelens-root').count();
    log(`#gradelens-root on search page: ${searchRoot}`);
    results.no_mount_on_search_page = searchRoot === 0;
    await searchPage.close();

    // --- A2: mount across real product layouts ---
    const products = [
      { label: 'echo-dot (100k+)', url: 'https://www.amazon.com/dp/B09B8V1LZ3' },
      { label: 'book (Atomic Habits)', url: 'https://www.amazon.com/dp/0735211299' },
    ];
    let mountedCount = 0;
    for (const product of products) {
      log(`\n=== A2: ${product.label} ===`);
      const page = await context.newPage();
      attachErrorListeners(page, product.label, allErrors, extensionId);
      let outcome = { mounted: false };
      for (let attempt = 1; attempt <= 2 && !outcome.mounted; attempt++) {
        await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await dismissInterstitials(page);
        await page.waitForTimeout(4000);
        outcome = await readPanel(page);
        if (!outcome.mounted && attempt === 1) log(`  not mounted on attempt ${attempt}, retrying...`);
      }
      log(`  mounted=${outcome.mounted} grade="${outcome.grade ?? ''}" confidence="${outcome.confidence ?? ''}" verdict="${outcome.verdict ?? ''}"`);
      if (outcome.mounted) mountedCount++;
      await page.screenshot({ path: path.join(VERIFICATION_DIR, `audit-${product.label.replace(/[^a-z0-9]+/gi, '-')}.png`) }).catch(() => {});
      await page.close();
    }
    results.mounts_across_product_layouts = mountedCount === products.length;

    // --- B1: SPA re-mount — History-API nav to a different product re-grades
    // (no stale grade), and nav to a non-product URL tears the panel down. ---
    log('\n=== B1: SPA navigation re-mount + teardown ===');
    const spaPage = await context.newPage();
    attachErrorListeners(spaPage, 'spa', allErrors, extensionId);
    await spaPage.goto('https://www.amazon.com/dp/B09B8V1LZ3', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismissInterstitials(spaPage);
    await spaPage.waitForTimeout(4000);
    const before = await readPanel(spaPage);
    log(`  before nav: mounted=${before.mounted} grade="${before.grade}" confidence="${before.confidence}"`);

    if (before.mounted) {
      // Force a different scrape result (low review count -> Low confidence),
      // then History-API navigate to a different ASIN. The nav-watcher must
      // notice the URL change and re-mount, re-grading against the new data.
      await spaPage.evaluate(() => {
        const SELECTORS = ['[data-hook="total-review-count"]', '#acrCustomerReviewText', '#averageCustomerReviews_feature_div #acrCustomerReviewText'];
        for (const sel of SELECTORS) document.querySelectorAll(sel).forEach((el) => { el.textContent = '142 ratings'; });
        history.pushState({}, '', '/dp/B0SPATEST99');
      });
      await spaPage.waitForTimeout(4000); // > 800ms poll + 400ms debounce + scrape/settle
      const after = await readPanel(spaPage);
      log(`  after nav: mounted=${after.mounted} grade="${after.grade}" confidence="${after.confidence}" rootCount=${after.rootCount}`);
      results.spa_nav_regrades = after.mounted && (after.confidence !== before.confidence || after.grade !== before.grade);
      results.spa_nav_no_duplicate_root = after.rootCount === 1;

      // Now navigate to a non-product URL — panel must disappear.
      await spaPage.evaluate(() => history.pushState({}, '', '/s?k=teardown-check'));
      await spaPage.waitForTimeout(2500);
      const rootAfterSearch = await spaPage.locator('#gradelens-root').count();
      log(`  after nav to /s?k=...: #gradelens-root=${rootAfterSearch}`);
      results.spa_nav_to_search_tears_down = rootAfterSearch === 0;
    }
    await spaPage.close();

    // --- B2: deep-dive double-submit guard (mocked provider) ---
    log('\n=== B2: deep-dive double-submit guard ===');
    await sw.evaluate(async () => {
      await chrome.storage.local.set({
        'gradelens.settings': { provider: 'gemini', enabled: true, theme: 'light', geminiKey: 'test-key-audit' },
        gradelens_ai_uses: 0,
      });
    });
    const ddPage = await context.newPage();
    attachErrorListeners(ddPage, 'deepdive', allErrors, extensionId);
    let geminiRequestCount = 0;
    await ddPage.route('https://generativelanguage.googleapis.com/**', async (route) => {
      geminiRequestCount++;
      await new Promise((r) => setTimeout(r, 1500)); // hold so rapid clicks overlap
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Looks fine overall\n✅ **Verified** purchases dominate' }] }, finishReason: 'STOP' }] }),
      });
    });
    await ddPage.goto('https://www.amazon.com/dp/B09B8V1LZ3', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismissInterstitials(ddPage);
    await ddPage.waitForTimeout(4000);
    const ddButton = ddPage.locator('.gradelens-button');
    const ddReady = await ddButton.isVisible().catch(() => false) && !(await ddButton.isDisabled().catch(() => true));
    if (ddReady) {
      // Fire five clicks as fast as possible.
      for (let i = 0; i < 5; i++) await ddButton.click({ force: true, noWaitAfter: true }).catch(() => {});
      await ddPage.waitForTimeout(5000);
      const usesAfter = await sw.evaluate(async () => {
        const s = await chrome.storage.local.get('gradelens_ai_uses');
        return s.gradelens_ai_uses;
      });
      log(`  gemini requests fired: ${geminiRequestCount}, trial uses after 5 rapid clicks: ${usesAfter}`);
      results.double_submit_single_request = geminiRequestCount === 1;
      results.double_submit_single_trial_burned = usesAfter === 1;
    } else {
      log('  deep-dive button not ready — skipping double-submit assertions.');
    }
    await ddPage.close();

    results.no_uncaught_console_or_page_errors = allErrors.length === 0;
    if (allErrors.length > 0) {
      log('\n--- Console / page errors observed ---');
      for (const e of allErrors) log(`  ${e}`);
    }
  } finally {
    await context.close();
  }

  log('\n=== RESULTS ===');
  for (const [key, value] of Object.entries(results)) {
    log(`[${value ? 'PASS' : 'FAIL'}] ${key}`);
  }
  fs.writeFileSync(path.join(VERIFICATION_DIR, 'audit-console-log.txt'), consoleLog.join('\n'));
  log('\nFull log saved to verification/audit-console-log.txt');

  const anyFail = Object.values(results).some((v) => !v);
  process.exitCode = anyFail ? 1 : 0;
}

main().catch((err) => {
  console.error('\n=== VERIFY-AUDIT.MJS CRASHED ===');
  console.error(err);
  fs.mkdirSync(VERIFICATION_DIR, { recursive: true });
  fs.writeFileSync(path.join(VERIFICATION_DIR, 'audit-console-log.txt'), consoleLog.join('\n') + '\n\nCRASH:\n' + String(err.stack || err));
  process.exitCode = 1;
});
