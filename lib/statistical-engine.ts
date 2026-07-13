import type { CheckStatus, ConfidenceLevel, ReviewSample, RuleCheckResult, ScrapedAmazonPage, StatisticalAnalysis, TrustGrade } from './types';

const DISCLAIMER =
  'GradeLens shows pattern-based confidence signals from visible review data. It does not prove whether any review, reviewer, seller, or product is fake.';

// Never apologize for population-sourced grading — it's the strongest signal
// available (Amazon's own full-population histogram/rating/count), not a
// fallback taken because something else came up short. A product with 14
// total reviews and a product with 190,000 both get this same confident
// framing; checkConfidence below is what actually communicates "this is a
// thinner claim than that one," not the disclaimer's tone.
const POPULATION_DISCLAIMER =
  'GradeLens shows pattern-based confidence signals. This grade is sourced from the product\'s full public rating history — its star-by-star breakdown, total review count, and average rating — which reflects every review Amazon has recorded, not just the handful GradeLens can read individually. The scraped sample above adds supporting detail where available.';

// A tiny visible sample (Amazon's default in-page order skews toward
// "helpful"-voted reviews, which are disproportionately critical) is enough
// to show partial supporting signals but not enough on its own to carry a
// grade. This no longer gates whether a grade is possible at all — see
// hasPopulationCore below — only whether the sample-derived supporting
// checks (verified-ratio, review-velocity, age-ratio, repeated-language)
// get included alongside the population-level core.
const MIN_SAMPLE_SIZE = 30;

const MIN_HISTOGRAM_LEVELS = 3;
// Percentages should sum close to 100 (rounding); wider drift means the
// scrape landed on the wrong element and shouldn't be trusted.
const HISTOGRAM_SUM_TOLERANCE = 8;

export function analyzeReviews(page: ScrapedAmazonPage): StatisticalAnalysis {
  const hasSample = page.reviews.length >= MIN_SAMPLE_SIZE;
  const hasCore = hasPopulationCore(page);

  if (!hasSample && !hasCore) {
    const label = page.totalReviews > 0
      ? `Only ${page.reviews.length} of ${page.totalReviews.toLocaleString()} reviews could be read, and no star-by-star rating breakdown was found on this page.`
      : 'GradeLens could not find a rating breakdown, an overall rating, or enough visible reviews on this page to compute a grade.';

    return {
      grade: 'Insufficient data',
      score: null,
      sampleSize: page.reviews.length,
      checks: [{ id: 'sample-size', label, status: 'unknown', score: 0, detail: label }],
      disclaimer: DISCLAIMER,
      confidence: 'Low',
      verdict: 'Not enough data on this page to make a call — read a handful of recent reviews yourself before deciding.',
    };
  }

  // Population-level evidence — the star-by-star histogram, Amazon's own
  // aggregate rating/count, and the price-vs-review-count sanity check —
  // reflects the ENTIRE review base (or, for price, doesn't depend on the
  // sample at all), so these form the core of every grade whenever
  // available. Sample-derived checks only join in as supporting signals,
  // and only once there's enough sample to say anything meaningful with it.
  const populationChecks = [checkHistogramShape(page), checkOverallRatingEvidence(page), checkPriceVsReviewCount(page)];
  const checks = hasSample
    ? [
        ...populationChecks,
        checkVerifiedRatio(page.reviews),
        checkReviewVelocity(page.reviews),
        checkAgeRatio(page),
        checkRepeatedLanguage(page.reviews),
      ]
    : populationChecks;

  // A check that couldn't actually be computed on this page (status
  // 'unknown' — a selector miss, an unreadable price, too few dated reviews
  // to judge timing, etc.) must not drag the score toward its placeholder
  // value at full weight. Only checks that produced a real read enter the
  // weighted average; "unknown" is excluded outright, not soft-penalized.
  // Falls back to using every check only in the practically-unreachable case
  // where ALL of them came back unknown, to avoid a division by zero.
  const ratedChecks = checks.filter((check) => check.status !== 'unknown');
  const scoredChecks = ratedChecks.length > 0 ? ratedChecks : checks;
  const rawScore = Math.round(
    scoredChecks.reduce((sum, check) => sum + check.score * checkWeight(check.id), 0) /
      scoredChecks.reduce((sum, check) => sum + checkWeight(check.id), 0),
  );

  const { grade, score, guardEngaged } = applyPopulationSanityGuard(gradeFromScore(rawScore), rawScore, page);
  const confidence = computeConfidence(page, hasSample);

  return {
    grade,
    score,
    sampleSize: page.reviews.length,
    checks,
    disclaimer: hasSample ? DISCLAIMER : POPULATION_DISCLAIMER,
    confidence,
    verdict: computeVerdict(grade, confidence, checks, guardEngaged),
  };
}

