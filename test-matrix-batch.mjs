// test-matrix-batch.mjs — runs a subset of the 16-product review-scan test
// matrix against real Brave, appending results to a persistent JSON file so
// data accumulates across multiple invocations. Launches a FRESH browser
// process per product (closed in between, same profile dir reused for
// cookie/session continuity) rather than holding one browser open idle for
// minutes — an earlier attempt at the latter crashed with "Target page,
// context or browser has been closed" after a ~3 minute idle gap, so the
// browser process itself doesn't reliably survive being left open and idle
// that long in this environment. Real multi-minute spacing between products
// still happens — it's just spent with the browser fully closed, not idling.
//
// Per-product failures are caught and recorded, not fatal to the whole run.
//
// Usage: BATCH_INDICES="0,1,2" node test-matrix-batch.mjs

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-matrix-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const RESULTS_PATH = path.join(VERIFICATION_DIR, 'review-scan-matrix-results.json');
const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';

// Full 16-product matrix. Indices are stable — pass a subset via BATCH_INDICES.
const PRODUCTS = [
  { name: 'Instant Pot Duo 7-in-1', category: 'Kitchen', scheme: 'dp/', domain: '.com', url: 'https://www.amazon.com/dp/B00FLYWNYQ' },
  { name: 'Atomic Habits (book)', category: 'Books', scheme: 'dp/', domain: '.com', url: 'https://www.amazon.com/dp/0735211299' },
  { name: 'Fire TV Stick 4K Max', category: 'Electronics', scheme: 'dp/', domain: '.com', url: 'https://www.amazon.com/dp/B08MQZXN1X' },
  { name: 'Kindle Paperwhite', category: 'Electronics', scheme: 'dp/', domain: '.com', url: 'https://www.amazon.com/dp/B08KTZ8249' },
  { name: 'AmazonBasics HDMI Cable', category: 'Electronics', scheme: 'dp/', domain: '.com', url: 'https://www.amazon.com/dp/B014I8SSD0' },
  { name: 'AmazonBasics HDMI Cable (gp/product scheme)', category: 'Electronics', scheme: 'gp/product/', domain: '.com', url: 'https://www.amazon.com/gp/product/B014I8SSD0' },
  { name: 'Soup Ladle (Arqivo)', category: 'Kitchen', scheme: 'gp/aw/d/', domain: '.in', url: 'https://www.amazon.in/gp/aw/d/B0BYVCGZBC' },
  { name: 'CeraVe Moisturizing Cream', category: 'Beauty', scheme: 'dp/', domain: '.com', url: 'https://www.amazon.com/dp/B00TTD9BRC' },
  { name: 'Echo Dot (3rd Gen)', category: 'Electronics', scheme: 'dp/', domain: '.com', url: 'https://www.amazon.com/dp/B07FZ8S74R' },
  { name: 'AmazonBasics Dumbbell 10lb', category: 'Sports/Fitness', scheme: 'dp/', domain: '.com', url: 'https://www.amazon.com/dp/B01LR5S6HK' },
  { name: 'iPhone 11 64GB (Renewed)', category: 'Electronics', scheme: 'dp/', domain: '.com', url: 'https://www.amazon.com/dp/B07ZPKN6YR' },
  { name: 'Kindle Paperwhite (.in cross-domain)', category: 'Electronics', scheme: 'dp/', domain: '.in', url: 'https://www.amazon.in/dp/B08KTZ8249' },
  { name: 'Fire TV Stick 4K Max (.in cross-domain)', category: 'Electronics', scheme: 'dp/', domain: '.in', url: 'https://www.amazon.in/dp/B08MQZXN1X' },
  { name: 'Soup Ladle (gp/product, .in)', category: 'Kitchen', scheme: 'gp/product/', domain: '.in', url: 'https://www.amazon.in/gp/product/B0BYVCGZBC' },
  { name: 'LEGO Classic Medium Creative Brick Box', category: 'Toys', scheme: 'dp/', domain: '.com', url: 'https://www.amazon.com/LEGO-Classic-Medium-Creative-Brick/dp/B00NHQFA1I' },
  { name: "Hanes Men's Cotton Pocket T-Shirt 6-Pack", category: 'Apparel', scheme: 'dp/', domain: '.com', url: 'https://www.amazon.com/Hanes-T-Shirt-Breathable-Stay-Tucked-Undershirts/dp/B0C3Y6W6SQ' },
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
  if (fs.existsSync(RESULTS_PATH)) {
    return JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
  }
  return [];
}

function saveResults(results) {
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
}

async function testOneProduct(product, index) {
  console.log(`\n=== [${index}] ${product.name} (${product.url}) ===`);

  const result = {
    index,
    name: product.name,
    category: product.category,
    scheme: product.scheme,
    domain: product.domain,
    url: product.url,
    testedAt: new Date().toISOString(),
  };

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
      if (text.includes('[TrustLens]') && /sign.?in|redirected|failed|errored|No review cards|timed out/i.test(text)) {
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
      await page.waitForTimeout(20000);

      const subtitle = (await page.locator('.trustlens-subtitle').textContent().catch(() => '')) ?? '';
      const gradeGlyph = (await page.locator('.trustlens-medallion-letter').textContent().catch(() => '')) ?? '';
      const totalMatch = subtitle.match(/Based on ([\d,]+) reviews/);
      const scannedMatch = subtitle.match(/([\d,]+)\s+(?:reviews\s+)?analyzed in detail/);
      result.reviewsScanned = scannedMatch ? Number(scannedMatch[1].replace(/,/g, '')) : null;
      result.totalReviews = totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : null;
      result.grade = gradeGlyph.trim();
      result.subtitleRaw = subtitle.trim();
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
  const indicesArg = process.env.BATCH_INDICES;
  if (!indicesArg) {
    console.error('Set BATCH_INDICES env var, e.g. BATCH_INDICES="0,1,2"');
    process.exit(1);
  }
  const indices = indicesArg.split(',').map((s) => Number(s.trim()));

  console.log('=== Building extension (only if needed — source unchanged since last build) ===');
  execSync('npm run build', { stdio: 'inherit', cwd: __dirname });

  fs.mkdirSync(VERIFICATION_DIR, { recursive: true });

  const results = loadResults();

  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    const product = PRODUCTS[idx];
    if (!product) {
      console.log(`Skipping unknown index ${idx}`);
      continue;
    }

    const result = await testOneProduct(product, idx);
    const existingPos = results.findIndex((r) => r.index === idx);
    if (existingPos >= 0) results[existingPos] = result;
    else results.push(result);
    saveResults(results);

    if (i < indices.length - 1) {
      const gapMs = 150000 + Math.round(Math.random() * 90000); // 2.5-4 min, browser fully closed during this wait
      console.log(`  waiting ${Math.round(gapMs / 1000)}s (~${(gapMs / 60000).toFixed(1)} min) with browser closed before next product...`);
      await new Promise((resolve) => setTimeout(resolve, gapMs));
    }
  }

  console.log(`\n=== Batch complete. ${results.length}/${PRODUCTS.length} total products tested so far. ===`);
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
