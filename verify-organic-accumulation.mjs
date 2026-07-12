// verify-organic-accumulation.mjs — verifies the three review-sampling
// improvements described in the task:
//   1. Organic accumulation: as the user scrolls a product's own review
//      section (real page navigation, not a background fetch), newly-
//      rendered review cards get folded into the sample and the panel
//      re-grades live (see startOrganicAccumulation in content.tsx).
//   2. Opportunistic pagination stays capped small (3 pages, sortBy=recent)
//      and, if it hits Amazon's sign-in gate, fails silently — no error text
//      ever renders in the panel.
//   3. Copy is population-honest: "Based on N reviews (X★) · M analyzed in
//      detail", where M (reviewsScanned) updates live as the sample grows.
//
// Real Brave via Playwright, standard production build. NOTE: a dev-mode
// build (NODE_ENV=development, needed for DevTools' Force Pro override to
// take effect per TrustPanel.tsx's import.meta.env.DEV gate) currently
// crashes the content script entirely with "(0 , k.jsxDEV) is not a
// function" — a pre-existing WXT/Vite JSX-runtime resolution issue in the
// content-script context, unrelated to this change (confirmed by testing
// the unmodified dev build). Force Pro isn't actually needed here anyway:
// it only gates the AI deep-dive trial counter (lib/usage-limits.ts), not
// review sampling/grading, so this verification doesn't touch it.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-organic-accumulation-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';

const PRODUCTS = [
  { key: 'amazon-in-pilgrim', label: 'Pilgrim night cream (amazon.in, ~1,920 reviews)', url: 'https://www.amazon.in/dp/B08RQJKF6D' },
  { key: 'amazon-com-instant-pot', label: 'Instant Pot (amazon.com, 185k+ reviews)', url: 'https://www.amazon.com/dp/B00FLYWNYQ' },
];

function subtitleCounts(subtitle) {
  const totalMatch = subtitle.match(/Based on ([\d,]+) reviews/);
  const scannedMatch = subtitle.match(/([\d,]+)\s+(?:reviews\s+)?analyzed in detail/);
  return {
    totalReviews: totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : null,
    reviewsAnalyzed: scannedMatch ? Number(scannedMatch[1].replace(/,/g, '')) : null,
  };
}

