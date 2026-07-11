// verify-light-lock.mjs — confirms TrustPanel and Popup render LIGHT even
// when the OS/browser color-scheme is forced to dark, and that Settings can
// still go dark (theme is a Settings-only concept now). Real Brave.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-light-lock-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const PRODUCT_URL = process.env.TL_VERIFY_URL || 'https://www.amazon.com/dp/B00FLYWNYQ';
const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';

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
    colorScheme: 'dark', // force OS/browser preference to dark for the whole context
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  const extensionId = sw ? new URL(sw.url()).hostname : null;
  console.log('Extension ID:', extensionId);

  const results = {};

  try {
    // ---- Popup under emulated OS dark mode ----
    const popupPage = await context.newPage();
    await popupPage.emulateMedia({ colorScheme: 'dark' });
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await popupPage.waitForTimeout(500);
    const popupReport = await popupPage.evaluate(() => {
      const shell = document.querySelector('.popup-shell');
      const cs = getComputedStyle(shell);
      return {
        hasDataThemeAttr: shell.hasAttribute('data-theme'),
        backgroundColor: cs.backgroundColor,
        color: cs.color,
        prefersColorSchemeDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
      };
    });
    console.log('[Popup under OS-dark]', JSON.stringify(popupReport, null, 2));
    results.popup = popupReport;
    await popupPage.screenshot({ path: path.join(VERIFICATION_DIR, 'll-popup-os-dark.png') });
    await popupPage.close();

    // ---- TrustPanel under emulated OS dark mode, on live Amazon ----
    const amazonPage = await context.newPage();
    await amazonPage.emulateMedia({ colorScheme: 'dark' });
    console.log(`Navigating to ${PRODUCT_URL} (OS dark) ...`);
    try {
      await amazonPage.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await clickThroughInterstitial(amazonPage);
      await amazonPage.waitForTimeout(4000);
      const panel = amazonPage.locator('#trustlens-root .trustlens-panel');
      await panel.waitFor({ state: 'visible', timeout: 15000 });
      const panelReport = await amazonPage.evaluate(() => {
        const el = document.querySelector('.trustlens-panel');
        const cs = getComputedStyle(el);
        const medallion = document.querySelector('.trustlens-medallion');
        const medallionCs = getComputedStyle(medallion);
        return {
          hasDataThemeAttr: el.hasAttribute('data-theme'),
          backgroundColor: cs.backgroundColor,
          color: cs.color,
          medallionBg: medallionCs.backgroundColor,
          prefersColorSchemeDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
        };
      });
      console.log('[TrustPanel under OS-dark]', JSON.stringify(panelReport, null, 2));
      results.trustPanel = panelReport;
      await panel.scrollIntoViewIfNeeded();
      await amazonPage.screenshot({ path: path.join(VERIFICATION_DIR, 'll-trustpanel-os-dark-full.png') });
      await panel.screenshot({ path: path.join(VERIFICATION_DIR, 'll-trustpanel-os-dark-closeup.png') });
    } catch (err) {
      console.log('TrustPanel did not appear:', err.message);
      results.trustPanelError = err.message;
    }
    await amazonPage.close();

    // ---- Settings: confirm dark still works (Settings-only feature) ----
    const settingsPage = await context.newPage();
    await settingsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
    await settingsPage.waitForTimeout(500);

    // default should be light (per new default), and only Light/Dark options exist
    const segButtons = await settingsPage.locator('.settings-section:has-text("Appearance") .segmented button').allTextContents();
    console.log('Appearance segmented options:', segButtons);
    results.appearanceOptions = segButtons;

    const defaultReport = await settingsPage.evaluate(() => ({
      dataTheme: document.querySelector('.settings-shell').getAttribute('data-theme'),
    }));
    console.log('[Settings default theme]', JSON.stringify(defaultReport));
    results.settingsDefaultTheme = defaultReport;

    await settingsPage.locator('.segmented button:has-text("Dark")').click();
    await settingsPage.waitForTimeout(300);
    const darkReport = await settingsPage.evaluate(() => {
      const shell = document.querySelector('.settings-shell');
      const cs = getComputedStyle(shell);
      return { dataTheme: shell.getAttribute('data-theme'), backgroundColor: cs.backgroundColor };
    });
    console.log('[Settings after clicking Dark]', JSON.stringify(darkReport));
    results.settingsDarkStillWorks = darkReport;
    await settingsPage.screenshot({ path: path.join(VERIFICATION_DIR, 'll-settings-dark-still-works.png'), fullPage: true });
    await settingsPage.close();
  } finally {
    await context.close();
  }

  fs.writeFileSync(path.join(VERIFICATION_DIR, 'light-lock-report.json'), JSON.stringify(results, null, 2));
  console.log('\n=== Report written to verification/light-lock-report.json ===');
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
