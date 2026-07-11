// verify-settings-redesign.mjs — one-off screenshot verification for the
// options/Settings.tsx redesign to the shared token system. Real Brave.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';

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

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  const extensionId = sw ? new URL(sw.url()).hostname : null;
  console.log('Extension ID:', extensionId);

  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(VERIFICATION_DIR, 'settings-redesign.png') });
    console.log('Saved: verification/settings-redesign.png');

    // Sanity-check no leftover teal anywhere in computed styles of key elements.
    const colors = await page.evaluate(() => {
      const grab = (sel, prop) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el)[prop] : null;
      };
      return {
        headerBg: grab('.settings-header', 'backgroundColor'),
        primaryButtonBg: grab('button.primary', 'backgroundColor'),
        primaryButtonColor: grab('button.primary', 'color'),
        activeSegmentBg: grab('.segmented button.active', 'backgroundColor'),
        cardBg: grab('.section', 'backgroundColor'),
        cardBorderColor: grab('.section', 'borderTopColor'),
        secondaryButtonBorderColor: grab('.button-row button:not(.primary)', 'borderTopColor'),
      };
    });
    console.log('Computed colors:', JSON.stringify(colors, null, 2));

    await page.close();
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