async function clickThroughInterstitial(page) {
  const continueBtn = page.locator('button:has-text("Continue shopping"), input[value="Continue shopping"]');
  if ((await continueBtn.count()) > 0) {
    await continueBtn.first().click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
}

async function readPanelState(page) {
  return page.evaluate(() => {
    const subtitle = document.querySelector('.trustlens-subtitle')?.textContent?.trim() ?? '';
    const grade = document.querySelector('.trustlens-medallion-letter')?.textContent?.trim() ?? '';
    const checks = [...document.querySelectorAll('.trustlens-check')].map((row) => ({
      status: row.getAttribute('data-status'),
      label: row.querySelector('.trustlens-check-label')?.textContent?.trim() ?? '',
    }));
    return { subtitle, grade, checks };
  });
}

async function scrollThroughReviews(page, { rounds = 14, stepDelayMs = 900 } = {}) {
  // Simulates genuine reading behavior: scroll toward the reviews widget,
  // then keep scrolling down through it in small increments — this is what
  // organic accumulation is designed to observe (real navigation), never a
  // programmatic fetch or DOM injection.
  const anchor = page.locator('#averageCustomerReviews, #reviewsMedley, [data-hook="reviews-medley-widget"]').first();
  await anchor.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(500);

  for (let i = 0; i < rounds; i++) {
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(stepDelayMs);

    // If Amazon renders an in-place "load more reviews" control (not a link
    // that navigates away), click it to encourage more cards to render —
    // still real page interaction, not a background fetch.
    const loadMore = page.locator(
      'button[data-hook="load-more-reviews"], a[data-hook="see-more-reviews-link-hook"] button, [data-hook="cr-widget-BasicRatings"] button:has-text("more reviews")',
    );
    if ((await loadMore.count()) > 0) {
      const first = loadMore.first();
      if (await first.isVisible().catch(() => false)) {
        await first.click().catch(() => {});
        await page.waitForTimeout(stepDelayMs);
      }
    }
  }
}

async function verifyProduct(context, product) {
  console.log(`\n=== ${product.label} ===`);
  const page = await context.newPage();
  const consoleLog = [];
  const organicLogLines = [];
  const gateLogLines = [];
  page.on('console', (msg) => {
    const line = `[${msg.type()}] ${msg.text()}`;
    consoleLog.push(line);
    if (msg.text().includes('[TrustLens]')) {
      console.log(line);
      if (/Organic accumulation/.test(msg.text())) organicLogLines.push(msg.text());
      if (/sign-in|signing in|stopping scan/i.test(msg.text())) gateLogLines.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    consoleLog.push(`[pageerror] ${err.message}`);
    console.log(`[pageerror] ${err.message}`);
  });

  const result = { key: product.key, label: product.label, url: product.url };

  try {
    await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await clickThroughInterstitial(page);

    const panel = page.locator('#trustlens-root .trustlens-panel');
    await panel.waitFor({ state: 'visible', timeout: 20000 });
    result.panelMounted = true;

    // Snapshot immediately after mount, before scrolling — this is the
    // "initial ~10-13" baseline organic accumulation is meant to exceed.
    await page.waitForTimeout(1500);
    const before = await readPanelState(page);
    result.before = { ...before, ...subtitleCounts(before.subtitle) };
    console.log(`Before scrolling — subtitle: "${before.subtitle}", grade: "${before.grade}"`);
    await page.screenshot({ path: path.join(VERIFICATION_DIR, `organic-${product.key}-before.png`) });

    await scrollThroughReviews(page);

    // Let any in-flight debounced re-scan / pagination fetch settle.
    await page.waitForTimeout(3000);
    const afterScroll = await readPanelState(page);
    result.afterScroll = { ...afterScroll, ...subtitleCounts(afterScroll.subtitle) };

    // Amazon's own product-page review section is largely static — its
    // "See more reviews" control does a full navigation rather than an
    // in-place AJAX append, so real scrolling alone may add nothing to
    // observe here (that's Amazon's page behavior, not a bug in the
    // observer). To directly verify the organic-accumulation *mechanism*
    // (detect mutation -> merge -> re-render -> re-grade) deterministically,
    // clone an existing review card with a fresh id and insert it into the
    // DOM — standing in for whatever real DOM node Amazon's own JS would
    // insert on a lazy-load variant. This is still exercising the exact
    // same MutationObserver code path content.tsx uses in production.
    const injected = await page.evaluate(() => {
      const original = document.querySelector('[data-hook="review"], [id^="customer_review-"]');
      if (!original) return false;
      const clone = original.cloneNode(true);
      clone.id = `verify-injected-review-${Date.now()}`;
      original.parentElement.appendChild(clone);
      return true;
    });
    result.injectedSimulatedReviewCard = injected;
    if (injected) {
      await page.waitForTimeout(1500); // MUTATION_DEBOUNCE_MS (500) + margin
    }

    const after = await readPanelState(page);
    result.after = { ...after, ...subtitleCounts(after.subtitle) };
    console.log(`After scrolling — subtitle: "${after.subtitle}", grade: "${after.grade}"`);
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(VERIFICATION_DIR, `organic-${product.key}-after.png`) });

    result.reviewsAnalyzedGrew = (result.after.reviewsAnalyzed ?? 0) > (result.before.reviewsAnalyzed ?? 0);
    result.organicAccumulationLogLines = organicLogLines;
    result.gateLogLines = gateLogLines;

    // No error text should ever surface in the panel, even if the gate fired.
    const panelText = await panel.innerText();
    result.panelShowsNoErrorText = !/error|failed to|could not connect/i.test(panelText.replace(result.after.subtitle, ''));
    result.panelTextSample = panelText.split('\n').slice(0, 6).join(' | ');
  } catch (err) {
    result.panelMounted = false;
    result.error = err instanceof Error ? err.message : String(err);
    console.log('FAILED:', result.error);
    await page.screenshot({ path: path.join(VERIFICATION_DIR, `organic-${product.key}-fail.png`) }).catch(() => {});
  } finally {
    fs.writeFileSync(path.join(VERIFICATION_DIR, `organic-${product.key}-console-log.txt`), consoleLog.join('\n'));
    await page.close();
  }

  return result;
}

async function main() {
  console.log('=== Building extension (npm run build) ===');
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
    for (const product of PRODUCTS) {
      results.push(await verifyProduct(context, product));
    }
  } finally {
    await context.close();
  }

  console.log('\n=== RESULTS ===');
  for (const r of results) {
    console.log(`\n${r.label}`);
    console.log(`  panelMounted=${r.panelMounted}`);
    if (r.panelMounted) {
      console.log(`  before:      reviewsAnalyzed=${r.before.reviewsAnalyzed} totalReviews=${r.before.totalReviews} grade="${r.before.grade}"`);
      console.log(`  afterScroll: reviewsAnalyzed=${r.afterScroll.reviewsAnalyzed} totalReviews=${r.afterScroll.totalReviews} grade="${r.afterScroll.grade}"`);
      console.log(`  injectedSimulatedReviewCard=${r.injectedSimulatedReviewCard}`);
      console.log(`  afterInject: reviewsAnalyzed=${r.after.reviewsAnalyzed} totalReviews=${r.after.totalReviews} grade="${r.after.grade}"`);
      console.log(`  [${r.reviewsAnalyzedGrew ? 'PASS' : 'FAIL'}] reviewsAnalyzed grew after the simulated DOM mutation: ${r.reviewsAnalyzedGrew}`);
      console.log(`  [${r.panelShowsNoErrorText ? 'PASS' : 'FAIL'}] no error text in panel`);
      console.log(`  organic accumulation log lines: ${r.organicAccumulationLogLines.length}`);
      console.log(`  gate/failure log lines: ${JSON.stringify(r.gateLogLines)}`);
    } else {
      console.log(`  ERROR: ${r.error}`);
    }
  }

  fs.writeFileSync(path.join(VERIFICATION_DIR, 'organic-accumulation-report.json'), JSON.stringify(results, null, 2));
  console.log('\nReport written to verification/organic-accumulation-report.json');
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
