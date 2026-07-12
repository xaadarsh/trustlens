// verify-icon.mjs — confirms the new GradeLens icon is correctly wired
// into the built manifest and renders on chrome://extensions (a regular
// page Playwright can inspect/screenshot). The native browser-toolbar
// action icon itself is outside Playwright's capture surface — no
// automation tool can screenshot that OS-level chrome — so this checks the
// icon file, its manifest wiring, and its rendering everywhere Chrome
// actually surfaces it as page content, which is the practical proxy.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-icon-verify-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';

async function main() {
  console.log('=== Building extension ===');
  execSync('npm run build', { stdio: 'inherit', cwd: __dirname });

  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_PATH, 'manifest.json'), 'utf8'));
  console.log('\nmanifest.icons:', JSON.stringify(manifest.icons));
  console.log('manifest.action:', JSON.stringify(manifest.action));
  for (const [size, iconPath] of Object.entries(manifest.icons)) {
    const full = path.join(EXTENSION_PATH, iconPath.replace(/^\//, ''));
    const exists = fs.existsSync(full);
    const bytes = exists ? fs.statSync(full).size : 0;
    console.log(`  icon ${size}: ${iconPath} exists=${exists} bytes=${bytes}`);
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
  console.log('\nExtension ID:', extensionId);

  const page = await context.newPage();
  await page.goto('chrome://extensions/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  // chrome://extensions renders each item inside a <extensions-item> custom
  // element with the icon in its shadow DOM — pierce it directly.
  const iconInfo = await page.evaluate((id) => {
    const manager = document.querySelector('extensions-manager');
    const itemList = manager?.shadowRoot?.querySelector('extensions-item-list');
    const item = itemList?.shadowRoot?.querySelector(`extensions-item[id="${id}"]`);
    const img = item?.shadowRoot?.querySelector('#icon');
    return {
      found: !!item,
      iconSrc: img?.src ?? null,
      iconNaturalWidth: img?.naturalWidth ?? null,
      iconNaturalHeight: img?.naturalHeight ?? null,
    };
  }, extensionId);
  console.log('\nchrome://extensions icon info:', JSON.stringify(iconInfo, null, 2));

  await page.screenshot({ path: path.join(VERIFICATION_DIR, 'icon-chrome-extensions-page.png'), fullPage: false });
  console.log('Screenshot saved: verification/icon-chrome-extensions-page.png');

  // Zoom in on just the extension card for a close-up check.
  const cardBox = await page.evaluate((id) => {
    const manager = document.querySelector('extensions-manager');
    const itemList = manager?.shadowRoot?.querySelector('extensions-item-list');
    const item = itemList?.shadowRoot?.querySelector(`extensions-item[id="${id}"]`);
    const rect = item?.getBoundingClientRect();
    return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
  }, extensionId);
  if (cardBox) {
    await page.screenshot({ path: path.join(VERIFICATION_DIR, 'icon-chrome-extensions-card.png'), clip: cardBox });
    console.log('Screenshot saved: verification/icon-chrome-extensions-card.png');
  }

  await context.close();

  console.log('\n=== RESULT ===');
  const pass = iconInfo.found && !!iconInfo.iconSrc;
  console.log(pass ? 'PASS: icon found and rendering on chrome://extensions.' : 'FAIL — see above.');
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
