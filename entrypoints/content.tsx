import React from 'react';
import { createRoot } from 'react-dom/client';
import { TrustPanel } from '@/components/TrustPanel';
import '@/components/trustlens.css';
import { getSettings } from '@/lib/byo-key';
import { MIN_SAMPLE_SIZE } from '@/lib/statistical-engine';
import type { RatingHistogramEntry, ReviewSample, ScrapedAmazonPage } from '@/lib/types';

export default defineContentScript({
  matches: [
    '*://*.amazon.com/*',
    '*://*.amazon.co.uk/*',
    '*://*.amazon.ca/*',
    '*://*.amazon.com.au/*',
    '*://*.amazon.de/*',
    '*://*.amazon.fr/*',
    '*://*.amazon.it/*',
    '*://*.amazon.es/*',
    '*://*.amazon.in/*',
  ],
  runAt: 'document_idle',
  async main() {
    const settings = await getSettings();
    if (!settings.enabled) return;

    if (!isProductPage()) return;
    mountWhenReady();
  },
});

const LAZY_LOAD_TIMEOUT_MS = 9000;
const MUTATION_DEBOUNCE_MS = 500;

// Scanning more review pages beyond the one Amazon renders on the product
// page itself: capped deliberately low (not the originally-discussed
// 100-150) to keep this polite — a handful of extra fetches, not a scrape.
const MAX_TOTAL_REVIEWS = 45;
const MAX_REVIEW_PAGES = 5;
const FETCH_DELAY_MIN_MS = 400;
const FETCH_DELAY_MAX_MS = 800;

type PageAnchors = { mountAnchor: Element | null; reviewsSectionAnchor: Element | null };

async function mountWhenReady() {
  const existing = document.getElementById('trustlens-root');
  if (existing) existing.remove();

  const initialPage = scrapeAmazonPage(document);
  const mountAnchor = initialPage.mountAnchor;
  if (!mountAnchor) {
    console.warn('[TrustLens] Could not find a stable mount anchor near the rating summary.');
    return;
  }

  const root = document.createElement('div');
  root.id = 'trustlens-root';
  mountAnchor.insertAdjacentElement('afterend', root);
  const reactRoot = createRoot(root);
  reactRoot.render(<TrustPanel page={initialPage} />);

  // Some Amazon page variants fetch the review list via AJAX after initial
  // render (or only once the reviews section scrolls into view), so a single
  // scrape at document_idle can legitimately find fewer review cards than
  // actually exist — including exactly zero, but also just "some, but not
  // enough for a grade" (e.g. 4 of 14 on initial load). Trigger the watch
  // whenever we're short of MIN_SAMPLE_SIZE, not only when reviews.length is
  // literally 0 — otherwise a page that starts with a handful never gets a
  // chance to grow toward a real grade even though more may lazy-load in.
  let currentPage: ScrapedAmazonPage & PageAnchors = initialPage;
  if (initialPage.reviews.length < MIN_SAMPLE_SIZE) {
    const lazyLoadedPage = await watchForLazyReviews(reactRoot, initialPage.reviewsSectionAnchor ?? mountAnchor, initialPage);
    if (lazyLoadedPage) currentPage = lazyLoadedPage;
  }

  // Sequenced after the lazy-load watch settles (success or timeout) so only
  // one async enhancement re-renders the panel at a time.
  await enhanceWithMoreReviews(reactRoot, currentPage);
}