// Sanity guard: population evidence — Amazon's own displayed average
// rating, backed by a genuinely large review count — is the strongest
// signal GradeLens has and must never be contradicted by a worse grade. A
// 195,000-review, 4.7-star product graded C or lower looks broken to any
// user, regardless of what an individual pattern check flagged (an
// unreadable price field, a slightly thin mid-range histogram band, etc.)
// Only engages when the population evidence is itself unambiguous — very
// high rating AND very large review count together; anything short of that
// is exactly the kind of thinner, more ambiguous case the pattern checks
// above exist to weigh in on, so it's left alone.
const STRONG_POPULATION_MIN_RATING = 4.5;
const STRONG_POPULATION_MIN_REVIEWS = 10000;
const STRONG_POPULATION_FLOOR_GRADE: TrustGrade = 'B';
// gradeFromScore's own B threshold — keeps score and grade mutually
// consistent in case score is ever used to re-derive a grade elsewhere.
const STRONG_POPULATION_FLOOR_SCORE = 74;
const GRADE_RANK: Record<TrustGrade, number> = { A: 5, B: 4, C: 3, D: 2, F: 1, 'Insufficient data': 0 };

function applyPopulationSanityGuard(
  grade: TrustGrade,
  score: number,
  page: ScrapedAmazonPage,
): { grade: TrustGrade; score: number; guardEngaged: boolean } {
  const { averageRating, totalReviewCount } = page;
  const populationIsStrong =
    grade !== 'Insufficient data' &&
    averageRating !== null &&
    averageRating >= STRONG_POPULATION_MIN_RATING &&
    !!totalReviewCount &&
    totalReviewCount >= STRONG_POPULATION_MIN_REVIEWS;

  if (!populationIsStrong || GRADE_RANK[grade] >= GRADE_RANK[STRONG_POPULATION_FLOOR_GRADE]) {
    return { grade, score, guardEngaged: false };
  }

  return { grade: STRONG_POPULATION_FLOOR_GRADE, score: Math.max(score, STRONG_POPULATION_FLOOR_SCORE), guardEngaged: true };
}

// Confidence answers a different question than the grade does: not "is this
// product good" but "how much can this specific grade be leaned on." Driven
// by the TRUE population size (totalReviewCount), not just whether a
// histogram happens to be readable — a complete star-by-star breakdown of
// only 14 reviews is still just 14 data points, no less noisy than any
// other small sample, even though GradeLens can see 100% of it. The AULA
// F99 case (14 total reviews, full histogram, clean-looking grade) must
// land Low, not Moderate, or this indicator says nothing a shopper couldn't
// already tell from the grade alone.
function computeConfidence(page: ScrapedAmazonPage, hasSample: boolean): ConfidenceLevel {
  const totalReviews = page.totalReviewCount ?? 0;

  if (totalReviews >= 1000) return 'High';
  // A large-enough population (even without perfect histogram resolution)
  // or a genuinely large scraped-and-read sample are each independently
  // enough to call it Moderate.
  if (totalReviews >= 200 || hasSample) return 'Moderate';
  return 'Low';
}

