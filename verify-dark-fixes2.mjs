// verify-dark-fixes2.mjs — verifies the html/body white-leak fix, dark
// scrollbar theming, and the revised near-neutral surface colors, via
// computed styles + screenshots. Real Brave.

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

const HELPERS = `
  function parseRgb(str) {
    const m = str.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/);
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] !== undefined ? +m[4] : 1 };
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
    viewport: { width: 1280, height: 600 },
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  const extensionId = sw ? new URL(sw.url()).hostname : null;

  try {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);

    // --- LIGHT MODE ---
    const lightReport = await page.evaluate(`(() => {
      ${HELPERS}
      const htmlCs = getComputedStyle(document.documentElement);
      const bodyCs = getComputedStyle(document.body);
      const shell = document.querySelector('.settings-shell');
      const shellCs = getComputedStyle(shell);
      const shellRect = shell.getBoundingClientRect();
      return {
        htmlDataTheme: document.documentElement.getAttribute('data-theme'),
        htmlBg: htmlCs.backgroundColor,
        bodyBg: bodyCs.backgroundColor,
        bodyMargin: bodyCs.margin,
        shellTopLeft: { top: shellRect.top, left: shellRect.left },
        shellBg: toHex(parseRgb(shellCs.backgroundColor)),
      };
    })()`);
    console.log('LIGHT mode:', JSON.stringify(lightReport, null, 2));
    await page.screenshot({ path: path.join(VERIFICATION_DIR, 'settings-final-light.png'), fullPage: true });

    // --- DARK MODE ---
    await page.locator('.segmented button:has-text("Dark")').click();
    await page.waitForTimeout(300);

    const darkReport = await page.evaluate(`(() => {
      ${HELPERS}
      const htmlCs = getComputedStyle(document.documentElement);
      const bodyCs = getComputedStyle(document.body);
      const shell = document.querySelector('.settings-shell');
      const shellCs = getComputedStyle(shell);
      const shellRect = shell.getBoundingClientRect();
      const card = document.querySelector('.card');
      const cardCs = getComputedStyle(card);
      const pageBgRaw = parseRgb(shellCs.backgroundColor);
      const cardBgRaw = parseRgb(cardCs.backgroundColor);
      const activeSeg = document.querySelector('.segmented button.active');
      const activeSegCs = getComputedStyle(activeSeg);

      return {
        htmlDataTheme: document.documentElement.getAttribute('data-theme'),
        htmlBg: htmlCs.backgroundColor,
        htmlBgHex: toHex(parseRgb(htmlCs.backgroundColor)),
        bodyBg: bodyCs.backgroundColor,
        bodyBgHex: toHex(parseRgb(bodyCs.backgroundColor)),
        bodyMargin: bodyCs.margin,
        shellTopLeft: { top: shellRect.top, left: shellRect.left },
        scrollbarColor: htmlCs.scrollbarColor,
        pageBgHex: toHex(pageBgRaw),
        cardBgHex: toHex(cardBgRaw),
        cardVsPageContrast: contrast(cardBgRaw, pageBgRaw),
        segmentActiveBg: activeSegCs.backgroundColor,
        segmentActiveColor: activeSegCs.color,
      };
    })()`);
    console.log('DARK mode:', JSON.stringify(darkReport, null, 2));

    await page.screenshot({ path: path.join(VERIFICATION_DIR, 'settings-final-dark.png'), fullPage: true });
    // Corner crop to directly inspect for any remaining edge gap.
    await page.screenshot({ path: path.join(VERIFICATION_DIR, 'settings-final-dark-corner.png'), clip: { x: 0, y: 0, width: 40, height: 40 } });
    // Scroll to bottom to check scrollbar + bottom edge.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(VERIFICATION_DIR, 'settings-final-dark-bottom.png') });

    fs.writeFileSync(
      path.join(VERIFICATION_DIR, 'dark-fixes2-report.json'),
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