function watchForLazyReviews(
  reactRoot: ReturnType<typeof createRoot>,
  nudgeTarget: Element,
  startingPage: ScrapedAmazonPage & PageAnchors,
): Promise<(ScrapedAmazonPage & PageAnchors) | null> {
  return new Promise((resolve) => {
    let settled = false;
    let latestPage: (ScrapedAmazonPage & PageAnchors) | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      clearTimeout(timeoutId);
      mutationObserver.disconnect();
      intersectionObserver.disconnect();
    };

    const attemptRescrape = () => {
      if (settled) return;
      const updatedPage = scrapeAmazonPage(document);
      const bestSoFar = latestPage ? latestPage.reviews.length : startingPage.reviews.length;
      if (updatedPage.reviews.length <= bestSoFar) return;

      latestPage = updatedPage;
      console.log(
        `[TrustLens] Lazy-loaded reviews detected after DOM mutation — re-scraped ${updatedPage.reviews.length} review(s), re-rendering panel in place.`,
      );
      reactRoot.render(<TrustPanel page={updatedPage} />);

      if (updatedPage.reviews.length >= MIN_SAMPLE_SIZE) {
        settled = true;
        cleanup();
        resolve(updatedPage);
      }
    };

    const mutationObserver = new MutationObserver(() => {
      if (settled) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(attemptRescrape, MUTATION_DEBOUNCE_MS);
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });

    // Nudge: some layouts only fetch review data once the reviews section is
    // actually visible in the viewport, not merely present in the DOM. If the
    // anchor isn't visible yet, scroll it into view once to trigger that fetch.
    const intersectionObserver = new IntersectionObserver((entries) => {
      intersectionObserver.disconnect();
      const entry = entries[0];
      if (entry && !entry.isIntersecting) {
        console.log('[TrustLens] Reviews section not yet in viewport — scrolling it into view to nudge lazy-loaded content.');
        nudgeTarget.scrollIntoView({ behavior: 'auto', block: 'center' });
      }
    }, { threshold: 0 });
    intersectionObserver.observe(nudgeTarget);

    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      const finalCount = latestPage ? latestPage.reviews.length : startingPage.reviews.length;
      console.log(
        `[TrustLens] Lazy-load watch timed out after ${LAZY_LOAD_TIMEOUT_MS / 1000}s — ${finalCount} review(s) found (started at ${startingPage.reviews.length}).`,
      );
      resolve(latestPage);
    }, LAZY_LOAD_TIMEOUT_MS);
  });
}

// Amazon's product page itself only ever renders a handful of review cards.
// To get closer to a useful sample, fetch a few pages of Amazon's own
// dedicated /product-reviews listing (sorted most-recent) and merge in
// whatever new reviews turn up — capped and paced deliberately conservatively.
// Any failure, gate, or empty page stops the scan immediately and keeps
// whatever was already gathered; this never retries or loops against Amazon.
async function enhanceWithMoreReviews(
  reactRoot: ReturnType<typeof createRoot>,
  startingPage: ScrapedAmazonPage & PageAnchors,
): Promise<void> {
  if (!startingPage.asin) return;
  if (startingPage.reviews.length >= MAX_TOTAL_REVIEWS) return;

  const seenIds = new Set(startingPage.reviews.map((r) => r.id));
  const merged: ReviewSample[] = [...startingPage.reviews];

  for (let pageNumber = 1; pageNumber <= MAX_REVIEW_PAGES; pageNumber++) {
    if (merged.length >= MAX_TOTAL_REVIEWS) break;

    await delay(randomBetween(FETCH_DELAY_MIN_MS, FETCH_DELAY_MAX_MS));

    let html: string;
    try {
      const url = `https://${location.hostname}/product-reviews/${startingPage.asin}/?ie=UTF8&reviewerType=all_reviews&sortBy=recent&pageNumber=${pageNumber}`;
      const res = await fetch(url);
      if (res.redirected && /\/ap\/signin/.test(res.url)) {
        console.log(`[TrustLens] Additional review pages require signing in to Amazon (redirected to ${new URL(res.url).pathname}) — stopping scan, keeping ${merged.length} review(s).`);
        break;
      }
      if (!res.ok) {
        console.log(`[TrustLens] Additional review page ${pageNumber} fetch failed (HTTP ${res.status}) — stopping scan, keeping ${merged.length} review(s).`);
        break;
      }
      html = await res.text();
    } catch (err) {
      console.log(`[TrustLens] Additional review page ${pageNumber} fetch errored — stopping scan, keeping ${merged.length} review(s).`, err);
      break;
    }

    const parsedDoc = new DOMParser().parseFromString(html, 'text/html');

    if (isSignInGated(parsedDoc)) {
      console.log(`[TrustLens] Review page ${pageNumber} requires sign-in — stopping scan, keeping ${merged.length} review(s).`);
      break;
    }

    const cards = queryAll('reviewCards', parsedDoc);
    if (cards.length === 0) {
      console.log(`[TrustLens] No review cards found on page ${pageNumber} — stopping scan, keeping ${merged.length} review(s).`);
      break;
    }

    let addedThisPage = 0;
    for (const card of cards) {
      const review = scrapeReview(card, merged.length, queryFirst);
      if (!seenIds.has(review.id)) {
        seenIds.add(review.id);
        merged.push(review);
        addedThisPage++;
        if (merged.length >= MAX_TOTAL_REVIEWS) break;
      }
    }

    if (addedThisPage === 0) {
      console.log(`[TrustLens] Page ${pageNumber} returned no new reviews (likely end of pagination) — stopping scan, keeping ${merged.length} review(s).`);
      break;
    }
  }

  if (merged.length > startingPage.reviews.length) {
    const updatedPage: ScrapedAmazonPage & PageAnchors = {
      ...startingPage,
      reviews: merged,
      reviewsScanned: merged.length,
    };
    console.log(`[TrustLens] Additional review scan complete — now have ${merged.length} of ${updatedPage.totalReviews} total review(s).`);
    reactRoot.render(<TrustPanel page={updatedPage} />);
  } else {
    console.log('[TrustLens] Additional review scan found no new reviews beyond the initial page.');
  }
}

