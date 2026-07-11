import type { CheckStatus, ReviewSample, RuleCheckResult, ScrapedAmazonPage, StatisticalAnalysis, TrustGrade } from './types';

export const DISCLAIMER =
  'TrustLens shows pattern-based confidence signals from visible review data. It does not prove whether any review, reviewer, seller, or product is fake.';

const POPULATION_DISCLAIMER =
  'TrustLens shows pattern-based confidence signals. This grade is sourced from the product\'s public rating history (star-by-star breakdown, total reviews, and average rating), not a per-review scan, because too few individual reviews could be read.';

// A tiny visible sample (Amazon's default in-page order skews toward
// "helpful"-voted reviews, which are disproportionately critical) is enough
// to show partial supporting signals but not enough on its own to carry a
// grade. This no longer gates whether a grade is possible at all — see
// hasPopulationCore below — only whether the sample-derived supporting
// checks (verified-ratio, review-velocity, age-ratio, repeated-language)
// get included alongside the population-level core.
export const MIN_SAMPLE_SIZE = 30;

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
      : 'TrustLens could not find a rating breakdown, an overall rating, or enough visible reviews on this page to compute a grade.';

    return {
      grade: 'Insufficient data',
      score: null,
      sampleSize: page.reviews.length,
      checks: [{ id: 'sample-size', label, status: 'unknown', score: 0, detail: label }],
      disclaimer: DISCLAIMER,
    };
  }

  // Population-level evidence — the star-by-star histogram and Amazon's own
  // aggregate rating/count — reflects the ENTIRE review base, not the small
  // sample TrustLens can scrape, so it forms the core of every grade
  // whenever it's available. Sample-derived checks only join in as
  // supporting signals, and only once there's enough sample to say anything
  // meaningful with it.
  const checks = hasSample
    ? [
        checkHistogramShape(page),
        checkOverallRatingEvidence(page),
        checkVerifiedRatio(page.reviews),
        checkReviewVelocity(page.reviews),
        checkAgeRatio(page),
        checkRepeatedLanguage(page.reviews),
      ]
    : [checkHistogramShape(page), checkOverallRatingEvidence(page)];

  const score = Math.round(
    checks.reduce((sum, check) => sum + check.score * checkWeight(check.id), 0) /
      checks.reduce((sum, check) => sum + checkWeight(check.id), 0),
  );

  return {
    grade: gradeFromScore(score),
    score,
    sampleSize: page.reviews.length,
    checks,
    disclaimer: hasSample ? DISCLAIMER : POPULATION_DISCLAIMER,
  };
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
    return result('histogram-shape', 'Rating distribution shape', 'unknown', 60, 'TrustLens could not read a star-by-star rating breakdown on this page variant.');
  }

  const p5 = byStar.get(5) ?? 0;
  const p4 = byStar.get(4) ?? 0;
  const p3 = byStar.get(3) ?? 0;
  const p2 = byStar.get(2) ?? 0;
  const p1 = byStar.get(1) ?? 0;
  const total = p5 + p4 + p3 + p2 + p1;

  if (Math.abs(total - 100) > HISTOGRAM_SUM_TOLERANCE) {
    return result('histogram-shape', 'Rating distribution shape', 'unknown', 60, 'The star-by-star rating breakdown on this page did not add up to a usable total.');
  }

  const middle = p4 + p3 + p2;
  const shape = `${Math.round(p5)}% 5★, ${Math.round(p4)}% 4★, ${Math.round(p3)}% 3★, ${Math.round(p2)}% 2★, ${Math.round(p1)}% 1★`;

  if (middle >= 20) {
    return result('histogram-shape', 'Rating distribution shape', 'pass', 93, `${shape} — a natural, gradually declining curve across the full review population.`);
  }

  if (p5 >= 70 && p1 >= 10) {
    return result('histogram-shape', 'Rating distribution shape', 'risk', 25, `${shape} — ratings cluster at the extremes (5★ and 1★) with a hollow 2-4★ middle, an uneven ("J-shaped") distribution worth a closer look.`);
  }

  if (p5 >= 85) {
    return result('histogram-shape', 'Rating distribution shape', 'risk', 32, `${shape} — ratings are unusually concentrated at five stars with almost no spread across the rest of the scale.`);
  }

  if (middle >= 10) {
    return result('histogram-shape', 'Rating distribution shape', 'watch', 62, `${shape} — the 2-4★ middle is thinner than typical, so TrustLens reduces confidence slightly.`);
  }

  return result('histogram-shape', 'Rating distribution shape', 'watch', 55, `${shape} — the rating distribution is thin across the middle of the scale.`);
}

function checkVerifiedRatio(reviews: ReviewSample[]): RuleCheckResult {
  const known = reviews.filter((review) => !review.vine);
  const ratio = known.length ? known.filter((review) => review.verified).length / known.length : 0;

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
    return result('age-ratio', 'Review count vs age', 'unknown', 60, 'TrustLens could not read both product age and total review count from this page variant.');
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

  return result('repeated-language', 'Repeated language', 'pass', 94, 'TrustLens did not find repeated four-word phrasing across the visible review sample.');
}

// Amazon's own aggregate rating and review count reflect the full review
// population, not the small (and "helpful"-vote-biased) sample TrustLens can
// scrape. Secondary to checkHistogramShape (which reads the same population
// but at full star-by-star resolution), this still carries extra weight
// over any single sample-derived check, and is often the only population
// signal available when the histogram itself can't be read.
function checkOverallRatingEvidence(page: ScrapedAmazonPage): RuleCheckResult {
  const { averageRating, totalReviewCount } = page;
  if (averageRating === null || !totalReviewCount) {
    return result('overall-rating', 'Overall rating & review volume', 'unknown', 60, 'TrustLens could not read this product\'s overall star rating or total review count.');
  }

  const summary = `${averageRating.toFixed(1)} average across ${totalReviewCount.toLocaleString()} total reviews`;

  if (averageRating >= 4.5 && totalReviewCount >= 10000) {
    return result('overall-rating', 'Overall rating & review volume', 'pass', 95, `${summary} is strong independent evidence, drawn from Amazon's full review population rather than TrustLens's small visible sample.`);
  }
  if (averageRating >= 4.2 && totalReviewCount >= 1000) {
    return result('overall-rating', 'Overall rating & review volume', 'pass', 85, `${summary} is solid independent evidence.`);
  }
  if (averageRating >= 3.8 && totalReviewCount >= 100) {
    return result('overall-rating', 'Overall rating & review volume', 'watch', 65, `${summary} is a moderate independent signal.`);
  }
  if (averageRating < 3.0 && totalReviewCount >= 50) {
    return result('overall-rating', 'Overall rating & review volume', 'risk', 30, `${summary} is a weak independent signal.`);
  }
  return result('overall-rating', 'Overall rating & review volume', 'watch', 60, `${summary} is a limited independent signal.`);
}

const CHECK_WEIGHTS: Partial<Record<string, number>> = {
  // Population-level evidence outweighs any single sample-derived check —
  // it can't be skewed by which 13-45 reviews Amazon happened to surface.
  // The histogram carries the most weight since it's the full-resolution
  // star-by-star breakdown; overall-rating is the coarser (but more often
  // available) average+count fallback.
  'histogram-shape': 3,
  'overall-rating': 2,
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
