// verify-review-scan.mjs — one-off verification for the review-scan feature:
// opportunistic pagination (additional /product-reviews page fetches beyond
// the initial on-page scrape, capped at 3 pages x 400-800ms delay + fetch
// time) running alongside organic accumulation (persistent MutationObserver,
// no fixed timeout — see startOrganicAccumulation in content.tsx). Real
// Brave, single product page, generous wait to let both settle.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const PRODUCT_URL = process.env.TL_VERIFY_URL || 'https://www.amazon.com/dp/B00FLYWNYQ'; // Instant Pot Duo, 185k+ reviews
const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';

async function clickThroughInterstitial(page) {
  const continueBtn = page.locator('button:has-text("Continue shopping"), input[value="Continue shopping"]');
  if ((await continueBtn.count()) > 0) {
    await continueBtn.first().click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
}

async function main() {
  console.log('=== Building extension ===');
  execSync('npm run build', { stdio: 'inherit', cwd: __dirname });

  fs.mkdirSync(VERIFICATION_DIR, { recursive: true });
  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: BRAVE_PATH,
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });

  const consoleLog = [];
  const page = await context.newPage();
  page.on('console', (msg) => {
    const line = `[${msg.type()}] ${msg.text()}`;
    consoleLog.push(line);
    if (msg.text().includes('[TrustLens]')) console.log(line);
  });

  try {
    console.log(`Navigating to ${PRODUCT_URL} ...`);
    await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await clickThroughInterstitial(page);
    await page.waitForTimeout(3000);

    const panel = page.locator('#trustlens-root .trustlens-panel');
    await panel.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});

    const summaryAfterMount = (await page.locator('.trustlens-summary span').first().textContent().catch(() => '')) ?? '';
    console.log(`Summary right after mount: "${summaryAfterMount.trim()}"`);
    await page.screenshot({ path: path.join(VERIFICATION_DIR, 'review-scan-before.png') });

    console.log('Waiting up to ~35s for the additional-page review scan to complete...');
    await page.waitForTimeout(35000);

    const summaryFinal = (await page.locator('.trustlens-summary span').first().textContent().catch(() => '')) ?? '';
    console.log(`Summary after scan window: "${summaryFinal.trim()}"`);

    const checklistTexts = await page.locator('.trustlens-check p').allTextContents();
    console.log('Signal checklist detail lines:');
    for (const t of checklistTexts) console.log(`  - ${t}`);

    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(VERIFICATION_DIR, 'review-scan-after.png') });
    console.log('Saved: verification/review-scan-before.png, verification/review-scan-after.png');
  } finally {
    await page.close();
    await context.close();
  }

  fs.writeFileSync(path.join(VERIFICATION_DIR, 'review-scan-console-log.txt'), consoleLog.join('\n'));
  console.log('Full console log saved to verification/review-scan-console-log.txt');
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