function isSignInGated(doc: Document): boolean {
  const bodyText = doc.body?.textContent ?? '';
  return /account verification|customer reviews require/i.test(bodyText);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min));
}

// Amazon serves product pages under several distinct URL schemes — /dp/ and
// /gp/product/ are the common ones, but /gp/aw/d/ ("app web" render) is also
// real and turns up often on amazon.in. Missing a variant here means the
// content script silently never runs on that page at all — no scrape, no
// mount, no console output, nothing to debug from.
function isProductPage(): boolean {
  return /\/(dp|gp\/product|gp\/aw\/d)\//.test(location.pathname);
}

const selectors = {
  title: ['#productTitle'],
  asin: ['#ASIN', 'input[name="ASIN"]'],
  averageRating: ['[data-hook="average-star-rating"]', '#averageCustomerReviews .a-icon-alt', '[data-hook="rating-out-of-text"]'],
  totalReviewCount: ['[data-hook="total-review-count"]', '#acrCustomerReviewText', '#averageCustomerReviews_feature_div #acrCustomerReviewText'],
  reviewCards: ['[data-hook="review"]', '[id^="customer_review-"]', '.review[data-hook]'],
  reviewStar: ['[data-hook="review-star-rating"]', '[data-hook="cmps-review-star-rating"]', '.review-rating .a-icon-alt'],
  reviewTitle: ['[data-hook="reviewTitle"]', '[data-hook="review-title"]', '.review-title'],
  reviewBody: ['[data-hook="reviewText"]', '[data-hook="reviewTextContainer"]', '[data-hook="review-body"]', '.review-text-content', '.review-text'],
  reviewDate: ['[data-hook="review-date"]', '.review-date'],
  verifiedBadge: ['[data-hook="avp-badge"]', '[data-hook="review-badges"]', '[data-hook="format-strip"]', '.a-size-mini.a-color-state', '.review-format-strip'],
  vineBadge: ['[data-hook="vine-badge"]', '.cr-vine-review-badge'],
  productDetails: ['#productDetails_detailBullets_sections1', '#productDetails_techSpec_section_1', '#productDetails_db_sections', '#productDetails_expanderSectionTables', '#productDetails_expanderTables_depthLeftSections', '#productDetails_expanderTables_depthRightSections', '#productDetailsHomeAndGarden_Updated', '#detailBullets_feature_div', '#prodDetails', '#productDetails_feature_div', '#productOverview_feature_div'],
  productDetailRows: ['tr', 'li', '.a-row', 'div', 'span'],
  // #histogramTable is the confirmed-live container (verified against a real
  // product page — it's a <ul>, not an actual <table>, despite the id). The
  // rest are fallbacks for page variants that don't use that id.
  ratingHistogramTable: ['#histogramTable', '[data-hook="histogram-table"]', '[data-hook="rating-histogram"]', '.cr-widget-Histogram', '#cr-summarization-histogram'],
  mountAnchor: ['#averageCustomerReviews', '#averageCustomerReviews_feature_div', '[data-hook="average-star-rating"]', '#reviewsMedley', '[data-hook="reviews-medley-widget"]'],
  // Distinct from mountAnchor: the actual reviews list container, further
  // down the page than the top rating summary. Amazon's lazy-load for
  // review cards is tied to THIS section's own viewport visibility, not
  // the summary widget near the top (which is usually already visible).
  reviewsSection: ['#reviewsMedley', '[data-hook="reviews-medley-widget"]', '#cr-top-reviews-card', '[data-hook="cr-top-reviews-card"]'],
};