// The one-sentence decision a shopper actually wants: not "here is a report
// card" but "should I buy this." Confidence tempers the grade's own
// language — a clean-looking grade backed by thin data still gets a hedge,
// because that's the honest claim, not the flattering one.
function computeVerdict(grade: TrustGrade, confidence: ConfidenceLevel, checks: RuleCheckResult[], guardEngaged: boolean): string {
  const riskCount = checks.filter((check) => check.status === 'risk').length;

  // Price-vs-review-count firing red is the single most concrete,
  // actionable finding GradeLens can surface (item 3) — when it fires, it
  // IS the verdict, not a footnote buried under a generic grade-based line.
  const priceCheck = checks.find((check) => check.id === 'price-vs-reviews');
  if (priceCheck?.status === 'risk') {
    return priceCheck.detail;
  }

  // The population sanity guard overrode a worse computed grade — say so
  // honestly rather than let the grade's own "signals look clean" language
  // imply every individual check agreed, when what actually happened is
  // Amazon's own rating history at huge scale outweighed a more mixed read.
  if (guardEngaged) {
    return "Amazon's own rating history here is overwhelmingly positive at a very large scale — that outweighs the more mixed pattern signals below. Buy with normal caution.";
  }

  if (grade === 'A' || grade === 'B') {
    if (confidence === 'Low') {
      return 'Signals look clean, but the review base is small — skim a few recent reviews yourself before deciding.';
    }
    return 'Signals look clean — buy with normal caution.';
  }

  if (grade === 'C') {
    return confidence === 'Low'
      ? 'Signals are mixed and the review base is thin — worth reading recent reviews before deciding.'
      : 'Signals are mixed — worth a quick look at recent reviews before buying.';
  }

  // D or F
  return riskCount >= 2
    ? 'Several signals suggest caution — read recent reviews carefully before buying.'
    : 'At least one signal suggests caution — read recent reviews before buying.';
}

// True whenever there's population-level evidence to grade from at all —
// either a usable star-by-star histogram or Amazon's own aggregate
// rating+count. This is deliberately broad (no minimum review-count floor
// beyond what checkHistogramShape/checkOverallRatingEvidence themselves
// require to trust their data): a 1,920-review product should get a real
// grade from its histogram just as readily as a 190,000-review one — the
// checks below already scale their confidence language to volume.
function hasPopulationCore(page: ScrapedAmazonPage): boolean {
  const hasHistogram = page.ratingHistogram.length >= MIN_HISTOGRAM_LEVELS;
  const hasAggregate = page.averageRating !== null && !!page.totalReviewCount;
  return hasHistogram || hasAggregate;
}

