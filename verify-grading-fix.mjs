// verify-grading-fix.mjs — confirms the low-sample grading bias fix:
// well-known, high-review-count (128k+), high-rating (4.5+) products must
// no longer come out with a low letter grade off a tiny "helpful"-sorted
// sample. Expects either a solidly high grade (A/B) or "Insufficient data"
// (the safe fallback) — never C/D/F.
//
// Real Brave, fresh browser per product (same pattern as test-matrix-batch.mjs
// — holding one browser open idle across multi-minute product gaps isn't
// reliable in this environment), appends to a persistent results file.
//
// Usage: node verify-grading-fix.mjs

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-grading-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const RESULTS_PATH = path.join(VERIFICATION_DIR, 'grading-fix-results.json');
const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';

// All independently known to be well-established, legitimate, high-rating
// listings with well over 128k total reviews.
const PRODUCTS = [
  { name: 'Instant Pot Duo 7-in-1', url: 'https://www.amazon.com/dp/B00FLYWNYQ' },
  { name: 'Fire TV Stick 4K Max', url: 'https://www.amazon.com/dp/B08MQZXN1X' },
  { name: 'Echo Dot (3rd Gen)', url: 'https://www.amazon.com/dp/B07FZ8S74R' },
  { name: 'CeraVe Moisturizing Cream', url: 'https://www.amazon.com/dp/B00TTD9BRC' },
];

async function clickThroughInterstitial(page) {
  const continueBtn = page.locator('button:has-text("Continue shopping"), input[value="Continue shopping"]');
  if ((await continueBtn.count()) > 0) {
    await continueBtn.first().click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
}

function loadResults() {
  if (fs.existsSync(RESULTS_PATH)) return JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
  return [];
}

function saveResults(results) {
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
}

async function testOneProduct(product) {
  console.log(`\n=== ${product.name} (${product.url}) ===`);
  const result = { name: product.name, url: product.url, testedAt: new Date().toISOString() };

  let context;
  try {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      executablePath: BRAVE_PATH,
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });

    const gateMessages = [];
    const page = await context.newPage();
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[TrustLens]') && /sign.?in|redirected|failed|errored|No review cards|timed out|scan complete/i.test(text)) {
        gateMessages.push(text);
      }
    });

    await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await clickThroughInterstitial(page);
    await page.waitForTimeout(3000);

    const panel = page.locator('#trustlens-root .trustlens-panel');
    let visible = false;
    try {
      await panel.waitFor({ state: 'visible', timeout: 15000 });
      visible = true;
    } catch {
      visible = false;
    }
    result.panelMounted = visible;

    if (visible) {
      // Generous wait: lazy-load watch (up to 9s) + additional-page fetches
      // (up to 5 pages x 400-800ms + fetch time), then re-render settles.
      await page.waitForTimeout(35000);

      const subtitle = (await page.locator('.trustlens-subtitle').textContent().catch(() => '')) ?? '';
      const gradeGlyph = (await page.locator('.trustlens-medallion-letter').textContent().catch(() => '')) ?? '';
      const match = subtitle.match(/([\d,]+)\s+of\s+([\d,]+)\s+scanned/);
      result.reviewsScanned = match ? Number(match[1].replace(/,/g, '')) : null;
      result.totalReviews = match ? Number(match[2].replace(/,/g, '')) : null;
      result.grade = gradeGlyph.trim();
      result.subtitleRaw = subtitle.trim();

      const checklistTexts = await page.locator('.trustlens-check p').allTextContents();
      result.checklist = checklistTexts;

      await page.screenshot({ path: path.join(VERIFICATION_DIR, `grading-fix-${product.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`) });
    } else {
      result.reviewsScanned = null;
      result.totalReviews = null;
      result.grade = null;
      result.mountFailureNote = 'Panel never became visible.';
    }

    result.gateOrFailureMessages = gateMessages;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (context) await context.close().catch(() => {});
  }

  console.log(`  panelMounted=${result.panelMounted} reviewsScanned=${result.reviewsScanned} totalReviews=${result.totalReviews} grade="${result.grade}"`);
  if (result.gateOrFailureMessages?.length) console.log(`  gate/failure messages: ${JSON.stringify(result.gateOrFailureMessages)}`);
  if (result.error) console.log(`  ERROR: ${result.error}`);

  return result;
}

async function main() {
  console.log('=== Building extension (with grading fix) ===');
  execSync('npm run build', { stdio: 'inherit', cwd: __dirname });

  fs.mkdirSync(VERIFICATION_DIR, { recursive: true });
  const results = loadResults();

  for (let i = 0; i < PRODUCTS.length; i++) {
    const product = PRODUCTS[i];
    const result = await testOneProduct(product);
    const existingPos = results.findIndex((r) => r.name === product.name);
    if (existingPos >= 0) results[existingPos] = result;
    else results.push(result);
    saveResults(results);

    if (i < PRODUCTS.length - 1) {
      const gapMs = 150000 + Math.round(Math.random() * 60000); // 2.5-3.5 min, browser fully closed
      console.log(`  waiting ${Math.round(gapMs / 1000)}s (~${(gapMs / 60000).toFixed(1)} min) with browser closed before next product...`);
      await new Promise((resolve) => setTimeout(resolve, gapMs));
    }
  }

  console.log(`\n=== Grading-fix verification complete. ${results.length}/${PRODUCTS.length} products tested. ===`);
  const bad = results.filter((r) => r.grade && ['C', 'D', 'F'].includes(r.grade));
  if (bad.length) {
    console.log(`FAIL: ${bad.length} well-known high-review product(s) still got a low grade: ${bad.map((r) => `${r.name}=${r.grade}`).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('PASS: no well-known high-review product got a low (C/D/F) grade.');
  }
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
