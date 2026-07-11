// verify-bugfix.mjs — verifies the isProductPage() URL-pattern fix and the
// broadened lazy-load-watch trigger, against the exact repro URL plus two
// more real products. Real Brave.

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

const CANDIDATES = [
  { name: 'repro-soup-ladle', url: 'https://www.amazon.in/gp/aw/d/B0BYVCGZBC', shot: 'bugfix-repro-soup-ladle.png' },
  { name: 'instant-pot', url: 'https://www.amazon.com/dp/B00FLYWNYQ', shot: 'bugfix-instant-pot.png' },
  { name: 'atomic-habits', url: 'https://www.amazon.com/dp/0735211299', shot: 'bugfix-atomic-habits.png' },
];

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

  const results = [];

  try {
    for (const candidate of CANDIDATES) {
      console.log(`\n=== ${candidate.name} (${candidate.url}) ===`);
      const page = await context.newPage();
      const consoleMsgs = [];
      page.on('console', (msg) => {
        if (msg.text().includes('[TrustLens]')) {
          consoleMsgs.push(`[${msg.type()}] ${msg.text()}`);
          console.log(`  [${msg.type()}] ${msg.text()}`);
        }
      });

      await page.goto(candidate.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await clickThroughInterstitial(page);
      await page.waitForTimeout(3000);

      const panel = page.locator('#trustlens-root .trustlens-panel');
      let visible = false;
      try {
        await panel.waitFor({ state: 'visible', timeout: 12000 });
        visible = true;
      } catch {
        visible = false;
      }

      console.log(`  Panel mounted: ${visible}`);

      // Give the lazy-load watch (up to 9s) a chance to run and improve the count.
      await page.waitForTimeout(11000);

      let subtitle = '';
      let gradeGlyph = '';
      let shortfallLabel = null;
      if (visible) {
        subtitle = (await page.locator('.trustlens-subtitle').textContent().catch(() => '')) ?? '';
        gradeGlyph = (await page.locator('.trustlens-medallion-letter').textContent().catch(() => '')) ?? '';
        const wrapLabel = page.locator('.trustlens-check-label--wrap');
        if ((await wrapLabel.count()) > 0) {
          shortfallLabel = (await wrapLabel.textContent().catch(() => '')) ?? '';
        }
        await panel.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(VERIFICATION_DIR, candidate.shot) });
        console.log(`  Saved: verification/${candidate.shot}`);
      } else {
        await page.screenshot({ path: path.join(VERIFICATION_DIR, candidate.shot) });
      }

      console.log(`  Subtitle: "${subtitle.trim()}"`);
      console.log(`  Grade glyph: "${gradeGlyph.trim()}"`);
      console.log(`  Shortfall label: ${shortfallLabel ? `"${shortfallLabel.trim()}"` : '(none — real grade shown)'}`);

      results.push({ name: candidate.name, url: candidate.url, panelMounted: visible, subtitle: subtitle.trim(), gradeGlyph: gradeGlyph.trim(), shortfallLabel: shortfallLabel?.trim() ?? null });
      await page.close();
    }
  } finally {
    await context.close();
  }

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(VERIFICATION_DIR, 'bugfix-summary.json'), JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
