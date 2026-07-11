// verify-warm-editorial.mjs — verification for the Warm Editorial redesign
// (shared tokens.css across TrustPanel/Popup/Settings). Checks light + dark
// computed styles/contrast on all three surfaces, screenshots each, and
// scans for any leftover navy/brass hex residue. Real Brave.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-warm-editorial-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const PRODUCT_URL = process.env.TL_VERIFY_URL || 'https://www.amazon.com/dp/B00FLYWNYQ';
const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';

const NAVY_BRASS_HEXES = ['1f2a44', 'c9973f', '5b6472', 'f5f6f2', '3f7a5c', 'b54834'];

const CONTRAST_HELPERS = `
  function parseRgb(str) {
    const m = str.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/);
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] !== undefined ? +m[4] : 1 };
  }
  function blend(fg, bg) {
    const a = fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) };
  }
  function relLum({ r, g, b }) {
    const chan = (c) => { const cs = c / 255; return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4); };
    return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
  }
  function contrast(c1, c2) {
    const l1 = relLum(c1), l2 = relLum(c2);
    const lighter = Math.max(l1, l2), darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }
  function toHex({ r, g, b }) {
    const h = (n) => Math.round(n).toString(16).padStart(2, '0');
    return ('#' + h(r) + h(g) + h(b)).toUpperCase();
  }
`;

