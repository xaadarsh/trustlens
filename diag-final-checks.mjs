import { chromium } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-final-checks-profile');
const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';
const PRODUCT_URL = process.env.TL_VERIFY_URL || 'https://www.amazon.in/dp/B08RQJKF6D';

async function clickThroughInterstitial(page) {
  const continueBtn = page.locator('button:has-text("Continue shopping"), input[value="Continue shopping"]');
  if ((await continueBtn.count()) > 0) {
    await continueBtn.first().click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
}

async function main() {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: BRAVE_PATH,
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  const extensionId = sw ? new URL(sw.url()).hostname : null;

  // 1. Popup button :active press-punch
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await popupPage.waitForTimeout(700);
  const btn = popupPage.locator('button.primary');
  const box = await btn.boundingBox();
  await popupPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await popupPage.mouse.down();
  await popupPage.waitForTimeout(150);
  const activeState = await popupPage.evaluate(() => {
    const el = document.querySelector('button.primary');
    const cs = getComputedStyle(el);
    return { transform: cs.transform, boxShadow: cs.boxShadow };
  });
  console.log('Popup button :active state:', activeState);
  await popupPage.mouse.up();
  await popupPage.close();

  // 2. TrustPanel reduced-motion, focused on the NEW shimmer specifically
  const panelPage = await context.newPage();
  await panelPage.emulateMedia({ reducedMotion: 'reduce' });
  await panelPage.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await clickThroughInterstitial(panelPage);
  const panel = panelPage.locator('#trustlens-root .trustlens-panel');
  await panel.waitFor({ state: 'visible', timeout: 30000 });
  const samples = [];
  for (const t of [30, 300, 1000, 2500]) {
    await panelPage.waitForTimeout(t === 30 ? 30 : t - samples.at(-1)?.t ?? t);
    const s = await panelPage.evaluate(() => {
      const m = document.querySelector('.trustlens-medallion');
      const cs = getComputedStyle(m);
      const beforeCs = getComputedStyle(m, '::before');
      const letter = document.querySelector('.trustlens-medallion-letter');
      return {
        phase: m.getAttribute('data-medallion-phase'),
        transform: cs.transform,
        letterText: letter.textContent,
        shimmerOpacity: beforeCs.opacity,
      };
    });
    samples.push({ t, ...s });
  }
  console.log('TrustPanel reduced-motion samples over 2.5s:', JSON.stringify(samples, null, 2));
  const allIdentical = samples.every((s) => s.transform === samples[0].transform && s.shimmerOpacity === samples[0].shimmerOpacity && s.letterText === samples[0].letterText);
  console.log('All samples identical (truly static, no drift):', allIdentical);
  await panelPage.close();

  await context.close();
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
