export type TrustGrade = 'A' | 'B' | 'C' | 'D' | 'F' | 'Insufficient data';

export type CheckStatus = 'pass' | 'watch' | 'risk' | 'unknown';

export type DeepAnalysisProvider = 'gemini' | 'openai';

// Settings-page-only preference — TrustPanel and Popup are hard-locked to
// light (see components/TrustPanel.tsx, entrypoints/popup/App.tsx) since
// they render on top of Amazon's always-white pages.
export type ThemePreference = 'light' | 'dark';

export interface ReviewSample {
  id: string;
  rating: number | null;
  title: string;
  body: string;
  date: string | null;
  verified: boolean;
  vine: boolean;
}

export interface ScrapedAmazonPage {
  asin: string | null;
  locale: string;
  url: string;
  title: string;
  averageRating: number | null;
  totalReviewCount: number | null;
  productFirstAvailable: string | null;
  reviews: ReviewSample[];
  /** Explicit count of reviews actually scraped — mirrors reviews.length, kept as its own field for UI/API stability as this grows across the lazy-load and additional-page-fetch enhancements. */
  reviewsScanned: number;
  /** Convenience non-null alias of totalReviewCount, for "Scanned X of Y reviews" display. */
  totalReviews: number;
}

export interface RuleCheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  score: number;
  detail: string;
}

export interface StatisticalAnalysis {
  grade: TrustGrade;
  score: number | null;
  sampleSize: number;
  checks: RuleCheckResult[];
  disclaimer: string;
}

export interface StoredSettings {
  geminiKey?: string;
  openaiKey?: string;
  provider: DeepAnalysisProvider;
  devProOverride: boolean;
  enabled: boolean;
  theme: ThemePreference;
}

export interface LicenseStatus {
  pro: boolean;
  licenseKey?: string;
  checkedAt?: number;
  nextCheckAt?: number;
  message: string;
}

export interface KeyTestResult {
  ok: boolean;
  message: string;
}