async function clickThroughInterstitial(page) {
  const continueBtn = page.locator('button:has-text("Continue shopping"), input[value="Continue shopping"]');
  if ((await continueBtn.count()) > 0) {
    await continueBtn.first().click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
}

async function checkSettingsContrast(page, label) {
  const report = await page.evaluate(`(() => {
    ${CONTRAST_HELPERS}
    const shell = document.querySelector('.settings-shell');
    const shellCs = getComputedStyle(shell);
    const card = document.querySelector('.card');
    const cardCs = getComputedStyle(card);
    const rowLabel = document.querySelector('.row-label');
    const rowLabelCs = getComputedStyle(rowLabel);
    const secondary = document.querySelector('.section-label');
    const secondaryCs = getComputedStyle(secondary);
    const activeSeg = document.querySelector('.segmented button.active');
    const activeSegCs = getComputedStyle(activeSeg);
    const primaryBtn = document.querySelector('.btn-primary-sm');
    const primaryBtnCs = getComputedStyle(primaryBtn);
    const wordmark = document.querySelector('.settings-wordmark');
    const wordmarkCs = getComputedStyle(wordmark);
    const h1 = document.querySelector('h1');
    const h1Cs = getComputedStyle(h1);

    const pageBg = parseRgb(shellCs.backgroundColor);
    const cardBg = parseRgb(cardCs.backgroundColor);
    const rowLabelColor = parseRgb(rowLabelCs.color);
    const secondaryColor = parseRgb(secondaryCs.color);
    const activeSegBg = parseRgb(activeSegCs.backgroundColor);
    const activeSegColor = parseRgb(activeSegCs.color);
    const primaryBtnBg = parseRgb(primaryBtnCs.backgroundColor);
    const primaryBtnColor = parseRgb(primaryBtnCs.color);

    return {
      dataTheme: shell.getAttribute('data-theme'),
      wordmarkFont: wordmarkCs.fontFamily,
      h1Font: h1Cs.fontFamily,
      pageBg: toHex(pageBg),
      cardBg: toHex(cardBg),
      cardVsPageContrast: contrast(cardBg, pageBg),
      rowLabelVsCardContrast: contrast(rowLabelColor, cardBg),
      secondaryVsPageContrast: contrast(secondaryColor, pageBg),
      activeSegBg: toHex(activeSegBg),
      activeSegColor: toHex(activeSegColor),
      activeSegContrast: contrast(activeSegColor, activeSegBg),
      primaryBtnBg: toHex(primaryBtnBg),
      primaryBtnColor: toHex(primaryBtnColor),
      primaryBtnContrast: contrast(primaryBtnColor, primaryBtnBg),
    };
  })()`);
  console.log(`[Settings ${label}]`, JSON.stringify(report, null, 2));
  return report;
}

async function main() {
  console.log('=== Building extension ===');
  execSync('npm run build', { stdio: 'inherit', cwd: __dirname });

  console.log('=== Scanning built output for navy/brass residue ===');
  const outDir = path.join(__dirname, '.output', 'chrome-mv3');
  const residue = [];
  for (const file of walk(outDir)) {
    if (!/\.(css|js)$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8').toLowerCase();
    for (const hex of NAVY_BRASS_HEXES) {
      if (text.includes(hex)) residue.push(`${hex} found in ${path.relative(outDir, file)}`);
    }
  }
  if (residue.length) {
    console.log('RESIDUE FOUND:\n' + residue.join('\n'));
  } else {
    console.log('No navy/brass hex residue found in built output.');
  }

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

  const results = { residue };

  try {
    // ---- Settings: explicit LIGHT ----
    const settingsPage = await context.newPage();
    await settingsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
    await settingsPage.waitForTimeout(600);
    await settingsPage.locator('.segmented button:has-text("Light")').click();
    await settingsPage.waitForTimeout(300);
    results.settingsLight = await checkSettingsContrast(settingsPage, 'light');
    await settingsPage.screenshot({ path: path.join(VERIFICATION_DIR, 'we-settings-light.png'), fullPage: true });

    // ---- Popup: LIGHT (storage already set to light) ----
    const popupLight = await context.newPage();
    await popupLight.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await popupLight.waitForTimeout(500);
    await popupLight.screenshot({ path: path.join(VERIFICATION_DIR, 'we-popup-light.png') });
    await popupLight.close();

    // ---- Settings: explicit DARK ----
    await settingsPage.locator('.segmented button:has-text("Dark")').click();
    await settingsPage.waitForTimeout(300);
    results.settingsDark = await checkSettingsContrast(settingsPage, 'dark');
    await settingsPage.screenshot({ path: path.join(VERIFICATION_DIR, 'we-settings-dark.png'), fullPage: true });
    await settingsPage.close();

    // ---- Popup: DARK ----
    const popupDark = await context.newPage();
    await popupDark.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await popupDark.waitForTimeout(500);
    await popupDark.screenshot({ path: path.join(VERIFICATION_DIR, 'we-popup-dark.png') });
    await popupDark.close();

    // ---- TrustPanel: DARK (storage already dark) ----
    const amazonDark = await context.newPage();
    console.log(`Navigating to ${PRODUCT_URL} (dark) ...`);
    let panelDarkVisible = false;
    try {
      await amazonDark.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await clickThroughInterstitial(amazonDark);
      await amazonDark.waitForTimeout(4000);
      const panel = amazonDark.locator('#trustlens-root .trustlens-panel');
      await panel.waitFor({ state: 'visible', timeout: 15000 });
      panelDarkVisible = true;
      const panelReport = await amazonDark.evaluate(`(() => {
        ${CONTRAST_HELPERS}
        const panel = document.querySelector('.trustlens-panel');
        const panelCs = getComputedStyle(panel);
        const medallion = document.querySelector('.trustlens-medallion');
        const medallionCs = getComputedStyle(medallion);
        const letter = document.querySelector('.trustlens-medallion-letter');
        const letterCs = getComputedStyle(letter);
        const title = document.querySelector('.trustlens-title');
        const titleCs = getComputedStyle(title);
        const cardBg = parseRgb(panelCs.backgroundColor);
        const medallionBg = parseRgb(medallionCs.backgroundColor);
        const letterColor = parseRgb(letterCs.color);
        const titleColor = parseRgb(titleCs.color);
        return {
          dataTheme: panel.getAttribute('data-theme'),
          cardBg: toHex(cardBg),
          medallionBg: toHex(medallionBg),
          medallionRadius: medallionCs.borderTopLeftRadius,
          letterFont: letterCs.fontFamily,
          letterVsMedallionContrast: contrast(letterColor, medallionBg),
          titleVsCardContrast: contrast(titleColor, cardBg),
          titleFont: titleCs.fontFamily,
        };
      })()`);
      console.log('[TrustPanel dark]', JSON.stringify(panelReport, null, 2));
      results.trustPanelDark = panelReport;
      await panel.scrollIntoViewIfNeeded();
      await amazonDark.screenshot({ path: path.join(VERIFICATION_DIR, 'we-trustpanel-dark-full.png') });
      await panel.screenshot({ path: path.join(VERIFICATION_DIR, 'we-trustpanel-dark-closeup.png') });
    } catch (err) {
      console.log('TrustPanel (dark) did not appear:', err.message);
      await amazonDark.screenshot({ path: path.join(VERIFICATION_DIR, 'we-trustpanel-dark-full.png') }).catch(() => {});
    }
    await amazonDark.close();
    results.trustPanelDarkVisible = panelDarkVisible;

    // ---- Switch back to LIGHT, then TrustPanel: LIGHT ----
    const settingsPage2 = await context.newPage();
    await settingsPage2.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
    await settingsPage2.waitForTimeout(500);
    await settingsPage2.locator('.segmented button:has-text("Light")').click();
    await settingsPage2.waitForTimeout(300);
    await settingsPage2.close();

    const amazonLight = await context.newPage();
    console.log(`Navigating to ${PRODUCT_URL} (light) ...`);
    let panelLightVisible = false;
    try {
      await amazonLight.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await clickThroughInterstitial(amazonLight);
      await amazonLight.waitForTimeout(4000);
      const panel = amazonLight.locator('#trustlens-root .trustlens-panel');
      await panel.waitFor({ state: 'visible', timeout: 15000 });
      panelLightVisible = true;
      const panelReport = await amazonLight.evaluate(`(() => {
        ${CONTRAST_HELPERS}
        const panel = document.querySelector('.trustlens-panel');
        const panelCs = getComputedStyle(panel);
        const medallion = document.querySelector('.trustlens-medallion');
        const medallionCs = getComputedStyle(medallion);
        const letter = document.querySelector('.trustlens-medallion-letter');
        const letterCs = getComputedStyle(letter);
        const title = document.querySelector('.trustlens-title');
        const titleCs = getComputedStyle(title);
        const bodyBg = parseRgb(getComputedStyle(document.body).backgroundColor);
        const cardBg = parseRgb(panelCs.backgroundColor);
        const medallionBg = parseRgb(medallionCs.backgroundColor);
        const letterColor = parseRgb(letterCs.color);
        const titleColor = parseRgb(titleCs.color);
        return {
          dataTheme: panel.getAttribute('data-theme'),
          amazonBodyBg: toHex(bodyBg),
          cardBg: toHex(cardBg),
          cardVsAmazonBodyContrast: contrast(cardBg, bodyBg),
          medallionBg: toHex(medallionBg),
          medallionRadius: medallionCs.borderTopLeftRadius,
          letterFont: letterCs.fontFamily,
          letterVsMedallionContrast: contrast(letterColor, medallionBg),
          titleVsCardContrast: contrast(titleColor, cardBg),
          titleFont: titleCs.fontFamily,
        };
      })()`);
      console.log('[TrustPanel light]', JSON.stringify(panelReport, null, 2));
      results.trustPanelLight = panelReport;
      await panel.scrollIntoViewIfNeeded();
      await amazonLight.screenshot({ path: path.join(VERIFICATION_DIR, 'we-trustpanel-light-full.png') });
      await panel.screenshot({ path: path.join(VERIFICATION_DIR, 'we-trustpanel-light-closeup.png') });
    } catch (err) {
      console.log('TrustPanel (light) did not appear:', err.message);
      await amazonLight.screenshot({ path: path.join(VERIFICATION_DIR, 'we-trustpanel-light-full.png') }).catch(() => {});
    }
    await amazonLight.close();
    results.trustPanelLightVisible = panelLightVisible;
  } finally {
    await context.close();
  }

  fs.writeFileSync(path.join(VERIFICATION_DIR, 'warm-editorial-report.json'), JSON.stringify(results, null, 2));
  console.log('\n=== Report written to verification/warm-editorial-report.json ===');
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
