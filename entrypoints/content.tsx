import { createRoot } from 'react-dom/client';
import { TrustPanel } from '@/components/TrustPanel';
import '@/components/gradelens.css';
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

    // Amazon navigates between products via History-API partial swaps (most
    // visibly on size/color variant clicks), which do NOT re-fire a content
    // script's main() — it runs once per full page load. Without watching for
    // that, the panel would keep showing the first product's grade, and the
    // per-product review observer would merge the next product's cards into
    // the previous product's sample (a Frankenstein grade). The watcher +
    // reconcile() re-mount on every product change; reconcile() also does the
    // initial mount for this load. Every path resolves to a clean, silent
    // state on failure rather than surfacing an unhandled rejection.
    installNavigationWatcher();
    reconcile().catch((err) => {
      console.warn('[GradeLens] Initial mount failed unexpectedly — panel not mounted.', err);
    });
  },
});

// ---------------------------------------------------------------------------
// SPA-aware mount coordination
// ---------------------------------------------------------------------------

// The product this content-script instance currently has a panel mounted for
// (its ASIN, or the pathname as a fallback), and the teardown for that
// mount's review observer/timers. Module-scoped because a single content
// script instance persists across Amazon's in-page (History-API)
// navigations — main() only ever runs once per full page load.
let currentMountKey: string | null = null;
let activeCleanup: (() => void) | null = null;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;

// Null on any non-product page (search, category, cart) — reconcile() reads
// this to decide whether a panel should exist at all right now.
function currentProductKey(): string | null {
  if (!isProductPage()) return null;
  return asinFromUrl() ?? location.pathname;
}

function teardownCurrentMount(): void {
  activeCleanup?.();
  activeCleanup = null;
  document.getElementById('gradelens-root')?.remove();
  currentMountKey = null;
}

// Idempotent: brings the on-page panel in line with whatever product (if any)
// the URL now points at. Same product already mounted and still present in
// the DOM -> no-op. Different product, or navigated onto/off a product page
// -> teardown the old mount and fresh-mount (or just teardown). Every
// SPA-navigation signal funnels through here.
async function reconcile(): Promise<void> {
  const key = currentProductKey();
  if (key === null) {
    teardownCurrentMount();
    return;
  }
  if (key === currentMountKey && document.getElementById('gradelens-root')) {
    return;
  }
  teardownCurrentMount();
  currentMountKey = key;
  await mountWhenReady();
}

function scheduleReconcile(): void {
  if (reconcileTimer) clearTimeout(reconcileTimer);
  // Small delay so Amazon has a beat to swap in the new product's content
  // before we scrape it for the mount anchor and rating data.
  reconcileTimer = setTimeout(() => {
    reconcile().catch((err) => console.warn('[GradeLens] Re-mount after navigation failed.', err));
  }, 400);
}

