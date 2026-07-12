// verify-license.mjs
//
// Live verification of the Gumroad licensing wire-up (lib/license.ts) against
// the REAL installed Brave browser, following the same persistent-context
// pattern as verify.mjs. Does NOT fix anything it finds — it only reports.
//
// Covers:
//  - invalid key is rejected with a clear, non-scary message (real Gumroad API call)
//  - a successful verification (mocked Gumroad response, since we don't have a
//    real paid license key) activates Pro and unlocks unlimited AI deep-dives
//  - Pro state persists across a simulated browser restart (new context, same
//    profile dir)
//  - a network failure during re-verification does NOT demote an
//    already-activated Pro user back to free

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-license-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const BRAVE_PATH = 'C:\\Users\\Asus\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';

const results = {};
const consoleLog = [];
function log(line) {
  console.log(line);
  consoleLog.push(line);
}

async function launch() {
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
  return { context, extensionId };
}

async function main() {
  log('=== Building extension (npm run build) ===');
  execSync('npm run build', { stdio: 'inherit', cwd: __dirname });
  if (!fs.existsSync(EXTENSION_PATH)) throw new Error(`Build output not found at ${EXTENSION_PATH}`);
  if (!fs.existsSync(BRAVE_PATH)) throw new Error(`Brave not found at ${BRAVE_PATH}`);

  fs.mkdirSync(VERIFICATION_DIR, { recursive: true });
  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });

  // --- Phase 1: invalid key against the REAL Gumroad API ---
  log('\n=== Phase 1: invalid license key (real Gumroad API) ===');
  {
    const { context, extensionId } = await launch();
    try {
      const optionsPage = await context.newPage();
      await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
      await optionsPage.waitForTimeout(500);

      const licenseInput = optionsPage.locator('input[placeholder="XXXX-XXXX-XXXX"]');
      await licenseInput.fill('INVALID-TEST-KEY-0000');
      const verifyBtn = optionsPage.locator('.key-row button:has-text("Verify")');
      await verifyBtn.click();
      await optionsPage.waitForTimeout(2500);

      const bodyText = await optionsPage.locator('body').innerText();
      log(`Options body after invalid-key submit (excerpt): ${bodyText.slice(0, 400).replace(/\n+/g, ' | ')}`);

      results.invalid_key_rejected = !/Pro license active/i.test(bodyText);
      // "Clear, non-scary" — no raw stack traces / TypeError noise surfaced to the user.
      results.invalid_key_message_clean = !/TypeError|at Object\.|\.ts:\d+|undefined is not/i.test(bodyText);
      await optionsPage.screenshot({ path: path.join(VERIFICATION_DIR, 'license-invalid-key.png') });
      log('Screenshot saved: verification/license-invalid-key.png');
    } finally {
      await context.close();
    }
  }

  // --- Phase 2: mocked successful verification activates Pro ---
  log('\n=== Phase 2: mocked successful Gumroad verification activates Pro ===');
  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
  {
    const { context, extensionId } = await launch();
    try {
      const optionsPage = await context.newPage();
      await optionsPage.route('https://api.gumroad.com/v2/licenses/verify', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, purchase: { refunded: false, chargebacked: false } }),
        })
      );
      await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
      await optionsPage.waitForTimeout(500);

      const licenseInput = optionsPage.locator('input[placeholder="XXXX-XXXX-XXXX"]');
      await licenseInput.fill('MOCK-VALID-KEY-1234');
      const verifyBtn = optionsPage.locator('.key-row button:has-text("Verify")');
      await verifyBtn.click();
      await optionsPage.waitForTimeout(1500);

      const bodyText = await optionsPage.locator('body').innerText();
      results.valid_key_activates_pro = /Pro license active/i.test(bodyText) && /\bPro\b/.test(bodyText);
      await optionsPage.screenshot({ path: path.join(VERIFICATION_DIR, 'license-valid-key.png') });
      log(`Options body after mocked valid key (excerpt): ${bodyText.slice(0, 300).replace(/\n+/g, ' | ')}`);
      log('Screenshot saved: verification/license-valid-key.png');

      // Trial counter should be bypassed entirely once Pro — the "Free trial"
      // progress row is only rendered in the non-pro branch (Settings.tsx).
      results.trial_ui_hidden_when_pro = !/Free trial/i.test(bodyText);

      await optionsPage.close();
    } finally {
      await context.close();
    }
  }

  // --- Phase 3: Pro state persists across a simulated browser restart ---
  log('\n=== Phase 3: Pro persists across restart (new context, same profile) ===');
  {
    const { context, extensionId } = await launch();
    try {
      const optionsPage = await context.newPage();
      // No route mock here — checkProStatus() on load will hit the real API
      // with the mock key and fail/reject, EXCEPT we want to test that the
      // cached "pro" flag from storage is what renders first, before any
      // network re-check completes. So block the network this time to
      // isolate the persisted-storage read.
      await optionsPage.route('https://api.gumroad.com/v2/licenses/verify', (route) => route.abort('failed'));
      await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
      await optionsPage.waitForTimeout(1500);
      const bodyText = await optionsPage.locator('body').innerText();
      results.pro_persists_across_restart = /\bPro\b/.test(bodyText);
      log(`Options body after restart with network blocked (excerpt): ${bodyText.slice(0, 300).replace(/\n+/g, ' | ')}`);
      results.network_failure_does_not_lock_out_pro = !/Free plan|not accepted/i.test(bodyText);
      await optionsPage.screenshot({ path: path.join(VERIFICATION_DIR, 'license-restart-network-fail.png') });
      log('Screenshot saved: verification/license-restart-network-fail.png');
      await optionsPage.close();
    } finally {
      await context.close();
    }
  }

  log('\n=== RESULTS ===');
  for (const [key, value] of Object.entries(results)) {
    log(`[${value ? 'PASS' : 'FAIL'}] ${key}`);
  }
  fs.writeFileSync(path.join(VERIFICATION_DIR, 'license-console-log.txt'), consoleLog.join('\n'));
  log('\nFull log saved to verification/license-console-log.txt');

  const anyFail = Object.values(results).some((v) => !v);
  process.exitCode = anyFail ? 1 : 0;
}

main().catch((err) => {
  console.error('\n=== VERIFY-LICENSE.MJS CRASHED ===');
  console.error(err);
  fs.mkdirSync(VERIFICATION_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(VERIFICATION_DIR, 'license-console-log.txt'),
    consoleLog.join('\n') + '\n\nCRASH:\n' + String(err.stack || err)
  );
  process.exitCode = 1;
});
