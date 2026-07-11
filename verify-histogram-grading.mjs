// verify-histogram-grading.mjs — verifies the population-histogram grading
// restructure against 3 real products:
//   1. Pilgrim night cream (~1,920 reviews, 4.1★) — previously "Insufficient
//      data" under the old 30-scraped-review minimum; should now get a real
//      grade straight from the histogram.
//   2. Instant Pot (185k+ reviews, 4.7★) — large-population sanity check.
//   3. A handmade incense holder (17 reviews) — sparse-histogram case; should
//      still grade (not apologize), with honest low-volume framing.
// Real Brave, one page per product, logs grade/subtitle/checks + screenshot.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-histogram-grading-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';

const PRODUCTS = [
  { key: 'pilgrim-1920', label: 'Pilgrim night cream (~1,920 reviews, 4.1★)', url: 'https://www.amazon.in/dp/B08RQJKF6D' },
  { key: 'instant-pot-185k', label: 'Instant Pot (185k+ reviews, 4.7★)', url: 'https://www.amazon.com/dp/B00FLYWNYQ' },
  { key: 'incense-holder-17', label: 'Handmade incense holder (~17 reviews, sparse histogram)', url: 'https://www.amazon.com/dp/B0GRNBMGX9' },
];

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

  const results = [];

  try {
    for (const product of PRODUCTS) {
      console.log(`\n=== ${product.label} ===`);
      console.log(`Navigating to ${product.url} ...`);
      const page = await context.newPage();
      const entry = { key: product.key, label: product.label, url: product.url };
      try {
        await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await clickThroughInterstitial(page);
        await page.waitForTimeout(4500);

        const panel = page.locator('#trustlens-root .trustlens-panel');
        await panel.waitFor({ state: 'visible', timeout: 15000 });
        entry.panelVisible = true;

        const report = await page.evaluate(() => {
          const grade = document.querySelector('.trustlens-medallion-letter')?.textContent?.trim() ?? null;
          const subtitle = document.querySelector('.trustlens-subtitle')?.textContent?.trim() ?? null;
          const checks = [...document.querySelectorAll('.trustlens-check')].map((row) => ({
            status: row.getAttribute('data-status'),
            label: row.querySelector('.trustlens-check-label')?.textContent?.trim() ?? '',
          }));
          return { grade, subtitle, checks };
        });
        entry.grade = report.grade;
        entry.subtitle = report.subtitle;
        entry.checks = report.checks;
        console.log('Grade:', report.grade);
        console.log('Subtitle:', report.subtitle);
        console.log('Checks:', JSON.stringify(report.checks, null, 2));

        await panel.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(VERIFICATION_DIR, `hg-${product.key}-full.png`) });
        await panel.screenshot({ path: path.join(VERIFICATION_DIR, `hg-${product.key}-closeup.png`) });
      } catch (err) {
        entry.panelVisible = false;
        entry.error = err.message;
        console.log('Panel did not appear:', err.message);
        await page.screenshot({ path: path.join(VERIFICATION_DIR, `hg-${product.key}-full.png`) }).catch(() => {});
      }
      results.push(entry);
      await page.close();
    }
  } finally {
    await context.close();
  }

  fs.writeFileSync(path.join(VERIFICATION_DIR, 'histogram-grading-report.json'), JSON.stringify(results, null, 2));
  console.log('\n=== Report written to verification/histogram-grading-report.json ===');
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
