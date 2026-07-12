// verify-grading-midrange.mjs — confirms the population-evidence bypass added
// to statistical-engine.ts does NOT fire for the ambiguous middle ground:
// products with modest review counts (500-2000) and non-extreme ratings
// (3.3-4.4) should still fall to "Insufficient data" when the scraped sample
// stays under MIN_SAMPLE_SIZE, not get an asserted grade.
//
// Real Brave, fresh browser per product (browser fully closed during the
// multi-minute gap — same pattern as the other verify scripts).
//
// Usage: node verify-grading-midrange.mjs

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-midrange-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const RESULTS_PATH = path.join(VERIFICATION_DIR, 'grading-midrange-results.json');
const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';

// Discovered via find-midrange-products.mjs: real listings with 500-2000
// total reviews and a 3.3-4.4 average rating (neither extreme).
const PRODUCTS = [
  { name: 'Haliwu Gold Cabinet Handles', url: 'https://www.amazon.com/dp/B08ML4J3S4', knownRating: 4.4, knownReviewCount: 1900 },
  { name: 'Garlic Press Rocker (generic)', url: 'https://www.amazon.com/dp/B0CR4BZSS5', knownRating: 3.8, knownReviewCount: 998 },
  { name: 'KitchenAid Classic Garlic Press', url: 'https://www.amazon.com/dp/B07ZLF6WWK', knownRating: 4.4, knownReviewCount: 1600 },
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
  console.log(`\n=== ${product.name} (${product.url}) — known ${product.knownRating}★ / ${product.knownReviewCount} reviews ===`);
  const result = { name: product.name, url: product.url, knownRating: product.knownRating, knownReviewCount: product.knownReviewCount, testedAt: new Date().toISOString() };

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
      await page.waitForTimeout(35000);

      const subtitle = (await page.locator('.trustlens-subtitle').textContent().catch(() => '')) ?? '';
      const gradeGlyph = (await page.locator('.trustlens-medallion-letter').textContent().catch(() => '')) ?? '';
      const totalMatch = subtitle.match(/Based on ([\d,]+) reviews/);
      const scannedMatch = subtitle.match(/([\d,]+)\s+(?:reviews\s+)?analyzed in detail/);
      result.reviewsScanned = scannedMatch ? Number(scannedMatch[1].replace(/,/g, '')) : null;
      result.totalReviews = totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : null;
      result.grade = gradeGlyph.trim();
      result.subtitleRaw = subtitle.trim();

      const checkLabels = await page.locator('.trustlens-check-label').allTextContents();
      result.checkLabels = checkLabels;

      await page.screenshot({ path: path.join(VERIFICATION_DIR, `grading-midrange-${product.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`) });
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
  if (result.checkLabels?.length) console.log(`  check labels: ${JSON.stringify(result.checkLabels)}`);
  if (result.gateOrFailureMessages?.length) console.log(`  gate/failure messages: ${JSON.stringify(result.gateOrFailureMessages)}`);
  if (result.error) console.log(`  ERROR: ${result.error}`);

  return result;
}

async function main() {
  console.log('=== Building extension (with grading fix + population bypass) ===');
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
      const gapMs = 150000 + Math.round(Math.random() * 60000);
      console.log(`  waiting ${Math.round(gapMs / 1000)}s (~${(gapMs / 60000).toFixed(1)} min) with browser closed before next product...`);
      await new Promise((resolve) => setTimeout(resolve, gapMs));
    }
  }

  console.log(`\n=== Mid-range verification complete. ${results.length}/${PRODUCTS.length} products tested. ===`);
  const bypassFired = results.filter((r) => r.checkLabels?.some((l) => l.startsWith('Grade based on')));
  if (bypassFired.length) {
    console.log(`FAIL: population-evidence bypass fired too eagerly for ${bypassFired.length} mid-range product(s): ${bypassFired.map((r) => r.name).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('PASS: population-evidence bypass did not fire for any ambiguous mid-range product.');
  }
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
