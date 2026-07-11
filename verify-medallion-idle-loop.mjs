// verify-medallion-idle-loop.mjs — focused, isolated verification that the
// medallion's post-reveal idle is a genuine continuous loop (glow-pulse +
// shimmer sweep), not a one-time animation that goes static. Real Brave,
// single page, dense sampling across ~9s of idle time.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-idle-loop-profile');
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

    console.log('Panel visible. Waiting for the reveal sequence to finish (2.5s)...');
    await page.waitForTimeout(2500);

    const phase = await page.evaluate(() => document.querySelector('.trustlens-medallion').getAttribute('data-medallion-phase'));
    console.log('Phase after 2.5s:', phase);

    console.log('\n=== Sampling idle loop for 9s ===');
    const checkpoints = [0, 600, 1200, 1800, 2400, 3000, 3600, 4200, 4800, 5400, 6000, 6600, 7200, 7800, 8400, 9000];
    const samples = [];
    const t0 = Date.now();
    for (const target of checkpoints) {
      const wait = Math.max(0, target - (Date.now() - t0));
      if (wait > 0) await page.waitForTimeout(wait);
      const state = await page.evaluate(() => {
        const m = document.querySelector('.trustlens-medallion');
        const cs = getComputedStyle(m);
        const beforeCs = getComputedStyle(m, '::before');
        return {
          phase: m.getAttribute('data-medallion-phase'),
          transform: cs.transform,
          boxShadow: cs.boxShadow,
          shimmerOpacity: beforeCs.opacity,
          shimmerTransform: beforeCs.transform,
        };
      });
      const elapsed = Date.now() - t0;
      samples.push({ t: elapsed, ...state });
      console.log(`t=${String(elapsed).padStart(4)}ms  transform=${state.transform.padEnd(28)} glow=${state.boxShadow !== 'none' ? 'YES' : 'no '}  shimmer.opacity=${state.shimmerOpacity}  shimmer.x=${state.shimmerTransform}`);
      if (elapsed % 2400 < 700) {
        await page.screenshot({ path: path.join(VERIFICATION_DIR, `idle-loop-t${target}ms.png`), clip: await panel.boundingBox().catch(() => undefined) }).catch(() => {});
      }
    }

    fs.writeFileSync(path.join(VERIFICATION_DIR, 'medallion-idle-loop-report.json'), JSON.stringify(samples, null, 2));

    const distinctTransforms = new Set(samples.map((s) => s.transform)).size;
    const distinctShimmerOpacities = new Set(samples.map((s) => s.shimmerOpacity)).size;
    const glowCount = samples.filter((s) => s.boxShadow !== 'none').length;
    console.log('\n=== SUMMARY ===');
    console.log('Distinct transform values over 9s:', distinctTransforms, '(1 would mean frozen/static)');
    console.log('Distinct shimmer opacity values over 9s:', distinctShimmerOpacities);
    console.log('Samples with visible glow:', glowCount, '/', samples.length);
    console.log(distinctTransforms > 3 && distinctShimmerOpacities > 2 ? 'PASS: medallion is genuinely animating continuously' : 'FAIL: medallion looks static');
  } finally {
    await page.close();
    await context.close();
  }
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