function queryFirst(group: keyof typeof selectors, root: ParentNode): Element | null {
  for (const selector of selectors[group]) {
    const found = root.querySelector(selector);
    if (found) return found;
  }
  console.warn(`[TrustLens] No match for ${group}: ${selectors[group].join(', ')}`);
  return null;
}

function queryAll(group: keyof typeof selectors, root: ParentNode): Element[] {
  for (const selector of selectors[group]) {
    const found = [...root.querySelectorAll(selector)];
    if (found.length) return found;
  }
  console.warn(`[TrustLens] No matches for ${group}: ${selectors[group].join(', ')}`);
  return [];
}

// Amazon renders a full star-by-star breakdown (e.g. "54% gave 5 stars") on
// nearly every product page, computed from the ENTIRE review population —
// unlike the ~10-45 review cards TrustLens can scrape, which are a small,
// "helpful"-vote-biased sample. This is the single richest signal available
// and doesn't require scrolling into the reviews section or hitting the
// sign-in gate that blocks the extra-page fetch in enhanceWithMoreReviews.
const MIN_HISTOGRAM_LEVELS = 3;

function scrapeRatingHistogram(root: ParentNode): RatingHistogramEntry[] {
  const table = queryFirst('ratingHistogramTable', root);
  if (!table) {
    console.warn('[TrustLens] No rating histogram table found on this page variant — grading will fall back to overall rating/count only.');
    return [];
  }

  // Primary: Amazon's numbered per-star analytics slot id (confirmed live —
  // "dp_customerReviews_vertical_histogram_5" for the 5-star row, etc.).
  // Doesn't depend on translated copy, unlike the text-based fallback below.
  const bySlotId: RatingHistogramEntry[] = [];
  for (let star = 5; star >= 1; star--) {
    const el = table.querySelector(`[data-csa-c-slot-id$="_${star}"], [data-hook="histogram-row-${star}"]`);
    const percent = el ? extractHistogramPercent(el) : null;
    if (percent !== null) bySlotId.push({ star: star as 1 | 2 | 3 | 4 | 5, percent });
  }
  if (bySlotId.length >= MIN_HISTOGRAM_LEVELS) return bySlotId;

  // Fallback: match each row by its own "N star(s)" aria-label or text —
  // Amazon's row links carry aria-label="NN percent of reviews have N stars".
  const byText: RatingHistogramEntry[] = [];
  for (const row of table.querySelectorAll('li, tr, .a-histogram-row')) {
    const ariaLabel = row.querySelector('[aria-label]')?.getAttribute('aria-label') ?? '';
    const starMatch = ariaLabel.match(/([1-5])\s*stars?/i) ?? text(row).match(/([1-5])\s*stars?/i);
    if (!starMatch) continue;
    const star = Number(starMatch[1]) as 1 | 2 | 3 | 4 | 5;
    const percent = extractHistogramPercent(row);
    if (percent !== null && !byText.some((entry) => entry.star === star)) {
      byText.push({ star, percent });
    }
  }

  return byText.length > bySlotId.length ? byText : bySlotId;
}

// Reads the ARIA progressbar value first — a numeric attribute, unaffected
// by locale translation of the surrounding "NN%" text — falling back to
// parsing the row's own aria-label/visible text.
function extractHistogramPercent(row: Element): number | null {
  const meter = row.querySelector('[role="progressbar"]');
  const ariaValue = meter?.getAttribute('aria-valuenow');
  if (ariaValue) {
    const fromAria = Number(ariaValue);
    if (!Number.isNaN(fromAria)) return fromAria;
  }
  const ariaLabel = row.querySelector('[aria-label]')?.getAttribute('aria-label') ?? '';
  const match = ariaLabel.match(/(\d{1,3})\s?(?:%|percent)/i) ?? text(row).match(/(\d{1,3})\s?%/);
  return match ? Number(match[1]) : null;
}

