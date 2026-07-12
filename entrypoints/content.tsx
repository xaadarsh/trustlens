import React from 'react';
import { createRoot } from 'react-dom/client';
import { TrustPanel } from '@/components/TrustPanel';
import '@/components/trustlens.css';
import { getSettings } from '@/lib/byo-key';
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

const MUTATION_DEBOUNCE_MS = 500;

// One shared cap across both ways the sample grows beyond Amazon's initial
// on-page render: organic accumulation (real navigation, see
// startOrganicAccumulation) and opportunistic pagination (see
// enhanceWithMoreReviews). Generous relative to the pagination fetch alone
// since organic growth costs Amazon nothing extra — every card it picks up
// was already served to the user's own browsing — but still bounded so a
// long browsing session can't grow the in-memory sample without limit.
const MAX_ACCUMULATED_REVIEWS = 120;

// Pagination is kept deliberately small and polite (a handful of extra
// fetches, not a scrape) — organic accumulation is the primary way the
// sample now grows past the initial ~10-13 cards.
const MAX_REVIEW_PAGES = 3;
const FETCH_DELAY_MIN_MS = 400;
const FETCH_DELAY_MAX_MS = 800;

type PageAnchors = { mountAnchor: Element | null };
type AccumulatedPage = ScrapedAmazonPage & PageAnchors;

interface ReviewAccumulator {
  page: AccumulatedPage;
  seenIds: Set<string>;
}

function createAccumulator(initialPage: AccumulatedPage): ReviewAccumulator {
  return { page: initialPage, seenIds: new Set(initialPage.reviews.map((r) => r.id)) };
}

// Merges newly-found review cards into the shared accumulator, deduping by
// id and stopping at MAX_ACCUMULATED_REVIEWS. Both organic accumulation and
// opportunistic pagination read/write the same accumulator object, and
// since each call is synchronous (JS is single-threaded, no interleaving
// mid-merge), the two channels never stomp on each other's progress even
// though they run concurrently.
function mergeReviews(acc: ReviewAccumulator, candidates: ReviewSample[]): number {
  let added = 0;
  const next = [...acc.page.reviews];
  for (const candidate of candidates) {
    if (acc.seenIds.has(candidate.id)) continue;
    if (next.length >= MAX_ACCUMULATED_REVIEWS) break;
    acc.seenIds.add(candidate.id);
    next.push(candidate);
    added++;
  }
  if (added > 0) {
    acc.page = { ...acc.page, reviews: next, reviewsScanned: next.length };
  }
  return added;
}

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

  const acc = createAccumulator(initialPage);

  // Organic accumulation runs for the rest of the page's life, picking up
  // whatever Amazon renders as the user actually browses — including the
  // AJAX lazy-load some page variants do shortly after document_idle. It
  // never scrolls or otherwise nudges the page itself.
  startOrganicAccumulation(reactRoot, acc);

  // Opportunistic pagination runs once, independent of organic accumulation
  // — both read/write the same accumulator, so their merges never conflict.
  await enhanceWithMoreReviews(reactRoot, acc);
}

// As the user naturally scrolls or clicks through Amazon's own review
// section (real page navigation — never a background fetch), Amazon renders
// more review cards into the DOM. This watches for that via MutationObserver
// and folds any newly-rendered cards straight into the shared sample,
// re-rendering (and so re-grading) live as it grows. It's the safe way to
// exceed the initial ~10-13 scraped cards without tripping Amazon's bot
// gate, since every card it picks up was already served to the user's own
// browsing — nothing here fetches or scrolls anything.
//
// Deliberately no timeout: genuine scrolling has no fixed schedule. It stops
// itself once MAX_ACCUMULATED_REVIEWS is reached, or on page unload.
function startOrganicAccumulation(reactRoot: ReturnType<typeof createRoot>, acc: ReviewAccumulator): void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const observer = new MutationObserver(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(rescan, MUTATION_DEBOUNCE_MS);
  });

  function cleanup() {
    if (debounceTimer) clearTimeout(debounceTimer);
    observer.disconnect();
    window.removeEventListener('pagehide', cleanup);
  }

  function rescan() {
    if (acc.page.reviews.length >= MAX_ACCUMULATED_REVIEWS) {
      cleanup();
      return;
    }
    const cards = queryAll('reviewCards', document);
    const candidates = cards.map((card, index) => scrapeReview(card, acc.page.reviews.length + index, queryFirst));
    const added = mergeReviews(acc, candidates);
    if (added > 0) {
      console.log(
        `[TrustLens] Organic accumulation: ${added} newly-rendered review card(s) found while browsing — sample now ${acc.page.reviews.length}, re-grading.`,
      );
      reactRoot.render(<TrustPanel page={acc.page} />);
    }
  }

  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('pagehide', cleanup, { once: true });
}