function installNavigationWatcher(): void {
  // Back/forward.
  window.addEventListener('popstate', scheduleReconcile);
  // pushState/replaceState swaps: a content script runs in an isolated world
  // and can't observe the page's own history calls directly, so poll the
  // URL. Cheap (a string compare) and stops with the page; 800ms is well
  // under the time a user spends reading a freshly-swapped product.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      scheduleReconcile();
    }
  }, 800);
}

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
  const existing = document.getElementById('gradelens-root');
  if (existing) existing.remove();

  const initialPage = scrapeAmazonPage(document);
  const mountAnchor = initialPage.mountAnchor;
  if (!mountAnchor) {
    console.warn('[GradeLens] Could not find a stable mount anchor near the rating summary.');
    return;
  }

  const root = document.createElement('div');
  root.id = 'gradelens-root';
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
    // A pushState swap can land in the ≤800ms gap between URL polls; if the
    // product changed out from under this observer, do NOT merge the new
    // product's cards into the old sample — hand off to reconcile() to tear
    // this mount down and start a clean one for the new product instead.
    if (currentProductKey() !== currentMountKey) {
      scheduleReconcile();
      return;
    }
    if (acc.page.reviews.length >= MAX_ACCUMULATED_REVIEWS) {
      cleanup();
      return;
    }
    const cards = queryAll('reviewCards', document);
    const candidates = scrapeReviewCards(cards, acc.page.reviews.length);
    const added = mergeReviews(acc, candidates);
    if (added > 0) {
      console.log(
        `[GradeLens] Organic accumulation: ${added} newly-rendered review card(s) found while browsing — sample now ${acc.page.reviews.length}, re-grading.`,
      );
      reactRoot.render(<TrustPanel page={acc.page} />);
    }
  }

  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('pagehide', cleanup, { once: true });
  // Registered so teardownCurrentMount() (on SPA navigation to another
  // product) can stop this product's observer and pending debounce before a
  // fresh mount begins — otherwise a stale observer would keep firing.
  activeCleanup = cleanup;
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
        console.log(`[GradeLens] Additional review pages require signing in to Amazon (redirected to ${new URL(res.url).pathname}) — stopping scan silently, keeping ${acc.page.reviews.length} review(s).`);
        return;
      }
      if (!res.ok) {
        console.log(`[GradeLens] Additional review page ${pageNumber} fetch failed (HTTP ${res.status}) — stopping scan silently, keeping ${acc.page.reviews.length} review(s).`);
        return;
      }
      html = await res.text();
    } catch (err) {
      console.log(`[GradeLens] Additional review page ${pageNumber} fetch errored — stopping scan silently, keeping ${acc.page.reviews.length} review(s).`, err);
      return;
    }

    const parsedDoc = new DOMParser().parseFromString(html, 'text/html');

    if (isSignInGated(parsedDoc)) {
      console.log(`[GradeLens] Review page ${pageNumber} requires sign-in — stopping scan silently, keeping ${acc.page.reviews.length} review(s).`);
      return;
    }

    const cards = queryAll('reviewCards', parsedDoc);
    if (cards.length === 0) {
      console.log(`[GradeLens] No review cards found on page ${pageNumber} — stopping scan, keeping ${acc.page.reviews.length} review(s).`);
      return;
    }

    const candidates = scrapeReviewCards(cards, acc.page.reviews.length);
    const added = mergeReviews(acc, candidates);
    if (added === 0) {
      console.log(`[GradeLens] Page ${pageNumber} returned no new reviews (likely end of pagination) — stopping scan, keeping ${acc.page.reviews.length} review(s).`);
      return;
    }

    console.log(`[GradeLens] Additional review page ${pageNumber} added ${added} new review(s) — now have ${acc.page.reviews.length} of ${acc.page.totalReviews} total review(s).`);
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
  // .a-offscreen carries the full formatted price ("₹6,499.00", "$49.99")
  // as accessible text regardless of how the visible price is split into
  // separate whole/fraction/symbol spans. #corePrice_feature_div is the
  // confirmed-clean current-price container (verified live); deliberately
  // NOT using #corePriceDisplay_desktop_feature_div as a selector root — on
  // a live page it matched a blank decoy .a-offscreen span before the
  // crossed-out M.R.P. price, never the actual selling price. The broad
  // `.a-price .a-offscreen` fallback is for page variants without a
  // corePrice widget; its first match was confirmed correct too, just less
  // targeted. Trailing entries are older/regional layout fallbacks.
  price: [
    '#corePrice_feature_div .a-price .a-offscreen',
    '.a-price .a-offscreen',
    '#priceblock_dealprice',
    '#priceblock_ourprice',
    '#priceblock_saleprice',
  ],
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
  // Fallback chain, most-specific first. The last two entries are
  // deliberately NOT review/rating-section-specific — #productTitle is
  // present on essentially every Amazon product page regardless of how the
  // reviews widget itself is laid out, so if Amazon ever restructures away
  // from every rating-summary selector above, the panel still has somewhere
  // to mount instead of silently vanishing (item 5: layout resilience).
  mountAnchor: ['#averageCustomerReviews', '#averageCustomerReviews_feature_div', '[data-hook="average-star-rating"]', '#reviewsMedley', '[data-hook="reviews-medley-widget"]', '#productTitle', '#centerCol'],
};

// Selector groups whose absence is a NORMAL, expected state, not a sign of
// anything broken — a non-Vine review has no vine badge, an out-of-stock
// listing shows no price, a per-card field can be missing. Warning on these
// spammed the console on every ordinary page (one line per review card for
// vineBadge alone). Structural groups NOT listed here (title, averageRating,
// totalReviewCount, reviewCards, ratingHistogramTable, mountAnchor,
// productDetails) still warn once per scrape as a layout-change canary, and
// several of those also have a clearer dedicated message at the call site.
const QUIET_SELECTOR_GROUPS = new Set<keyof typeof selectors>([
  'asin',
  'price',
  'reviewStar',
  'reviewTitle',
  'reviewBody',
  'reviewDate',
  'verifiedBadge',
  'vineBadge',
]);

function queryFirst(group: keyof typeof selectors, root: ParentNode): Element | null {
  for (const selector of selectors[group]) {
    const found = root.querySelector(selector);
    if (found) return found;
  }
  if (!QUIET_SELECTOR_GROUPS.has(group)) {
    console.warn(`[GradeLens] No match for ${group}: ${selectors[group].join(', ')}`);
  }
  return null;
}

function queryAll(group: keyof typeof selectors, root: ParentNode): Element[] {
  for (const selector of selectors[group]) {
    const found = [...root.querySelectorAll(selector)];
    if (found.length) return found;
  }
  if (!QUIET_SELECTOR_GROUPS.has(group)) {
    console.warn(`[GradeLens] No matches for ${group}: ${selectors[group].join(', ')}`);
  }
  return [];
}

// Amazon renders a full star-by-star breakdown (e.g. "54% gave 5 stars") on
// nearly every product page, computed from the ENTIRE review population —
// unlike the ~10-45 review cards GradeLens can scrape, which are a small,
// "helpful"-vote-biased sample. This is the single richest signal available
// and doesn't require scrolling into the reviews section or hitting the
// sign-in gate that blocks the extra-page fetch in enhanceWithMoreReviews.
const MIN_HISTOGRAM_LEVELS = 3;