// The single richest signal available: Amazon computes this star-by-star
// breakdown from the full review population, not a scraped sample, so it
// can't be skewed by which handful of reviews happened to render on the
// page. Organic products show a gradually declining curve (most 5★, fewer
// at each step down); manipulated ones tend toward a "J-shape" — inflated
// 5★ and 1★ with a hollow 2-4★ middle (paid/incentivized positives plus
// real buyers who got burned), or near-total 5★ concentration with almost
// no spread at all.
function checkHistogramShape(page: ScrapedAmazonPage): RuleCheckResult {
  const byStar = new Map(page.ratingHistogram.map((entry) => [entry.star, entry.percent]));
  if (byStar.size < MIN_HISTOGRAM_LEVELS) {
    return result('histogram-shape', 'Rating pattern', 'unknown', 60, "GradeLens couldn't read the star-by-star rating breakdown on this page.");
  }

  const p5 = byStar.get(5) ?? 0;
  const p4 = byStar.get(4) ?? 0;
  const p3 = byStar.get(3) ?? 0;
  const p2 = byStar.get(2) ?? 0;
  const p1 = byStar.get(1) ?? 0;
  const total = p5 + p4 + p3 + p2 + p1;

  if (Math.abs(total - 100) > HISTOGRAM_SUM_TOLERANCE) {
    return result('histogram-shape', 'Rating pattern', 'unknown', 60, "The star-by-star numbers on this page didn't add up to something GradeLens could trust.");
  }

  const middle = p4 + p3 + p2;
  const shape = `${Math.round(p5)}% 5★, ${Math.round(p4)}% 4★, ${Math.round(p3)}% 3★, ${Math.round(p2)}% 2★, ${Math.round(p1)}% 1★`;

  if (middle >= 20) {
    return result('histogram-shape', 'Rating pattern', 'pass', 93, `${shape} — most ratings are high, with a normal mix of everything else too. That's what a genuine, unmanipulated spread looks like.`);
  }

  // The actual manipulation signature is BOTH extremes inflated — fake
  // positives at 5★ mixed with real burned buyers at 1★, hollowing out the
  // middle. High 5★ share alone is not that: a huge, genuinely well-loved
  // product naturally has a heavy 5★ skew AND a naturally small 1★ tail, and
  // used to trip this as a false positive. Requiring p1 to itself be
  // meaningfully elevated (not just "some 1-stars exist") separates the two.
  // Both the required 1★ floor and how hollow the middle must be (relative
  // to the two extremes) relax as the review count grows — sustained
  // large-scale manipulation is both harder to pull off and far more likely
  // to already have been caught by Amazon at huge volume, so a shape that's
  // a red flag at a few hundred reviews needs to be starker to still be one
  // at tens of thousands.
  const reviewCount = page.totalReviewCount ?? 0;
  const jShapeMinP1 = reviewCount >= 50000 ? 15 : reviewCount >= 5000 ? 12 : 10;
  const hollowMiddleCeiling = reviewCount >= 50000 ? 0.12 : reviewCount >= 5000 ? 0.16 : 0.2;
  const extremes = p5 + p1;
  const hollowRatio = extremes > 0 ? middle / extremes : 1;

  if (p1 >= jShapeMinP1 && hollowRatio <= hollowMiddleCeiling) {
    return result('histogram-shape', 'Rating pattern', 'risk', 25, `${shape} — ratings pile up at 5 stars and 1 star with almost nothing in between. That split can mean paid 5-star reviews mixed in with real unhappy buyers — worth a closer look.`);
  }

  // Genuinely excellent at scale: a heavy 5★ share with only a small 1★ tail
  // IS what a well-loved product looks like — a thin 2-4★ middle here is
  // expected, not suspicious. This must be checked BEFORE the "thin middle"
  // watch below, or a 4.7★/195k-review flagship (e.g. 82/10/3/2/3) gets
  // dinged for the very shape that signals it's great — the exact "grade
  // looks obviously wrong to a shopper" failure. Gated on a review base
  // large enough (>= 1000, where confidence also becomes High) that the
  // shape can't be cheaply staged.
  if (reviewCount >= 1000 && p5 >= 70 && p1 < jShapeMinP1) {
    return result('histogram-shape', 'Rating pattern', 'pass', 90, `${shape} — a heavy 5-star skew with only a small 1-star tail, backed by a large, well-established review base. That's the expected shape for a genuinely popular product, not a manipulated one.`);
  }

  // "Too perfect": near-total 5★ with almost no spread at all — but only
  // suspicious when the review base is small enough to be cheaply staged. At
  // scale this is usually just a genuinely dominant product, which the
  // branch above already passes.
  if (p5 >= 90 && reviewCount < 500) {
    return result('histogram-shape', 'Rating pattern', 'risk', 32, `${shape} — an unusually high share of 5-star ratings with almost no spread, on a still-small review base. Genuine products usually pick up more variety than this.`);
  }

  if (middle >= 10) {
    return result('histogram-shape', 'Rating pattern', 'watch', 62, `${shape} — fewer mid-range (2-4★) ratings than typical. Not alarming on its own, but a bit thinner than a natural spread.`);
  }

  return result('histogram-shape', 'Rating pattern', 'watch', 55, `${shape} — the spread of ratings across the scale is thinner than typical for a genuine product.`);
}

function checkVerifiedRatio(reviews: ReviewSample[]): RuleCheckResult {
  const known = reviews.filter((review) => !review.vine);
  // Same "can't compute, don't penalize" fix as the population checks: if
  // the entire visible sample happens to be Vine reviews, there is nothing
  // to score here — a 0% verified-purchase ratio would previously default
  // in and read as a red flag, when the real answer is just "not applicable."
  if (known.length === 0) {
    return result('verified-ratio', 'Verified purchase mix', 'unknown', 60, 'The visible review sample was entirely Vine reviews, so a verified-purchase ratio could not be computed.');
  }
  const ratio = known.filter((review) => review.verified).length / known.length;

  if (ratio >= 0.72) {
    return result('verified-ratio', 'Verified purchase mix', 'pass', 92, `${percent(ratio)} of visible non-Vine reviews show a verified-purchase badge.`);
  }

  if (ratio >= 0.45) {
    return result('verified-ratio', 'Verified purchase mix', 'watch', 64, `${percent(ratio)} of visible non-Vine reviews show a verified-purchase badge, which is a mixed signal.`);
  }

  return result('verified-ratio', 'Verified purchase mix', 'risk', 34, `Only ${percent(ratio)} of visible non-Vine reviews show a verified-purchase badge, so confidence is lower.`);
}