// Amazon's product page itself only ever renders a handful of review cards.
// To get closer to a useful sample, fetch a couple of pages of Amazon's own
// dedicated /product-reviews listing (sorted most-recent) and merge in
// whatever new reviews turn up — capped and paced deliberately
// conservatively. Any failure, gate, or empty page stops the scan
// immediately and silently: it never surfaces an error to the user, and
// never retries or loops against Amazon — organic accumulation above keeps
// working regardless of whether this succeeds.
async function enhanceWithMoreReviews(reactRoot: ReturnType<typeof createRoot>, acc: ReviewAccumulator): Promise<void> {
  if (!acc.page.asin) return;

  for (let pageNumber = 1; pageNumber <= MAX_REVIEW_PAGES; pageNumber++) {
    if (acc.page.reviews.length >= MAX_ACCUMULATED_REVIEWS) break;

    await delay(randomBetween(FETCH_DELAY_MIN_MS, FETCH_DELAY_MAX_MS));

    let html: string;
    try {
      const url = `https://${location.hostname}/product-reviews/${acc.page.asin}/?ie=UTF8&reviewerType=all_reviews&sortBy=recent&pageNumber=${pageNumber}`;
      const res = await fetch(url);
      if (res.redirected && /\/ap\/signin/.test(res.url)) {
        console.log(`[TrustLens] Additional review pages require signing in to Amazon (redirected to ${new URL(res.url).pathname}) — stopping scan silently, keeping ${acc.page.reviews.length} review(s).`);
        return;
      }
      if (!res.ok) {
        console.log(`[TrustLens] Additional review page ${pageNumber} fetch failed (HTTP ${res.status}) — stopping scan silently, keeping ${acc.page.reviews.length} review(s).`);
        return;
      }
      html = await res.text();
    } catch (err) {
      console.log(`[TrustLens] Additional review page ${pageNumber} fetch errored — stopping scan silently, keeping ${acc.page.reviews.length} review(s).`, err);
      return;
    }

    const parsedDoc = new DOMParser().parseFromString(html, 'text/html');

    if (isSignInGated(parsedDoc)) {
      console.log(`[TrustLens] Review page ${pageNumber} requires sign-in — stopping scan silently, keeping ${acc.page.reviews.length} review(s).`);
      return;
    }

    const cards = queryAll('reviewCards', parsedDoc);
    if (cards.length === 0) {
      console.log(`[TrustLens] No review cards found on page ${pageNumber} — stopping scan, keeping ${acc.page.reviews.length} review(s).`);
      return;
    }

    const candidates = cards.map((card, index) => scrapeReview(card, acc.page.reviews.length + index, queryFirst));
    const added = mergeReviews(acc, candidates);
    if (added === 0) {
      console.log(`[TrustLens] Page ${pageNumber} returned no new reviews (likely end of pagination) — stopping scan, keeping ${acc.page.reviews.length} review(s).`);
      return;
    }

    console.log(`[TrustLens] Additional review page ${pageNumber} added ${added} new review(s) — now have ${acc.page.reviews.length} of ${acc.page.totalReviews} total review(s).`);
    reactRoot.render(<TrustPanel page={acc.page} />);
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
