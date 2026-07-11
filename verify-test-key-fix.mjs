// verify-test-key-fix.mjs — final visual verification of the Test/Save
// button race fix: screenshots the "Testing…" loading state and the
// resulting inline pass/fail feedback next to the button, plus one more
// repeated-click consistency pass with a fake key.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-test-key-verify-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
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
  fs.mkdirSync(VERIFICATION_DIR, { recursive: true });

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
    if (req.url().includes('generativelanguage.googleapis.com')) reqCount++;
  });

  await page.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  const input = page.locator('input[placeholder="Paste API key"]').first();
  await input.click();
  await input.fill(FAKE_KEY);
  await page.waitForTimeout(200);

  // Screenshot mid-request: click, then grab the frame immediately (before
  // the fast fake-key rejection resolves) to catch the "Testing…" state.
  await page.locator('button:has-text("Test")').click();
  await page.screenshot({ path: path.join(VERIFICATION_DIR, 'tk-testing-state.png') });
  const midClickState = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Testing') || b.textContent.trim() === 'Test');
    return { text: btn?.textContent, disabled: btn?.disabled };
  });
  console.log('Mid-click button state:', midClickState);

  await waitForIdle(page);
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(VERIFICATION_DIR, 'tk-feedback-shown.png') });

  // 5x consistency pass
  console.log('\n=== 5x repeated Test clicks — checking for consistent result ===');
  const outcomes = [];
  for (let i = 1; i <= 5; i++) {
    await page.locator('button:has-text("Test")').click();
    await waitForIdle(page);
    const text = await page.evaluate(() => document.querySelector('.key-row-feedback')?.textContent ?? '(none)');
    outcomes.push(text);
    console.log(`click #${i}:`, text);
  }
  const allSame = outcomes.every((o) => o === outcomes[0]);
  console.log('\nAll 5 outcomes identical:', allSame);
  console.log('Total Gemini requests fired across entire run:', reqCount, '(expect exactly 6: 1 mid-click test + 5 consistency-pass clicks)');

  await page.close();
  await context.close();
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
