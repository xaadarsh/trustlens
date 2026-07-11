// diag-amazon-in-mount.mjs — one-off diagnostic to inspect why the TrustLens
// panel fails to mount on amazon.in dp/ pages for ASINs that work fine on
// amazon.com. Loads the built extension, navigates to each failing URL, and
// dumps DOM info around where the rating summary should be so we can find
// the correct mountAnchor selector variant for amazon.in.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-profile-diag');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';

const URLS = [
  'https://www.amazon.in/dp/B08KTZ8249', // Kindle Paperwhite
  'https://www.amazon.in/dp/B08MQZXN1X', // Fire TV Stick 4K Max
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

  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.text().includes('[TrustLens]')) console.log(`[console] ${msg.text()}`);
  });

  try {
    for (const url of URLS) {
      console.log(`\n=== ${url} ===`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await clickThroughInterstitial(page);
      await page.waitForTimeout(3000);

      const info = await page.evaluate(() => {
        const candidates = [
          '#averageCustomerReviews',
          '#averageCustomerReviews_feature_div',
          '[data-hook="average-star-rating"]',
          '#reviewsMedley',
          '[data-hook="reviews-medley-widget"]',
          '#acrCustomerReviewText',
          '[data-hook="total-review-count"]',
          '#acrPopover',
          '[data-hook="acr-popover"]',
          '#cr-summarization-attributes',
          '[data-hook="cr-summarization-attributes"]',
          '#cm-cr-dp-review-list',
          '#cr-top-reviews-card',
          '[data-hook="cr-top-reviews-card"]',
          '[data-hook="reviews-medley-footer"]',
          '#reviews-medley-footer',
        ];
        const found = {};
        for (const sel of candidates) {
          try {
            found[sel] = document.querySelectorAll(sel).length;
          } catch (e) {
            found[sel] = `ERR: ${e.message}`;
          }
        }

        // Find anything with id or data-hook containing "review" or "rating" or "acr" or "star"
        const idMatches = [...document.querySelectorAll('[id]')]
          .map((el) => el.id)
          .filter((id) => /review|rating|acr|star|cr-/i.test(id));
        const dataHookMatches = [...document.querySelectorAll('[data-hook]')]
          .map((el) => el.getAttribute('data-hook'))
          .filter((dh) => /review|rating|acr|star/i.test(dh || ''));

        return {
          title: document.title,
          url: location.href,
          candidateCounts: found,
          uniqueIdsMatching: [...new Set(idMatches)],
          uniqueDataHooksMatching: [...new Set(dataHookMatches)],
          bodyHTMLLength: document.body ? document.body.innerHTML.length : 0,
        };
      });

      console.log(JSON.stringify(info, null, 2));

      const safeName = url.replace(/https?:\/\//, '').replace(/[^a-z0-9]/gi, '_');
      fs.writeFileSync(path.join(VERIFICATION_DIR, `diag-amazon-in-${safeName}.json`), JSON.stringify(info, null, 2));
      await page.screenshot({ path: path.join(VERIFICATION_DIR, `diag-amazon-in-${safeName}.png`), fullPage: false });

      // Also dump a chunk of raw HTML around where reviews might live, to eyeball manually.
      const html = await page.content();
      fs.writeFileSync(path.join(VERIFICATION_DIR, `diag-amazon-in-${safeName}.html`), html);
    }
  } finally {
    await page.close();
    await context.close();
  }
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