function checkReviewVelocity(reviews: ReviewSample[]): RuleCheckResult {
  const parsed = reviews.map((review) => parseReviewDate(review.date)).filter((date): date is Date => Boolean(date));
  if (parsed.length < 4) {
    return result('review-velocity', 'Review timing', 'unknown', 58, 'Too few visible review dates were readable to judge timing patterns.');
  }

  const buckets = new Map<string, number>();
  for (const date of parsed) {
    const key = `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const maxBucketRatio = Math.max(...buckets.values()) / parsed.length;

  if (maxBucketRatio >= 0.68) {
    return result('review-velocity', 'Review timing', 'risk', 36, `${percent(maxBucketRatio)} of readable visible reviews landed in the same month, which is a timing pattern to inspect.`);
  }

  if (maxBucketRatio >= 0.45) {
    return result('review-velocity', 'Review timing', 'watch', 66, 'Readable visible reviews show some timing concentration, but not enough to dominate the sample.');
  }

  return result('review-velocity', 'Review timing', 'pass', 90, 'Readable visible review dates are spread across multiple months.');
}

function checkAgeRatio(page: ScrapedAmazonPage): RuleCheckResult {
  const firstAvailable = parseLooseDate(page.productFirstAvailable);
  if (!firstAvailable || !page.totalReviewCount) {
    return result('age-ratio', 'Review count vs age', 'unknown', 60, 'GradeLens could not read both product age and total review count from this page variant.');
  }

  const ageMonths = Math.max(1, monthsBetween(firstAvailable, new Date()));
  const reviewsPerMonth = page.totalReviewCount / ageMonths;

  if (ageMonths <= 3 && page.totalReviewCount >= 120) {
    return result('age-ratio', 'Review count vs age', 'risk', 40, 'The public review count is high for a very recent listing, which lowers confidence.');
  }

  if (reviewsPerMonth > 90) {
    return result('age-ratio', 'Review count vs age', 'watch', 67, 'The public review count is growing quickly relative to the visible listing age.');
  }

  return result('age-ratio', 'Review count vs age', 'pass', 86, 'The public review count is within a typical range for the visible listing age.');
}

function checkRepeatedLanguage(reviews: ReviewSample[]): RuleCheckResult {
  const phrases = new Map<string, number>();
  for (const review of reviews) {
    const words = normalizeWords(`${review.title} ${review.body}`);
    for (let index = 0; index <= words.length - 4; index += 1) {
      const phrase = words.slice(index, index + 4).join(' ');
      phrases.set(phrase, (phrases.get(phrase) ?? 0) + 1);
    }
  }

  const repeated = [...phrases.values()].filter((count) => count >= 3).length;
  if (repeated >= 3) {
    return result('repeated-language', 'Repeated language', 'risk', 35, 'Several four-word phrases repeat across visible reviews, which lowers confidence.');
  }

  if (repeated > 0) {
    return result('repeated-language', 'Repeated language', 'watch', 70, 'A small amount of repeated phrasing appears in the visible review sample.');
  }

  return result('repeated-language', 'Repeated language', 'pass', 94, 'GradeLens did not find repeated four-word phrasing across the visible review sample.');
}

// Amazon's own aggregate rating and review count reflect the full review
// population, not the small (and "helpful"-vote-biased) sample GradeLens can
// scrape. Secondary to checkHistogramShape (which reads the same population
// but at full star-by-star resolution), this still carries extra weight
// over any single sample-derived check, and is often the only population
// signal available when the histogram itself can't be read.
function checkOverallRatingEvidence(page: ScrapedAmazonPage): RuleCheckResult {
  const { averageRating, totalReviewCount } = page;
  if (averageRating === null || !totalReviewCount) {
    return result('overall-rating', 'Rating & review count', 'unknown', 60, "GradeLens couldn't read this product's overall star rating or total review count.");
  }

  const summary = `${averageRating.toFixed(1)}★ average across ${totalReviewCount.toLocaleString()} reviews`;

  if (averageRating >= 4.5 && totalReviewCount >= 10000) {
    return result('overall-rating', 'Rating & review count', 'pass', 95, `${summary} — a strong, well-established track record.`);
  }
  if (averageRating >= 4.2 && totalReviewCount >= 1000) {
    return result('overall-rating', 'Rating & review count', 'pass', 85, `${summary} — a solid track record.`);
  }
  if (averageRating >= 3.8 && totalReviewCount >= 100) {
    return result('overall-rating', 'Rating & review count', 'watch', 65, `${summary} — a decent track record, though not outstanding.`);
  }
  if (averageRating < 3.0 && totalReviewCount >= 50) {
    return result('overall-rating', 'Rating & review count', 'risk', 30, `${summary} — a below-average track record worth noting.`);
  }
  return result('overall-rating', 'Rating & review count', 'watch', 60, `${summary} — not quite enough here yet to call this a strong or weak track record.`);
}

// The single most concrete, actionable insight GradeLens can offer that
// competitors don't: a genuinely high-priced product with very few reviews
// is suspicious in a way a cheap impulse-buy product with few reviews just
// isn't — buyers of expensive items are exactly as likely (often more so)
// to leave a review as buyers of cheap ones, so a thin review count on an
// expensive listing is a real anomaly, not just "a new product." Currency-
// aware thresholds since "high-priced" means very different things in ₹ vs
// $ vs £/€; unrecognized currencies fall back to a conservative USD-scale
// default rather than silently skipping the check.
const HIGH_PRICE_THRESHOLDS: Record<string, number> = {
  '₹': 3000,
  '$': 40,
  '£': 32,
  '€': 35,
  '¥': 4500,
};
const DEFAULT_HIGH_PRICE_THRESHOLD = 40;
const VERY_THIN_REVIEW_COUNT = 50;
const SOMEWHAT_THIN_REVIEW_COUNT = 150;

function checkPriceVsReviewCount(page: ScrapedAmazonPage): RuleCheckResult {
  const { price, priceCurrency, totalReviewCount } = page;
  if (price === null || !priceCurrency || !totalReviewCount) {
    return result('price-vs-reviews', 'Reviews vs. price', 'unknown', 60, "GradeLens couldn't read this product's price to compare against its review count.");
  }

  const threshold = HIGH_PRICE_THRESHOLDS[priceCurrency] ?? DEFAULT_HIGH_PRICE_THRESHOLD;
  const isHighPriced = price >= threshold;
  const formattedPrice = `${priceCurrency}${price.toLocaleString()}`;

  if (!isHighPriced) {
    return result('price-vs-reviews', 'Reviews vs. price', 'pass', 80, `At ${formattedPrice}, this is a lower-priced item — a thin review count here isn't unusual the way it would be for something expensive.`);
  }

  if (totalReviewCount < VERY_THIN_REVIEW_COUNT) {
    return result(
      'price-vs-reviews',
      'Reviews vs. price',
      'risk',
      25,
      `Only ${totalReviewCount.toLocaleString()} review${totalReviewCount === 1 ? '' : 's'} for a ${formattedPrice} product — unusually thin for this price. Treat with caution.`,
    );
  }

  if (totalReviewCount < SOMEWHAT_THIN_REVIEW_COUNT) {
    return result(
      'price-vs-reviews',
      'Reviews vs. price',
      'watch',
      60,
      `${totalReviewCount.toLocaleString()} reviews for a ${formattedPrice} product is on the lighter side for this price range.`,
    );
  }

  return result('price-vs-reviews', 'Reviews vs. price', 'pass', 88, `${totalReviewCount.toLocaleString()} reviews for a ${formattedPrice} product is a reasonable volume for this price range.`);
}

