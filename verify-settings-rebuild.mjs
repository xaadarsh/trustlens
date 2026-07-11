// verify-settings-rebuild.mjs — verifies the full options/Settings.tsx
// restructure: single-column layout, grouped cards, the provider-key bug
// fix, crossfade timing, and light+dark theme tokens. Real Brave.

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

    // --- Bug-fix check: only ONE key input should exist in the DOM at a time ---
    const keyInputCountGemini = await page.locator('input[placeholder="Paste API key"]').count();
    console.log('Key input count (should be 1, not 2):', keyInputCountGemini);
    const geminiLabelVisible = await page.locator('.key-row-label:has-text("Gemini API key")').count();
    const openaiLabelVisible = await page.locator('.key-row-label:has-text("OpenAI API key")').count();
    console.log('Gemini key row present:', geminiLabelVisible, '| OpenAI key row present:', openaiLabelVisible);

    // Switch to OpenAI tab, confirm the field actually swaps.
    await page.locator('.segmented button:has-text("OpenAI")').click();
    await page.waitForTimeout(250);
    const afterSwitchGemini = await page.locator('.key-row-label:has-text("Gemini API key")').count();
    const afterSwitchOpenai = await page.locator('.key-row-label:has-text("OpenAI API key")').count();
    console.log('After switching to OpenAI tab — Gemini row present:', afterSwitchGemini, '| OpenAI row present:', afterSwitchOpenai);

    const crossfadeStyle = await page.locator('.key-field-wrap').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { animationName: cs.animationName, animationDuration: cs.animationDuration };
    });
    console.log('Crossfade animation:', JSON.stringify(crossfadeStyle));

    // Switch back to Gemini for a clean light-mode screenshot.
    await page.locator('.segmented button:has-text("Gemini")').click();
    await page.waitForTimeout(250);

    // --- LIGHT MODE ---
    const lightColors = await page.evaluate(() => {
      const shell = document.querySelector('.settings-shell');
      const cs = getComputedStyle(shell);
      const card = document.querySelector('.card');
      const cardCs = getComputedStyle(card);
      const activeSeg = document.querySelector('.segmented button.active');
      const activeSegCs = getComputedStyle(activeSeg);
      return {
        dataTheme: shell.getAttribute('data-theme'),
        pageBg: cs.backgroundColor,
        cardBg: cardCs.backgroundColor,
        segmentActiveBg: activeSegCs.backgroundColor,
        segmentActiveColor: activeSegCs.color,
      };
    });
    console.log('LIGHT mode computed:', JSON.stringify(lightColors, null, 2));
    await page.screenshot({ path: path.join(VERIFICATION_DIR, 'settings-rebuild-light.png'), fullPage: true });
    console.log('Saved: verification/settings-rebuild-light.png');

    // --- Switch to Dark theme via the actual UI control ---
    await page.locator('.segmented button:has-text("Dark")').click();
    await page.waitForTimeout(300);

    const darkColors = await page.evaluate(() => {
      const shell = document.querySelector('.settings-shell');
      const cs = getComputedStyle(shell);
      const card = document.querySelector('.card');
      const cardCs = getComputedStyle(card);
      const activeSeg = document.querySelector('.segmented button.active');
      const activeSegCs = getComputedStyle(activeSeg);
      const border = cardCs.borderTopColor;
      return {
        dataTheme: shell.getAttribute('data-theme'),
        pageBg: cs.backgroundColor,
        cardBg: cardCs.backgroundColor,
        cardBorder: border,
        segmentActiveBg: activeSegCs.backgroundColor,
        segmentActiveColor: activeSegCs.color,
      };
    });
    console.log('DARK mode computed:', JSON.stringify(darkColors, null, 2));
    await page.screenshot({ path: path.join(VERIFICATION_DIR, 'settings-rebuild-dark.png'), fullPage: true });
    console.log('Saved: verification/settings-rebuild-dark.png');

    await page.close();
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
