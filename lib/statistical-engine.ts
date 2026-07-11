import type { CheckStatus, ReviewSample, RuleCheckResult, ScrapedAmazonPage, StatisticalAnalysis, TrustGrade } from './types';

export const DISCLAIMER =
  'TrustLens shows pattern-based confidence signals from visible review data. It does not prove whether any review, reviewer, seller, or product is fake.';

const POPULATION_DISCLAIMER =
  'TrustLens shows pattern-based confidence signals. This grade is sourced from the product\'s public rating history (total reviews and average rating), not a per-review scan, because too few individual reviews could be read.';

// A tiny visible sample (Amazon's default in-page order skews toward
// "helpful"-voted reviews, which are disproportionately critical) is enough
// to show partial signals but not enough to assert a letter grade — a wrong
// grade is worse than "Insufficient data". 30 is the floor of what a rule
// like rating-concentration needs before its output means anything.
export const MIN_SAMPLE_SIZE = 30;

// Below MIN_SAMPLE_SIZE, a grade can still be issued from Amazon's own
// aggregate rating/count alone — but only at thresholds extreme and
// unambiguous enough that no plausible per-review sample would overturn
// them (a 128k-review, 4.8-star product isn't going to turn out to be a
// scam). This is deliberately narrow: it must not fire for the broad middle
// ground where a real sample is actually needed to say anything meaningful.
const POPULATION_BYPASS_MIN_REVIEWS = 5000;
const POPULATION_BYPASS_MIN_RATING = 4.5;
const POPULATION_BYPASS_MAX_RATING = 2.0;

export function analyzeReviews(page: ScrapedAmazonPage): StatisticalAnalysis {
  if (page.reviews.length < MIN_SAMPLE_SIZE) {
    if (isPopulationBypassEligible(page)) {
      const check = checkPopulationEvidenceOnly(page);
      return {
        grade: gradeFromScore(check.score),
        score: check.score,
        sampleSize: page.reviews.length,
        checks: [check],
        disclaimer: POPULATION_DISCLAIMER,
      };
    }

    const shortfallLabel = page.totalReviews > 0
      ? `Only ${page.reviews.length} of ${page.totalReviews.toLocaleString()} loaded — need ${MIN_SAMPLE_SIZE} for a grade.`
      : `Only ${page.reviews.length} visible reviews found — need ${MIN_SAMPLE_SIZE} for a grade.`;

    return {
      grade: 'Insufficient data',
      score: null,
      sampleSize: page.reviews.length,
      checks: [
        {
          id: 'sample-size',
          label: shortfallLabel,
          status: 'unknown',
          score: 0,
          detail: shortfallLabel,
        },
      ],
      disclaimer: DISCLAIMER,
    };
  }

  const checks = [
    checkVerifiedRatio(page.reviews),
    checkRatingConcentration(page),
    checkReviewVelocity(page.reviews),
    checkAgeRatio(page),
    checkRepeatedLanguage(page.reviews),
    checkOverallRatingEvidence(page),
  ];
  const score = Math.round(
    checks.reduce((sum, check) => sum + check.score * checkWeight(check.id), 0) /
      checks.reduce((sum, check) => sum + checkWeight(check.id), 0),
  );

  return {
    grade: gradeFromScore(score),
    score,
    sampleSize: page.reviews.length,
    checks,
    disclaimer: DISCLAIMER,
  };
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

function checkRatingConcentration(page: ScrapedAmazonPage): RuleCheckResult {
  const ratings = page.reviews.map((review) => review.rating).filter((rating): rating is number => rating !== null);
  const fiveStarRatio = ratings.filter((rating) => rating >= 4.8).length / ratings.length;
  const oneLineFiveStars = page.reviews.filter((review) => (review.rating ?? 0) >= 4.8 && review.body.length < 90).length / page.reviews.length;

  if (fiveStarRatio > 0.86 && oneLineFiveStars > 0.35) {
    return result('rating-concentration', 'Rating concentration', 'risk', 38, 'Visible ratings cluster heavily at five stars and many high-rating reviews are very short.');
  }

  if (fiveStarRatio > 0.72) {
    return result('rating-concentration', 'Rating concentration', 'watch', 67, 'Visible ratings lean strongly positive, so TrustLens reduces confidence slightly.');
  }

  const average = page.averageRating ? `${page.averageRating.toFixed(1)} average rating` : 'the visible spread';
  return result('rating-concentration', 'Rating concentration', 'pass', 88, `The visible review ratings are not unusually concentrated compared with ${average}.`);
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
// scrape. A product with tens of thousands of reviews at a high average is
// strong independent evidence that a 13-review snippet sample should not be
// able to override, so this check carries extra weight in the final score.
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

function isPopulationBypassEligible(page: ScrapedAmazonPage): boolean {
  const { averageRating, totalReviewCount } = page;
  if (averageRating === null || !totalReviewCount) return false;
  if (totalReviewCount < POPULATION_BYPASS_MIN_REVIEWS) return false;
  return averageRating >= POPULATION_BYPASS_MIN_RATING || averageRating <= POPULATION_BYPASS_MAX_RATING;
}

// Only called once isPopulationBypassEligible has confirmed averageRating
// and totalReviewCount are both present and extreme enough to stand alone —
// label carries the full "sourced from population evidence" message since
// the panel renders single-line check labels, not the detail field.
function checkPopulationEvidenceOnly(page: ScrapedAmazonPage): RuleCheckResult {
  const averageRating = page.averageRating as number;
  const totalReviewCount = page.totalReviewCount as number;
  const summary = `Grade based on ${totalReviewCount.toLocaleString()} reviews (${averageRating.toFixed(1)}★ average) — only ${page.reviews.length} could be read directly.`;

  if (averageRating >= POPULATION_BYPASS_MIN_RATING) {
    return result('population-evidence', summary, 'pass', 90, summary);
  }
  return result('population-evidence', summary, 'risk', 15, summary);
}

const CHECK_WEIGHTS: Partial<Record<string, number>> = {
  // Population-level evidence outweighs any single sample-derived check —
  // it can't be skewed by which 13-45 reviews Amazon happened to surface.
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
