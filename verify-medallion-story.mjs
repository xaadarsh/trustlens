// verify-medallion-story.mjs — verifies the rebuilt medallion "analyzing ->
// verdict" hero sequence (enter -> thinking -> resolve -> idle) on a live
// Amazon page, real Brave. Captures the actual data-medallion-phase
// attribute, displayed letter, computed transform/box-shadow at close
// intervals (objective proof of each act), screenshots at key moments, plus
// a prefers-reduced-motion pass confirming the whole thing collapses to an
// instant static grade.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-medallion-story-profile');
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
  const medallion = document.querySelector('.trustlens-medallion');
  const letter = document.querySelector('.trustlens-medallion-letter');
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const mCs = cs(medallion);
  const lCs = cs(letter);
  return {
    phase: medallion?.getAttribute('data-medallion-phase'),
    letterText: letter?.textContent,
    medallionOpacity: mCs?.opacity,
    medallionTransform: mCs?.transform,
    medallionBoxShadow: mCs?.boxShadow,
    letterOpacity: lCs?.opacity,
    letterTransform: lCs?.transform,
  };
}

async function runSequence(context, label, reducedMotion, checkpoints) {
  const page = await context.newPage();
  if (reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });

  console.log(`\n=== ${label} ===`);
  await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await clickThroughInterstitial(page);

  const panel = page.locator('#trustlens-root .trustlens-panel');
  await panel.waitFor({ state: 'visible', timeout: 20000 });
  await panel.scrollIntoViewIfNeeded();
  const t0 = Date.now();

  const report = [];
  for (const target of checkpoints) {
    const wait = Math.max(0, target - (Date.now() - t0));
    if (wait > 0) await page.waitForTimeout(wait);
    const state = await page.evaluate(captureState);
    const elapsed = Date.now() - t0;
    report.push({ targetMs: target, elapsedMs: elapsed, ...state });
    console.log(
      `t=${String(elapsed).padStart(4)}ms  phase=${String(state.phase).padEnd(8)} letter=${state.letterText}  medallion.opacity=${state.medallionOpacity} transform=${state.medallionTransform}  boxShadow=${state.medallionBoxShadow !== 'none' ? 'GLOW' : 'none'}  letter.opacity=${state.letterOpacity}`,
    );
    await page
      .screenshot({ path: path.join(VERIFICATION_DIR, `ms-${label}-t${target}ms.png`), clip: await panel.boundingBox().catch(() => undefined) })
      .catch(async () => {
        await page.screenshot({ path: path.join(VERIFICATION_DIR, `ms-${label}-t${target}ms.png`) });
      });
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
    // Normal: dense sampling to catch each act. Row stagger + medallion
    // start ~280-450ms in (2 checks case), enter ends +550ms, thinking
    // +750ms more, resolve +300ms more, then idle.
    const normalCheckpoints = [0, 150, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1450, 1500, 1550, 1600, 1700, 1900, 2200, 2800, 3600, 4400];
    const normal = await runSequence(context, 'normal', false, normalCheckpoints);

    const reduced = await runSequence(context, 'reduced-motion', true, [0, 30, 80, 200]);

    fs.writeFileSync(
      path.join(VERIFICATION_DIR, 'medallion-story-report.json'),
      JSON.stringify({ normal, reduced }, null, 2),
    );

    // Sanity summary
    const phasesSeen = [...new Set(normal.map((r) => r.phase))];
    console.log('\nPhases observed in normal run (order of first appearance):', phasesSeen);
    const lettersSeenDuringThinking = [...new Set(normal.filter((r) => r.phase === 'thinking').map((r) => r.letterText))];
    console.log('Distinct letters seen during "thinking":', lettersSeenDuringThinking);
    const flashSeen = normal.some((r) => r.phase === 'resolve' && r.medallionBoxShadow !== 'none');
    console.log('Glow flash observed during "resolve":', flashSeen);
    const reducedAllFinal = reduced.every((r) => r.phase === 'idle' && r.medallionOpacity === '1' && r.letterOpacity === '1');
    console.log('Reduced-motion: every checkpoint already at final idle state:', reducedAllFinal);
  } finally {
    await context.close();
  }

  console.log('\n=== Report written to verification/medallion-story-report.json ===');
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
