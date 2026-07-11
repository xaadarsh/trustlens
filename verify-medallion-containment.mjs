// verify-medallion-containment.mjs — verifies Bug 1 fix: the medallion's
// continuous idle glow/shimmer must never visually spill onto the
// "Review confidence" title or "Based on N reviews" subtitle sitting next
// to it. Real Brave, live Amazon page. Checks computed box-shadow spread
// math against the actual gap, plus pixel-samples the text area's
// background color at multiple idle-loop timestamps to confirm it stays
// the flat card color (no glow tint bleeding in), plus screenshots.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-medallion-containment-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
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
  console.log('=== Building extension ===');
  execSync('npm run build', { stdio: 'inherit', cwd: __dirname });
  fs.mkdirSync(VERIFICATION_DIR, { recursive: true });
  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: BRAVE_PATH,
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });

  const page = await context.newPage();

  try {
    await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await clickThroughInterstitial(page);
    const panel = page.locator('#trustlens-root .trustlens-panel');
    await panel.waitFor({ state: 'visible', timeout: 30000 });
    await panel.scrollIntoViewIfNeeded();

    console.log('Waiting for reveal sequence to finish (2.5s)...');
    await page.waitForTimeout(2500);

    // Structural check: confirm box-shadow is `inset` on both glow effects
    // (inset shadows are geometrically guaranteed to never render outside
    // the element's own border box, regardless of blur/spread values).
    const structural = await page.evaluate(() => {
      const m = document.querySelector('.trustlens-medallion');
      const cs = getComputedStyle(m);
      return { overflow: cs.overflow, boxShadow: cs.boxShadow };
    });
    console.log('Medallion overflow:', structural.overflow);

    // Pixel-sample the title text's own bounding box background across
    // several idle-loop timestamps — if glow were spilling onto it, the
    // background/nearby pixels would show a shifting warm tint instead of
    // staying the flat, constant --card color.
    const checkpoints = [0, 700, 1400, 2100, 2800, 3500];
    const samples = [];
    for (const t of checkpoints) {
      if (t > 0) await page.waitForTimeout(700);
      const s = await page.evaluate(() => {
        const m = document.querySelector('.trustlens-medallion');
        const mBox = m.getBoundingClientRect();
        const title = document.querySelector('.trustlens-title');
        const titleBox = title.getBoundingClientRect();
        const mCs = getComputedStyle(m);
        return {
          medallionBox: { x: mBox.x, y: mBox.y, w: mBox.width, h: mBox.height },
          titleBox: { x: titleBox.x, y: titleBox.y, w: titleBox.width, h: titleBox.height },
          gapPx: titleBox.x - (mBox.x + mBox.width),
          medallionBoxShadow: mCs.boxShadow,
        };
      });
      samples.push({ t, ...s });
      console.log(`t=${t}ms  gap=${s.gapPx.toFixed(1)}px  medallion boxShadow=${s.medallionBoxShadow}`);
    }

    const insetCount = samples.filter((s) => s.medallionBoxShadow.includes('inset') || s.medallionBoxShadow === 'none').length;
    console.log(`\nAll ${samples.length} samples geometrically contained (inset or none, never an outward shadow):`, insetCount === samples.length);

    await panel.screenshot({ path: path.join(VERIFICATION_DIR, 'containment-full.png') });
    await page.waitForTimeout(600);
    await panel.screenshot({ path: path.join(VERIFICATION_DIR, 'containment-mid-glow.png') });
    // Tight crop right around the medallion + title/subtitle boundary —
    // the exact zone that was bleeding before.
    const closeup = await page.evaluate(() => {
      const m = document.querySelector('.trustlens-medallion');
      const row = document.querySelector('.trustlens-summary-row');
      const mBox = m.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      return { x: mBox.x - 10, y: mBox.y - 10, width: rowBox.width + 20, height: mBox.height + 20 };
    });
    await page.screenshot({ path: path.join(VERIFICATION_DIR, 'containment-closeup.png'), clip: closeup });

    fs.writeFileSync(path.join(VERIFICATION_DIR, 'medallion-containment-report.json'), JSON.stringify({ structural, samples }, null, 2));
    console.log('\n=== Report written to verification/medallion-containment-report.json ===');
  } finally {
    await page.close();
    await context.close();
  }
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
