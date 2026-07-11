// verify-no-scroll-jump.mjs — verifies the scroll-nudge removal actually
// fixed the "page jumps to reviews on load" bug. Loads a real Amazon
// product page 3 times (real Brave), sampling window.scrollY repeatedly
// across the full ~9s lazy-load watch window each time, to confirm the
// viewport never moves off wherever the user left it (top of page here).

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-no-scroll-jump-profile');
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
  const allRuns = [];

  try {
    for (let run = 1; run <= 3; run++) {
      console.log(`\n=== Load #${run} ===`);
      await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await clickThroughInterstitial(page);

      // Confirm we start at the top, same as a real user reloading.
      const startScroll = await page.evaluate(() => window.scrollY);
      console.log(`Start scrollY: ${startScroll}`);

      const panel = page.locator('#trustlens-root .trustlens-panel');
      await panel.waitFor({ state: 'visible', timeout: 20000 }).catch(() => console.log('(panel did not appear — continuing scroll check anyway)'));

      // Sample scrollY across the full lazy-load watch window (9s timeout
      // in content.tsx) plus a margin, at fine granularity right after
      // mount (when the old nudge used to fire) and coarser afterward.
      const samplePoints = [0, 100, 250, 500, 800, 1200, 1800, 2500, 3500, 5000, 7000, 9500, 10500];
      const samples = [];
      const t0 = Date.now();
      for (const target of samplePoints) {
        const wait = Math.max(0, target - (Date.now() - t0));
        if (wait > 0) await page.waitForTimeout(wait);
        const scrollY = await page.evaluate(() => window.scrollY);
        samples.push({ targetMs: target, elapsedMs: Date.now() - t0, scrollY });
      }

      const maxScroll = Math.max(...samples.map((s) => s.scrollY));
      console.log('Samples:', samples.map((s) => `t${s.targetMs}=${s.scrollY}`).join(' '));
      console.log(`Load #${run} max scrollY observed: ${maxScroll}  ->  ${maxScroll === 0 ? 'PASS (never moved)' : 'FAIL (page scrolled)'}`);

      await page.screenshot({ path: path.join(VERIFICATION_DIR, `noscroll-run${run}.png`) });
      allRuns.push({ run, startScroll, samples, maxScroll, pass: maxScroll === 0 });
    }
  } finally {
    await page.close();
    await context.close();
  }

  fs.writeFileSync(path.join(VERIFICATION_DIR, 'no-scroll-jump-report.json'), JSON.stringify(allRuns, null, 2));

  const allPass = allRuns.every((r) => r.pass);
  console.log(`\n=== Overall: ${allPass ? 'PASS — scrollY stayed at 0 across all 3 loads' : 'FAIL — scroll jump detected in at least one run'} ===`);
  console.log('Report written to verification/no-scroll-jump-report.json');
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
