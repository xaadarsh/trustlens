// verify-dark-contrast-fix.mjs — full re-verification after the dark-mode
// contrast fix: repeats the light+dark computed-style checks from the last
// pass, plus the three specific contrast-ratio checks from this pass.
// Real Brave, screenshots of both modes.

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

  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);

    // --- LIGHT MODE (default) ---
    const lightReport = await page.evaluate(`(() => {
      ${CONTRAST_HELPERS}
      const shell = document.querySelector('.settings-shell');
      const shellCs = getComputedStyle(shell);
      const card = document.querySelector('.card');
      const cardCs = getComputedStyle(card);
      const activeSeg = document.querySelector('.segmented button.active');
      const activeSegCs = getComputedStyle(activeSeg);
      const pageBg = parseRgb(shellCs.backgroundColor);
      const cardBg = parseRgb(cardCs.backgroundColor);
      return {
        dataTheme: shell.getAttribute('data-theme'),
        pageBg: toHex(pageBg),
        cardBg: toHex(cardBg),
        cardVsPageContrast: contrast(cardBg, pageBg),
        segmentActiveBg: activeSegCs.backgroundColor,
        segmentActiveColor: activeSegCs.color,
      };
    })()`);
    console.log('LIGHT mode:', JSON.stringify(lightReport, null, 2));
    await page.screenshot({ path: path.join(VERIFICATION_DIR, 'settings-rebuild-light.png'), fullPage: true });

    // --- DARK MODE ---
    await page.locator('.segmented button:has-text("Dark")').click();
    await page.waitForTimeout(300);

    const darkReport = await page.evaluate(`(() => {
      ${CONTRAST_HELPERS}
      const shell = document.querySelector('.settings-shell');
      const shellCs = getComputedStyle(shell);
      const card = document.querySelector('.card');
      const cardCs = getComputedStyle(card);
      const activeSeg = document.querySelector('.segmented button.active');
      const activeSegCs = getComputedStyle(activeSeg);
      const pageBgRaw = parseRgb(shellCs.backgroundColor);
      const cardBgRaw = parseRgb(cardCs.backgroundColor);
      const cardBorderRaw = parseRgb(cardCs.borderTopColor);
      const cardBorderBlended = blend(cardBorderRaw, cardBgRaw);

      const icons = [...document.querySelectorAll('.section-label')].map((label) => {
        const svg = label.querySelector('svg');
        const svgCs = getComputedStyle(svg);
        const c = parseRgb(svgCs.color);
        return { section: label.textContent.trim(), color: toHex(c), contrastVsPage: contrast(c, pageBgRaw) };
      });

      const testBtn = document.querySelector('.btn-outline-sm');
      const testBtnCs = getComputedStyle(testBtn);
      const testBtnBorderRaw = parseRgb(testBtnCs.borderTopColor);
      const testBtnBorderBlended = blend(testBtnBorderRaw, cardBgRaw);

      const input = document.querySelector('input');
      const inputCs = getComputedStyle(input);
      const inputBgRaw = parseRgb(inputCs.backgroundColor);

      return {
        dataTheme: shell.getAttribute('data-theme'),
        pageBg: toHex(pageBgRaw),
        cardBg: toHex(cardBgRaw),
        cardVsPageContrast: contrast(cardBgRaw, pageBgRaw),
        cardBorder: { raw: cardCs.borderTopColor, blendedHex: toHex(cardBorderBlended), contrastVsCard: contrast(cardBorderBlended, cardBgRaw) },
        segmentActiveBg: activeSegCs.backgroundColor,
        segmentActiveColor: activeSegCs.color,
        sectionLabelIcons: icons,
        testButtonBorder: { raw: testBtnCs.borderTopColor, contrastVsCard: contrast(testBtnBorderBlended, cardBgRaw) },
        inputBg: toHex(inputBgRaw),
        inputVsCardContrast: contrast(inputBgRaw, cardBgRaw),
      };
    })()`);
    console.log('DARK mode:', JSON.stringify(darkReport, null, 2));
    await page.screenshot({ path: path.join(VERIFICATION_DIR, 'settings-rebuild-dark.png'), fullPage: true });

    fs.writeFileSync(
      path.join(VERIFICATION_DIR, 'dark-contrast-fix-report.json'),
      JSON.stringify({ light: lightReport, dark: darkReport }, null, 2),
    );

    await page.close();
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
