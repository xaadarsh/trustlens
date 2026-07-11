import { chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-button-hover-profile');
const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';

async function main() {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: BRAVE_PATH,
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  const extensionId = sw ? new URL(sw.url()).hostname : null;

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700); // let entrance settle fully first

  const btn = page.locator('button.primary');
  const box = await btn.boundingBox();
  console.log('Button bounding box:', box);

  // Move mouse directly to the button's center via raw mouse.move, not locator.hover()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await page.waitForTimeout(300);

  const state = await page.evaluate(() => {
    const el = document.querySelector('button.primary');
    const cs = getComputedStyle(el);
    return { transform: cs.transform, opacity: cs.opacity, matches: el.matches(':hover') };
  });
  console.log('After mouse.move to center:', state);

  await page.screenshot({ path: 'verification/diag-button-hover.png' });
  await context.close();
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
