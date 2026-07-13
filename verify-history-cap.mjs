// verify-history-cap.mjs
//
// Live verification of the popup history display cap (3, distinct from
// lib/history.ts's 100-entry storage cap) and the new "Clear history"
// action in Settings, against the REAL installed Brave browser with the
// extension loaded, same pattern as verify.mjs. Does NOT fix anything it
// finds — it only reports.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-history-cap-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const BRAVE_PATH = 'C:\\Users\\Asus\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';

const results = {};
const consoleLog = [];
function log(line) {
  console.log(line);
  consoleLog.push(line);
}

function seedEntries(count) {
  const grades = ['A', 'B', 'C', 'D', 'F'];
  return Array.from({ length: count }, (_, i) => ({
    asin: `B0HIST${String(i).padStart(4, '0')}`,
    title: `Seeded Test Product #${count - i} — a reasonably long product title to check layout`,
    grade: grades[i % grades.length],
    date: Date.now() - i * 60000,
  }));
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
  if (!sw) throw new Error('Could not find the extension service worker — extension may not have loaded.');
  const extensionId = new URL(sw.url()).hostname;
  log(`Extension ID resolved: ${extensionId}`);

  try {
    // --- Seed 12 history entries directly into storage (well over the
    // display cap, under the 100-entry storage cap) ---
    log('\n=== Seeding 12 history entries into chrome.storage.local ===');
    const seeded = seedEntries(12);
    await sw.evaluate(async (entries) => {
      await chrome.storage.local.set({ gradelens_history: entries });
    }, seeded);
    const readBack = await sw.evaluate(async () => {
      const stored = await chrome.storage.local.get('gradelens_history');
      return stored.gradelens_history?.length ?? 0;
    });
    log(`Storage now holds ${readBack} entries (seeded 12).`);
    results.storage_holds_all_seeded_entries = readBack === 12;

    // --- Open popup, check the DISPLAY cap ---
    log('\n=== Opening popup with 12 stored entries ===');
    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await popupPage.waitForTimeout(600);

    const historyRowCount = await popupPage.locator('.history-row').count();
    log(`Popup renders ${historyRowCount} .history-row elements (expect exactly 3).`);
    results.popup_shows_exactly_3_of_12 = historyRowCount === 3;

    // Confirm it shows the 3 MOST RECENT (seeded entries are already
    // most-recent-first, index 0 = "Seeded Test Product #12").
    const firstRowText = await popupPage.locator('.history-row').first().locator('.history-title').textContent();
    log(`First rendered row title: "${firstRowText}"`);
    results.popup_shows_most_recent_first = (firstRowText ?? '').includes('#12');

    // Confirm the popup body stays compact — no scrollbar, fixed-ish height
    // regardless of how many entries are in storage.
    const bodyBox = await popupPage.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
    }));
    log(`Popup document scrollHeight=${bodyBox.scrollHeight} clientHeight=${bodyBox.clientHeight}`);
    results.popup_has_no_vertical_overflow = bodyBox.scrollHeight <= bodyBox.clientHeight + 2;
    await popupPage.screenshot({ path: path.join(VERIFICATION_DIR, 'history-cap-popup-12-entries.png') });
    await popupPage.close();

    // --- Open Settings, click "Clear history", confirm storage empties ---
    log('\n=== Settings: clicking "Clear history" ===');
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
    await optionsPage.waitForTimeout(600);

    const clearBtn = optionsPage.locator('button:has-text("Clear history")');
    const clearBtnVisible = (await clearBtn.count()) > 0;
    results.clear_history_button_present = clearBtnVisible;

    if (clearBtnVisible) {
      await clearBtn.click();
      await optionsPage.waitForTimeout(800);
      const feedbackText = await optionsPage.locator('body').innerText();
      results.clear_history_shows_confirmation = /cleared/i.test(feedbackText);
      await optionsPage.screenshot({ path: path.join(VERIFICATION_DIR, 'history-cap-settings-cleared.png') });

      const afterClear = await sw.evaluate(async () => {
        const stored = await chrome.storage.local.get('gradelens_history');
        return stored.gradelens_history;
      });
      log(`Storage after Clear history: ${JSON.stringify(afterClear)}`);
      results.storage_actually_emptied = afterClear === undefined || (Array.isArray(afterClear) && afterClear.length === 0);
    }
    await optionsPage.close();

    // --- Reopen popup: history card should be gone entirely (history.length === 0) ---
    log('\n=== Reopening popup after clear — history card should be gone ===');
    const popupPage2 = await context.newPage();
    await popupPage2.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await popupPage2.waitForTimeout(600);
    const historyCardCount = await popupPage2.locator('.history-card').count();
    log(`.history-card count after clear: ${historyCardCount}`);
    results.popup_history_card_gone_after_clear = historyCardCount === 0;
    await popupPage2.screenshot({ path: path.join(VERIFICATION_DIR, 'history-cap-popup-after-clear.png') });
    await popupPage2.close();
  } finally {
    await context.close();
  }

  log('\n=== RESULTS ===');
  for (const [key, value] of Object.entries(results)) {
    log(`[${value ? 'PASS' : 'FAIL'}] ${key}`);
  }
  fs.writeFileSync(path.join(VERIFICATION_DIR, 'history-cap-console-log.txt'), consoleLog.join('\n'));
  log('\nFull log saved to verification/history-cap-console-log.txt');

  const anyFail = Object.values(results).some((v) => !v);
  process.exitCode = anyFail ? 1 : 0;
}

main().catch((err) => {
  console.error('\n=== VERIFY-HISTORY-CAP.MJS CRASHED ===');
  console.error(err);
  fs.mkdirSync(VERIFICATION_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(VERIFICATION_DIR, 'history-cap-console-log.txt'),
    consoleLog.join('\n') + '\n\nCRASH:\n' + String(err.stack || err)
  );
  process.exitCode = 1;
});
