// diag-sample-growth.mjs — checks whether the scraped review sample reaches
// MIN_SAMPLE_SIZE (30) on the Pilgrim product within a longer wait, and
// whether the supporting sample-based checks join the histogram core once
// it does.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-sample-growth-profile');
const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';
const URL = process.argv[2] || 'https://www.amazon.in/dp/B08RQJKF6D';

async function main() {
  console.log('=== Building extension ===');
  execSync('npm run build', { stdio: 'inherit', cwd: __dirname });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: BRAVE_PATH,
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });

  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.text().includes('TrustLens')) console.log('[console]', msg.text());
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const continueBtn = page.locator('button:has-text("Continue shopping"), input[value="Continue shopping"]');
  if ((await continueBtn.count()) > 0) {
    await continueBtn.first().click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  }

  await page.locator('#trustlens-root .trustlens-panel').waitFor({ state: 'visible', timeout: 15000 });

  for (const seconds of [2, 5, 10, 15, 20]) {
    await page.waitForTimeout(seconds === 2 ? 2000 : 3000);
    const checks = await page.evaluate(() =>
      [...document.querySelectorAll('.trustlens-check')].map((row) => row.querySelector('.trustlens-check-label')?.textContent?.trim()),
    );
    console.log(`\n[t=${seconds}s cumulative] checks (${checks.length}):`, checks);
  }

  await page.close();
  await context.close();
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