function scrapeAmazonPage(root: Document): ScrapedAmazonPage & PageAnchors {
  const asinElement = queryFirst('asin', root) as HTMLInputElement | null;
  const reviewCards = queryAll('reviewCards', root).slice(0, 30);
  const totalReviewCount = integerFromText(text(queryFirst('totalReviewCount', root)));

  const page = {
    asin: asinElement?.value || text(asinElement) || asinFromUrl(),
    locale: location.hostname.replace(/^www\./, ''),
    url: location.href,
    title: text(queryFirst('title', root)),
    averageRating: numberFromText(text(queryFirst('averageRating', root))),
    totalReviewCount,
    productFirstAvailable: findDateFirstAvailable(queryAll('productDetails', root), selectors.productDetailRows, root),
    reviews: reviewCards.map((card, index) => scrapeReview(card, index, queryFirst)),
    ratingHistogram: scrapeRatingHistogram(root),
    mountAnchor: queryFirst('mountAnchor', root),
    reviewsSectionAnchor: queryFirst('reviewsSection', root),
    reviewsScanned: reviewCards.length,
    totalReviews: totalReviewCount ?? 0,
  };

  if (!page.reviews.length) {
    console.warn('[TrustLens] No visible review cards found on this page. Amazon may lazy-load reviews or use a locale-specific layout.');
  }
  if (!page.productFirstAvailable) {
    console.warn('[TrustLens] Date First Available was not found in the visible product details blocks.');
  }

  return page;
}

function scrapeReview(
  card: Element,
  index: number,
  queryFirstFn: (group: 'reviewStar' | 'reviewTitle' | 'reviewBody' | 'reviewDate' | 'verifiedBadge' | 'vineBadge', root: ParentNode) => Element | null,
): ReviewSample {
  const verifiedText = text(queryFirstFn('verifiedBadge', card));
  const vineText = text(queryFirstFn('vineBadge', card));

  return {
    id: card.id || `visible-review-${index}`,
    rating: numberFromText(text(queryFirstFn('reviewStar', card))),
    title: cleanupReviewTitle(text(queryFirstFn('reviewTitle', card))),
    body: text(queryFirstFn('reviewBody', card)),
    date: text(queryFirstFn('reviewDate', card)) || null,
    verified: /verified purchase/i.test(verifiedText),
    vine: /vine/i.test(vineText),
  };
}

function findDateFirstAvailable(detailBlocks: Element[], rowSelectors: string[], root: Document): string | null {
  for (const block of detailBlocks) {
    for (const selector of rowSelectors) {
      const rows = [...block.querySelectorAll(selector)];
      for (const row of rows) {
        const rowText = text(row);
        const match = rowText.match(/Date\s+First\s+Available\s*:?\s*(.+)$/i);
        if (match?.[1]) return cleanupDetailValue(match[1]);
      }
    }
  }

  const bodyMatch = (root.body?.textContent ?? '').match(/Date\s+First\s+Available\s*:?\s*([A-Za-z]+\s+\d{1,2},\s+\d{4}|\d{1,2}\s+[A-Za-z]+\s+\d{4})/i);
  return bodyMatch?.[1] ?? null;
}

function text(element: Element | null | undefined): string {
  return element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function numberFromText(value: string): number | null {
  const match = value.match(/(\d+(?:[.,]\d+)?)/);
  return match ? Number(match[1].replace(',', '.')) : null;
}

function integerFromText(value: string): number | null {
  const match = value.replace(/,/g, '').match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

function asinFromUrl(): string | null {
  return location.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/)?.[1] ?? null;
}

function cleanupReviewTitle(value: string): string {
  return value.replace(/^\d(?:\.\d)?\s+out\s+of\s+5\s+stars\s*/i, '').trim();
}

function cleanupDetailValue(value: string): string {
  return value.replace(/Best Sellers Rank.*$/i, '').replace(/Customer Reviews.*$/i, '').trim();
}