function scrapeRatingHistogram(root: ParentNode): RatingHistogramEntry[] {
  const table = queryFirst('ratingHistogramTable', root);
  if (!table) {
    console.warn('[GradeLens] No rating histogram table found on this page variant — grading will fall back to overall rating/count only.');
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
    const ariaLabel = ariaLabelOf(row);
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
  const ariaLabel = ariaLabelOf(row);
  const match = ariaLabel.match(/(\d{1,3})\s?(?:%|percent)/i) ?? text(row).match(/(\d{1,3})\s?%/);
  return match ? Number(match[1]) : null;
}

function ariaLabelOf(row: Element): string {
  return row.querySelector('[aria-label]')?.getAttribute('aria-label') ?? '';
}

function scrapeAmazonPage(root: Document): ScrapedAmazonPage & PageAnchors {
  const asinElement = queryFirst('asin', root) as HTMLInputElement | null;
  const reviewCards = queryAll('reviewCards', root).slice(0, 30);
  const totalReviewCount = integerFromText(text(queryFirst('totalReviewCount', root)));
  const parsedPrice = parsePrice(text(queryFirst('price', root)));

  const page = {
    asin: asinElement?.value || text(asinElement) || asinFromUrl(),
    locale: location.hostname.replace(/^www\./, ''),
    url: location.href,
    title: text(queryFirst('title', root)),
    averageRating: numberFromText(text(queryFirst('averageRating', root))),
    totalReviewCount,
    productFirstAvailable: findDateFirstAvailable(queryAll('productDetails', root), selectors.productDetailRows, root),
    reviews: scrapeReviewCards(reviewCards, 0),
    ratingHistogram: scrapeRatingHistogram(root),
    mountAnchor: queryFirst('mountAnchor', root),
    reviewsScanned: reviewCards.length,
    totalReviews: totalReviewCount ?? 0,
    price: parsedPrice?.amount ?? null,
    priceCurrency: parsedPrice?.currency ?? null,
  };

  if (!page.reviews.length) {
    console.warn('[GradeLens] No visible review cards found on this page. Amazon may lazy-load reviews or use a locale-specific layout.');
  }
  if (!page.productFirstAvailable) {
    console.warn('[GradeLens] Date First Available was not found in the visible product details blocks.');
  }

  checkSelectorHealth(page);

  return page;
}

// Silent self-check (item 5): the one combination that specifically signals
// a selector broken by an Amazon layout change, as opposed to an honestly
// low-review product — Amazon itself reports reviews exist (totalReviews >
// 0), but GradeLens found neither individual review cards NOR a histogram.
// A genuinely sparse product (few reviews) still normally has a working
// histogram; this combination means the scrape came back empty on a page
// that isn't actually empty. Console-only, never surfaced in the UI — the
// grading engine already degrades to an honest "Insufficient data" read
// regardless, this is purely a developer-facing early warning.
function checkSelectorHealth(page: ScrapedAmazonPage): void {
  if (page.totalReviews > 0 && page.reviews.length === 0 && page.ratingHistogram.length === 0) {
    console.warn(
      `[GradeLens] SELECTOR HEALTH: this page reports ${page.totalReviews.toLocaleString()} total review(s) but GradeLens scraped 0 review cards and found no rating histogram — likely a broken selector after an Amazon layout change, not a low-review product.`,
    );
  }
}

// Shared by every place review cards get scraped (initial page load,
// opportunistic pagination, organic accumulation) — previously each call
// site re-typed the same card->ReviewSample mapping inline.
function scrapeReviewCards(cards: Element[], startIndex: number): ReviewSample[] {
  return cards.map((card, offset) => scrapeReview(card, startIndex + offset));
}

function scrapeReview(card: Element, index: number): ReviewSample {
  const verifiedText = text(queryFirst('verifiedBadge', card));
  const vineText = text(queryFirst('vineBadge', card));

  return {
    id: card.id || `visible-review-${index}`,
    rating: numberFromText(text(queryFirst('reviewStar', card))),
    title: cleanupReviewTitle(text(queryFirst('reviewTitle', card))),
    body: text(queryFirst('reviewBody', card)),
    date: text(queryFirst('reviewDate', card)) || null,
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

// Reads a currency symbol + numeric amount out of Amazon's formatted price
// text (e.g. "₹6,499.00", "$49.99", "£35.00") — used by the price-vs-
// review-count sanity check (item 3). Thousands separators are stripped
// before parsing; unrecognized formats (no leading currency symbol) return
// null so the check degrades to "unknown" rather than misreading garbage.
function parsePrice(value: string): { amount: number; currency: string } | null {
  const match = value.match(/([₹$£€¥])\s?([\d,]+(?:\.\d+)?)/);
  if (!match) return null;
  const amount = Number(match[2].replace(/,/g, ''));
  return Number.isNaN(amount) ? null : { amount, currency: match[1] };
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
