// verify-redesign2.mjs — one-off verification for the medallion fix + collapsed
// checklist + merged header row + popup flow-row redesign. Real Brave.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-profile');
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
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  const extensionId = sw ? new URL(sw.url()).hostname : null;

  try {
    // Popup screenshot
    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await popupPage.waitForTimeout(800);
    await popupPage.screenshot({ path: path.join(VERIFICATION_DIR, 'popup-redesign2.png') });
    console.log('Saved: verification/popup-redesign2.png');
    await popupPage.close();

    // TrustPanel screenshot + measurements
    const amazonPage = await context.newPage();
    console.log(`Navigating to ${PRODUCT_URL} ...`);
    await amazonPage.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await clickThroughInterstitial(amazonPage);
    await amazonPage.waitForTimeout(4000);

    const panel = amazonPage.locator('#trustlens-root .trustlens-panel');
    let visible = false;
    try {
      await panel.waitFor({ state: 'visible', timeout: 15000 });
      visible = true;
    } catch {
      visible = false;
    }
    console.log('TrustPanel visible:', visible);

    if (visible) {
      const box = await panel.boundingBox();
      console.log('Panel bounding box:', box);

      const medallionStyles = await amazonPage.locator('.trustlens-medallion').evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          backgroundColor: cs.backgroundColor,
          borderColor: cs.borderTopColor,
          borderWidth: cs.borderTopWidth,
          outlineColor: cs.outlineColor,
          outlineWidth: cs.outlineWidth,
          outlineStyle: cs.outlineStyle,
          borderRadius: cs.borderTopLeftRadius,
        };
      });
      console.log('Medallion computed styles:', JSON.stringify(medallionStyles, null, 2));

      const gradeText = (await amazonPage.locator('.trustlens-medallion-letter').textContent().catch(() => '')) ?? '';
      console.log('Medallion glyph:', gradeText.trim());

      const checkChipTexts = await amazonPage.locator('.trustlens-check-chip').allTextContents();
      console.log('Check status chips:', checkChipTexts);

      await panel.scrollIntoViewIfNeeded();
      await amazonPage.screenshot({ path: path.join(VERIFICATION_DIR, 'trustpanel-redesign2-full.png') });
      await panel.screenshot({ path: path.join(VERIFICATION_DIR, 'trustpanel-redesign2-closeup.png') });
      console.log('Saved: verification/trustpanel-redesign2-full.png');
      console.log('Saved: verification/trustpanel-redesign2-closeup.png');
    } else {
      await amazonPage.screenshot({ path: path.join(VERIFICATION_DIR, 'trustpanel-redesign2-full.png') });
      console.log('Panel never appeared — screenshot saved for reference anyway.');
    }
    await amazonPage.close();
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
