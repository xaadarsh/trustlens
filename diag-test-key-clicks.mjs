// diag-test-key-clicks.mjs — real-browser diagnostic for the "Test connection"
// flip-flop bug report. Loads the real extension, pastes a syntactically
// valid but fake Gemini key (not a real credential — just enough to trigger
// a real network round-trip to Google's API), and clicks Test multiple
// times both slowly and rapidly, logging every console message and every
// network request/response to the Gemini endpoint.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-test-key-diag-profile');
const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';
const FAKE_KEY = 'AIzaSyFAKE_DIAGNOSTIC_KEY_NOT_REAL_00000';

async function waitForIdle(page, timeoutMs = 15000) {
  await page.waitForFunction(
    () => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Test'));
      return btn && !btn.disabled;
    },
    { timeout: timeoutMs },
  );
}

async function main() {
  console.log('=== Building extension ===');
  execSync('npm run build', { stdio: 'inherit', cwd: __dirname });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: BRAVE_PATH,
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  const extensionId = sw ? new URL(sw.url()).hostname : null;

  const page = await context.newPage();

  let reqCount = 0;
  page.on('request', (req) => {
    if (req.url().includes('generativelanguage.googleapis.com')) {
      reqCount++;
      console.log(`>>> [network] REQUEST #${reqCount} to Gemini at t=${Date.now()}`);
    }
  });
  page.on('response', (res) => {
    if (res.url().includes('generativelanguage.googleapis.com')) {
      console.log(`<<< [network] RESPONSE status=${res.status()} at t=${Date.now()}`);
    }
  });
  page.on('console', (msg) => {
    if (msg.text().includes('TrustLens')) console.log('[console]', msg.text());
  });

  await page.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  const input = page.locator('input[placeholder="Paste API key"]').first();
  await input.click();
  await input.fill(FAKE_KEY);
  await page.waitForTimeout(300);

  console.log('\n=== TEST 1: single click, wait for it to finish, repeat 3x with delay ===');
  for (let i = 1; i <= 3; i++) {
    console.log(`\n--- click #${i} (slow, waiting for idle before next) ---`);
    await page.locator('button:has-text("Test")').click();
    await waitForIdle(page);
    const status = await page.evaluate(() => document.querySelector('.key-row-feedback')?.textContent ?? '(none)');
    console.log(`inline feedback after click #${i}:`, status);
  }

  console.log('\n=== TEST 2: two clicks dispatched in the SAME tick (true simultaneous double-fire) ===');
  await waitForIdle(page);
  reqCount = 0;
  const buttonDuringClick = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim().startsWith('Test'));
    const btn = buttons[0];
    btn.click();
    btn.click();
    // Capture button state synchronously, in the same tick as the two clicks,
    // to see whether the second click was actually blocked by the disabled
    // attribute React set after the first click's state update.
    return { disabledRightAfter: btn.disabled, textRightAfter: btn.textContent };
  });
  console.log('Button state immediately after both synchronous clicks:', buttonDuringClick);
  await page.waitForTimeout(3000);
  const statusAfterDouble = await page.evaluate(() => document.querySelector('.key-row-feedback')?.textContent ?? '(none)');
  console.log('Requests fired during same-tick double-click:', reqCount);
  console.log('inline feedback after same-tick double-click:', statusAfterDouble);

  await page.close();
  await context.close();
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
