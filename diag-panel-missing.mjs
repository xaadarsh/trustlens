import { chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-panel-debug2-profile');
const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';
const URL = process.argv[2] || 'https://www.amazon.in/dp/B08RQJKF6D';

async function main() {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: BRAVE_PATH,
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });
  const page = await context.newPage();
  page.on('console', (msg) => console.log('[console]', msg.type(), msg.text()));
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const btn = page.locator('button:has-text("Continue shopping")');
  if ((await btn.count()) > 0) {
    await btn.first().click();
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(6000);

  const rootExists = await page.evaluate(() => !!document.getElementById('trustlens-root'));
  const panelExists = await page.evaluate(() => !!document.querySelector('.trustlens-panel'));
  console.log('trustlens-root exists:', rootExists, 'panel exists:', panelExists);
  await page.screenshot({ path: 'verification/debug-panel-missing.png', fullPage: true });

  await context.close();
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
