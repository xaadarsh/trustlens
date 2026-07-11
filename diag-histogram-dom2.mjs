// diag-histogram-dom2.mjs — broader sweep: dumps the HTML around the rating
// summary widget, and tries clicking/hovering the average-rating link to see
// if the histogram only renders inside a popover.

import { chromium } from '@playwright/test';

const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';
const URL = process.argv[2] || 'https://www.amazon.com/dp/B00FLYWNYQ';

async function main() {
  const browser = await chromium.launch({ executablePath: BRAVE_PATH, headless: false });
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);

  const continueBtn = page.locator('button:has-text("Continue shopping"), input[value="Continue shopping"]');
  if ((await continueBtn.count()) > 0) {
    console.log('(clicking through "Continue shopping" interstitial)');
    await continueBtn.first().click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  const before = await page.evaluate(() => {
    const el = document.querySelector('#averageCustomerReviews') || document.querySelector('#averageCustomerReviews_feature_div');
    return el ? el.outerHTML.slice(0, 2500) : 'NOT FOUND';
  });
  console.log('=== #averageCustomerReviews HTML (before any interaction) ===');
  console.log(before);

  // Try clicking the rating link/popover trigger
  const popoverTrigger = page.locator('#acrPopover, [data-hook="acr-popover-trigger"], #averageCustomerReviews a').first();
  const triggerCount = await popoverTrigger.count();
  console.log('\nPopover trigger found:', triggerCount > 0);
  if (triggerCount > 0) {
    await popoverTrigger.hover().catch(() => {});
    await page.waitForTimeout(1000);
    await popoverTrigger.click({ timeout: 5000 }).catch((e) => console.log('click failed:', e.message));
    await page.waitForTimeout(1500);
  }

  const afterHistogram = await page.evaluate(() => {
    const table = document.querySelector('#histogramTable');
    const hookTable = document.querySelector('[data-hook="histogram-table"]');
    const anyHook = [...document.querySelectorAll('[data-hook*="histogram" i]')].length;
    const popover = document.querySelector('#cm_cr_dp_d_rating_histogram, #reviewsMedley, [data-hook="cr-summarization-attributes"]');
    return {
      histogramTableExists: !!table,
      histogramTableHTML: table ? table.outerHTML.slice(0, 1500) : null,
      hookTableExists: !!hookTable,
      anyHistogramHookCount: anyHook,
      reviewsMedleyHTML: popover ? popover.outerHTML.slice(0, 1000) : 'NOT FOUND',
    };
  });
  console.log('\n=== After hover/click ===');
  console.log(JSON.stringify(afterHistogram, null, 2));

  // scroll to reviews section and check again
  await page.evaluate(() => {
    const el = document.querySelector('#reviewsMedley') || document.querySelector('[data-hook="reviews-medley-widget"]');
    el?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(2000);

  const afterScroll = await page.evaluate(() => {
    const table = document.querySelector('#histogramTable');
    const anyHook = [...document.querySelectorAll('[data-hook*="histogram" i]')].length;
    const idHits = [...document.querySelectorAll('[id*="histogram" i]')].map((e) => e.id);
    return { histogramTableExists: !!table, anyHistogramHookCount: anyHook, idHits };
  });
  console.log('\n=== After scrolling to reviews section ===');
  console.log(JSON.stringify(afterScroll, null, 2));

  await browser.close();
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
