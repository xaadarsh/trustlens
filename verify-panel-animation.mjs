// verify-panel-animation.mjs — verifies the premium TrustPanel animation
// sequence (panel entrance -> row stagger -> medallion build-up reveal ->
// idle breathing loop) on a live Amazon page, real Brave. Captures computed
// opacity/transform at timed intervals (objective proof, not just visual)
// plus screenshots at key moments, then repeats with prefers-reduced-motion
// to confirm the whole thing collapses to an instant static state.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-panel-animation-profile');
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

function captureState() {
  const panel = document.querySelector('.trustlens-panel');
  const medallion = document.querySelector('.trustlens-medallion');
  const letter = document.querySelector('.trustlens-medallion-letter');
  const rows = [...document.querySelectorAll('.trustlens-check')];
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const panelCs = cs(panel);
  const medallionCs = cs(medallion);
  const letterCs = cs(letter);
  return {
    panel: panelCs && { opacity: panelCs.opacity, transform: panelCs.transform },
    medallion: medallionCs && { opacity: medallionCs.opacity, transform: medallionCs.transform },
    letter: letterCs && { opacity: letterCs.opacity, transform: letterCs.transform },
    rows: rows.map((r) => {
      const rcs = getComputedStyle(r);
      return { opacity: rcs.opacity, transform: rcs.transform };
    }),
  };
}

async function runSequence(context, label, reducedMotion) {
  const page = await context.newPage();
  if (reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });

  console.log(`\n=== ${label} ===`);
  await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await clickThroughInterstitial(page);

  const panel = page.locator('#trustlens-root .trustlens-panel');
  await panel.waitFor({ state: 'visible', timeout: 20000 });
  await panel.scrollIntoViewIfNeeded();
  const t0 = Date.now();

  const checkpoints = reducedMotion ? [0, 50] : [0, 120, 260, 320, 400, 600, 800, 1100, 1400, 1700, 2000, 2600, 4800];
  const report = [];
  for (const target of checkpoints) {
    const wait = Math.max(0, target - (Date.now() - t0));
    if (wait > 0) await page.waitForTimeout(wait);
    const state = await page.evaluate(captureState);
    const elapsed = Date.now() - t0;
    report.push({ targetMs: target, elapsedMs: elapsed, ...state });
    console.log(`t=${elapsed}ms  panel.opacity=${state.panel?.opacity}  medallion.opacity=${state.medallion?.opacity} medallion.transform=${state.medallion?.transform}  letter.opacity=${state.letter?.opacity}  rows=${state.rows.map((r) => r.opacity.slice(0, 4)).join(',')}`);
    if (!reducedMotion) {
      await page.screenshot({ path: path.join(VERIFICATION_DIR, `anim-${label}-t${target}ms.png`), clip: await panel.boundingBox().catch(() => undefined) }).catch(async () => {
        await page.screenshot({ path: path.join(VERIFICATION_DIR, `anim-${label}-t${target}ms.png`) });
      });
    }
  }

  await page.close();
  return report;
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

  try {
    const normal = await runSequence(context, 'normal', false);
    const reduced = await runSequence(context, 'reduced-motion', true);
    fs.writeFileSync(
      path.join(VERIFICATION_DIR, 'panel-animation-report.json'),
      JSON.stringify({ normal, reduced }, null, 2),
    );
  } finally {
    await context.close();
  }

  console.log('\n=== Report written to verification/panel-animation-report.json ===');
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
