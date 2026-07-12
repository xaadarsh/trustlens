// verify-popup-overflow.mjs
//
// Live verification of the popup "Recent checks" title-truncation fix
// (entrypoints/popup/App.css .history-title) against the REAL installed
// Brave browser, same persistent-context pattern as verify.mjs.
// Does NOT fix anything it finds — it only reports.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-popup-overflow-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const BRAVE_PATH = 'C:\\Users\\Asus\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';

const LONG_TITLE =
  'AULA F99 96% Wireless Mechanical Keyboard, Tri-Mode Bluetooth/2.4G/Type-C Hot-Swappable Gasket Mount Keyboard with Rotary Knob, PBT Keycaps, RGB Backlit for Windows/Mac (Black, Brown Switch)';

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
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  if (!sw) throw new Error('Could not find the extension service worker — extension may not have loaded.');
  const extensionId = new URL(sw.url()).hostname;
  log(`Extension ID resolved: ${extensionId}`);

  try {
    // Seed chrome.storage.local with fake history entries (long titles, incl.
    // AULA F99) directly from the service worker context.
    const seeded = await sw.evaluate(async (title) => {
      const entries = [
        { asin: 'B0AULAF99X', title, grade: 'B', date: Date.now() },
        {
          asin: 'B0SHORT0001',
          title: 'Short title product',
          grade: 'A',
          date: Date.now() - 1000,
        },
      ];
      await chrome.storage.local.set({ gradelens_history: entries });
      const readback = await chrome.storage.local.get('gradelens_history');
      return readback.gradelens_history;
    }, LONG_TITLE);
    log(`Seeded history entries: ${JSON.stringify(seeded).slice(0, 200)}...`);

    const popupPage = await context.newPage();
    popupPage.on('console', (msg) => consoleLog.push(`[popup] [${msg.type()}] ${msg.text()}`));
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await popupPage.waitForTimeout(600);

    const row = popupPage.locator('.history-row').first();
    const titleEl = popupPage.locator('.history-title').first();
    const gradeEl = popupPage.locator('.history-grade').first();

    const rowBox = await row.boundingBox();
    const titleBox = await titleEl.boundingBox();
    const gradeBox = await gradeEl.boundingBox();
    const scrollWidth = await titleEl.evaluate((el) => el.scrollWidth);
    const clientWidth = await titleEl.evaluate((el) => el.clientWidth);
    const cardBox = await popupPage.locator('.history-card').first().boundingBox();

    log(`history-card box: ${JSON.stringify(cardBox)}`);
    log(`history-row box: ${JSON.stringify(rowBox)}`);
    log(`history-title box: ${JSON.stringify(titleBox)} scrollWidth=${scrollWidth} clientWidth=${clientWidth}`);
    log(`history-grade box: ${JSON.stringify(gradeBox)}`);

    // 1. The title element itself must not extend past the card's right edge.
    results.title_does_not_overflow_card = titleBox.x + titleBox.width <= cardBox.x + cardBox.width + 1;
    // 2. Ellipsis is actually engaged (content wider than the box it's clipped into).
    results.ellipsis_engaged = scrollWidth > clientWidth;
    // 3. Grade badge keeps its intended 18x18 size (not squeezed by the long title).
    results.grade_badge_not_squeezed = gradeBox.width >= 17 && gradeBox.height >= 17;
    // 4. Popup window itself has no horizontal scrollbar (nothing pushed the body wider).
    const bodyOverflowsX = await popupPage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    results.no_horizontal_page_overflow = !bodyOverflowsX;

    await popupPage.screenshot({ path: path.join(VERIFICATION_DIR, 'popup-history-overflow-light.png') });
    log('Screenshot saved: verification/popup-history-overflow-light.png');

    // The popup is deliberately light-only (never themed off OS/Appearance —
    // see App.tsx comment), so there is no dark-mode popup state to test. Set
    // the OS color scheme to dark anyway and confirm the popup stays
    // unaffected / still doesn't overflow, covering the "dark mode" ask.
    await popupPage.emulateMedia({ colorScheme: 'dark' });
    await popupPage.waitForTimeout(300);
    const titleBoxDark = await titleEl.boundingBox();
    const cardBoxDark = await popupPage.locator('.history-card').first().boundingBox();
    results.no_overflow_under_os_dark_scheme = titleBoxDark.x + titleBoxDark.width <= cardBoxDark.x + cardBoxDark.width + 1;
    await popupPage.screenshot({ path: path.join(VERIFICATION_DIR, 'popup-history-overflow-dark-os.png') });
    log('Screenshot saved: verification/popup-history-overflow-dark-os.png (OS dark scheme emulated; popup itself is light-only by design)');

    await popupPage.close();
  } finally {
    await context.close();
  }

  log('\n=== RESULTS ===');
  for (const [key, value] of Object.entries(results)) {
    log(`[${value ? 'PASS' : 'FAIL'}] ${key}`);
  }
  fs.writeFileSync(path.join(VERIFICATION_DIR, 'popup-overflow-console-log.txt'), consoleLog.join('\n'));
  log('\nFull log saved to verification/popup-overflow-console-log.txt');

  const anyFail = Object.values(results).some((v) => !v);
  process.exitCode = anyFail ? 1 : 0;
}

main().catch((err) => {
  console.error('\n=== VERIFY-POPUP-OVERFLOW.MJS CRASHED ===');
  console.error(err);
  fs.mkdirSync(VERIFICATION_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(VERIFICATION_DIR, 'popup-overflow-console-log.txt'),
    consoleLog.join('\n') + '\n\nCRASH:\n' + String(err.stack || err)
  );
  process.exitCode = 1;
});