const CHECK_WEIGHTS: Partial<Record<string, number>> = {
  // Population-level evidence outweighs any single sample-derived check —
  // it can't be skewed by which 13-45 reviews Amazon happened to surface.
  // The histogram carries the most weight since it's the full-resolution
  // star-by-star breakdown; overall-rating and price-vs-reviews are coarser
  // (but often available, and price-vs-reviews is a genuinely concrete
  // finding on its own) population-level signals.
  'histogram-shape': 3,
  'overall-rating': 2,
  'price-vs-reviews': 2,
};

function checkWeight(id: string): number {
  return CHECK_WEIGHTS[id] ?? 1;
}

function result(id: string, label: string, status: CheckStatus, score: number, detail: string): RuleCheckResult {
  return { id, label, status, score, detail };
}

function gradeFromScore(score: number): TrustGrade {
  if (score >= 86) return 'A';
  if (score >= 74) return 'B';
  if (score >= 62) return 'C';
  if (score >= 48) return 'D';
  return 'F';
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function normalizeWords(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3);
}

function monthsBetween(start: Date, end: Date): number {
  return (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
}

function parseReviewDate(value: string | null): Date | null {
  if (!value) return null;
  const cleaned = value
    .replace(/^Reviewed\s+in\s+.+?\s+on\s+/i, '')
    .replace(/^Reviewed\s+on\s+/i, '')
    .trim();
  return parseLooseDate(cleaned);
}

function parseLooseDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value.replace(/\s+/g, ' ').trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
