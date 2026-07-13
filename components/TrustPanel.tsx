import { useEffect, useMemo, useRef, useState } from 'react';
import { getProviderKey, getSettings } from '@/lib/byo-key';
import { runDeepAnalysis } from '@/lib/deep-analysis';
import { recordHistoryEntry } from '@/lib/history';
import { checkProStatus } from '@/lib/license';
import { analyzeReviews } from '@/lib/statistical-engine';
import { FREE_TRIAL_LIMIT, getRemainingTrials, hasTrialsLeft, incrementUsage } from '@/lib/usage-limits';
import type { CheckStatus, ScrapedAmazonPage, StatisticalAnalysis, TrustGrade } from '@/lib/types';

interface TrustPanelProps {
  page: ScrapedAmazonPage;
}

// Item 8: the footer disclaimer used to be the full 3-5 sentence
// explanation every time — five lines of legalese nobody reads. This one
// line is what's always visible; the full analysis.disclaimer text (still
// population-honest, see lib/statistical-engine.ts) lives behind the (i)
// toggle for anyone who actually wants the "how this works" detail.
const SHORT_DISCLAIMER = 'Pattern-based signals, not proof.';

// Animation sequencing (ms) — mirrors the durations declared in
// gradelens.css (tl-panel-in, tl-row-in). Computed here rather than
// hardcoded because the medallion's hero sequence is supposed to start only
// once every signal row has finished staggering in, and the row count
// varies (2 population-only checks vs up to 6 with a full scraped sample) —
// a fixed delay would either cut rows off or leave an awkward gap before
// the medallion starts its story.
const ROW_STAGGER_START_MS = 280; // matches .gradelens-panel's tl-panel-in duration
const ROW_STAGGER_STEP_MS = 35;
const ROW_ANIM_DURATION_MS = 240; // matches .gradelens-check's tl-row-in duration
const MEDALLION_START_BUFFER_MS = 120; // breathing room after the last row settles, before the hero moment

// The medallion's own four-act story, once it starts: a bold entrance pop,
// a visible "thinking" beat, a punchy resolve into the real grade, then it
// goes static (idle handled entirely in CSS from there — see gradelens.css).
const MEDALLION_ENTER_MS = 550;
const MEDALLION_THINKING_MS = 750;
const MEDALLION_RESOLVE_MS = 300;

// Cosmetic-only during the "thinking" cycle — never the real computed
// grade, which is always taken from `analysis.grade` once resolve fires.
const THINKING_CYCLE_GLYPHS = ['A', 'B', 'C', 'D', 'F'];
const THINKING_CYCLE_STEP_MS = 80;

function medallionStartDelay(checkCount: number): number {
  const lastRowFinish = ROW_STAGGER_START_MS + Math.max(0, checkCount - 1) * ROW_STAGGER_STEP_MS + ROW_ANIM_DURATION_MS;
  return lastRowFinish + MEDALLION_START_BUFFER_MS;
}

type MedallionPhase = 'pending' | 'enter' | 'thinking' | 'resolve' | 'idle';

// Deliberately never themed off the user's Appearance setting or the OS —
// this renders inline on top of Amazon's own (always-white) page, so a dark
// card here would look broken regardless of preference. Light-only, always.
export function TrustPanel({ page }: TrustPanelProps) {
  // Graceful degradation: analyzeReviews is pure/synchronous and shouldn't
  // throw, but a truly unexpected page shape crashing here would otherwise
  // unmount the whole panel (React discards the tree on a render error with
  // no boundary above this component) — exactly the "blank panel" outcome
  // this extension must never produce. Falling back to an honest
  // "Insufficient data" read is always better than disappearing.
  const analysis = useMemo(() => safeAnalyze(page), [page]);
  // Frozen at first mount (lazy useState initializer, not useMemo) — this is
  // a ONE-TIME reveal. If more reviews stream in later and the check count
  // grows, re-deriving this from the new count would restart an in-flight
  // sequence, which is a jarring re-trigger, not a premium feel.
  const [startDelay] = useState(() => medallionStartDelay(analysis.checks.length));
  const [medallionPhase, setMedallionPhase] = useState<MedallionPhase>('pending');
  const [thinkingGlyph, setThinkingGlyph] = useState(THINKING_CYCLE_GLYPHS[0]);
  const [deepDive, setDeepDive] = useState('');
  const [deepDiveStatus, setDeepDiveStatus] = useState('');
  const [isPro, setIsPro] = useState(false);
  const [remainingTrials, setRemainingTrials] = useState(FREE_TRIAL_LIMIT);
  const [busy, setBusy] = useState(false);
  // Synchronous re-entrancy guard for the deep-dive button, mirroring the
  // same fix in Settings' KeyRow: the `busy` state disables the button, but
  // state only takes effect after a re-render, so two clicks fired in the
  // same tick (a genuine double-click, or a click while the first is still
  // in flight) could both slip past the disabled check and fire two AI
  // requests — double-billing the user's API quota and, on the free tier,
  // burning two trial analyses for one intended action. A ref flips
  // synchronously and closes that window.
  const deepDiveBusyRef = useRef(false);
  // Which signal rows are tap-expanded to show their plain-language "why" —
  // a Set so more than one can be open at once, independent of row order.
  const [expandedChecks, setExpandedChecks] = useState<Set<string>>(() => new Set());
  // Item 8: disclaimer collapsed to one line by default, full "how this
  // works" explanation tucked behind an (i) toggle instead of always
  // occupying 5 lines nobody reads.
  const [showFullDisclaimer, setShowFullDisclaimer] = useState(false);

  function toggleCheckExpanded(id: string) {
    setExpandedChecks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Local history (see lib/history.ts): records once a real grade exists,
  // and re-fires (overwriting the same ASIN's entry, never duplicating) if
  // the grade changes later as organic accumulation grows the sample —
  // always reflects the latest read GradeLens actually showed the user.
  useEffect(() => {
    if (analysis.grade === 'Insufficient data' || !page.asin) return;
    recordHistoryEntry({ asin: page.asin, title: page.title || page.asin, grade: analysis.grade, date: Date.now() }).catch(() => undefined);
  }, [analysis.grade, page.asin, page.title]);

  // Drives the phase transitions: enter (bold pop) -> thinking (cycling
  // letters + scan ring) -> resolve (punch-lock to the real grade) -> idle
  // (static, gentle breathing handled by CSS). Reduced-motion skips straight
  // to idle with the final grade already showing — no timers, no motion.
  useEffect(() => {
    const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
      setMedallionPhase('idle');
      return;
    }

    const enterAt = startDelay;
    const thinkingAt = enterAt + MEDALLION_ENTER_MS;
    const resolveAt = thinkingAt + MEDALLION_THINKING_MS;
    const idleAt = resolveAt + MEDALLION_RESOLVE_MS;

    const timers = [
      setTimeout(() => setMedallionPhase('enter'), enterAt),
      setTimeout(() => setMedallionPhase('thinking'), thinkingAt),
      setTimeout(() => setMedallionPhase('resolve'), resolveAt),
      setTimeout(() => setMedallionPhase('idle'), idleAt),
    ];
    return () => timers.forEach(clearTimeout);
  }, [startDelay]);

  // Cycles the displayed glyph only while actually in the "thinking" phase —
  // a lightweight slot-machine flicker, purely cosmetic, never the real
  // grade until resolve fires and displayedGlyph switches back to it.
  useEffect(() => {
    if (medallionPhase !== 'thinking') return;
    let index = 0;
    const interval = setInterval(() => {
      index = (index + 1) % THINKING_CYCLE_GLYPHS.length;
      setThinkingGlyph(THINKING_CYCLE_GLYPHS[index]);
    }, THINKING_CYCLE_STEP_MS);
    return () => clearInterval(interval);
  }, [medallionPhase]);

  useEffect(() => {
    async function loadAccessState() {
      const [license, remaining] = await Promise.all([checkProStatus(), getRemainingTrials()]);
      setIsPro(license.pro);
      setRemainingTrials(remaining);
    }
    loadAccessState().catch(() => undefined);
  }, []);

  async function handleDeepDive() {
    if (deepDiveBusyRef.current) return;
    deepDiveBusyRef.current = true;
    setBusy(true);
    setDeepDiveStatus('Checking AI analysis access...');
    setDeepDive('');

    try {
      const [license, settings, trialAvailable] = await Promise.all([checkProStatus(), getSettings(), hasTrialsLeft()]);
      const hasProAccess = license.pro;
      setIsPro(hasProAccess);

      if (!hasProAccess && !trialAvailable) {
        setRemainingTrials(0);
        setDeepDiveStatus('Free AI analyses are used up. Upgrade to continue.');
        return;
      }

      const apiKey = getProviderKey(settings);
      if (!apiKey) {
        setDeepDiveStatus(`Add a ${settings.provider === 'gemini' ? 'Gemini' : 'OpenAI'} key in GradeLens settings first.`);
        return;
      }

      setDeepDiveStatus('Running deep dive...');
      const result = await runDeepAnalysis({
        provider: settings.provider,
        apiKey,
        page,
        statistical: analysis,
      });
      if (!hasProAccess) {
        await incrementUsage();
        setRemainingTrials(await getRemainingTrials());
      }
      setDeepDive(result);
      setDeepDiveStatus('');
    } catch (error) {
      setDeepDiveStatus(error instanceof Error ? error.message : 'Deep dive failed.');
    } finally {
      deepDiveBusyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="gradelens-panel" aria-label="GradeLens review confidence">
      <div className="gradelens-brand">
        <ShieldIcon className="gradelens-shield" />
        <p className="gradelens-wordmark">GradeLens</p>
      </div>

      <div className="gradelens-summary-row">
        <div
          className="gradelens-medallion"
          data-grade={analysis.grade}
          data-medallion-phase={medallionPhase}
          data-confidence={analysis.confidence}
        >
          <span className="gradelens-medallion-letter">
            {medallionPhase === 'thinking' ? thinkingGlyph : medallionGlyph(analysis.grade)}
          </span>
        </div>
        <div className="gradelens-summary-text">
          <div className="gradelens-title-row">
            <p className="gradelens-title">Review confidence</p>
            {analysis.grade !== 'Insufficient data' ? (
              <span className="gradelens-confidence-chip" data-level={analysis.confidence}>{analysis.confidence} confidence</span>
            ) : null}
          </div>
          <p className="gradelens-subtitle">{subtitleText(page)}</p>
        </div>
      </div>

      <p className="gradelens-verdict">{analysis.verdict}</p>

      <div className="gradelens-checks">
        {analysis.checks.map((check, index) => {
          const isShortfall = check.id === 'sample-size';
          const isExpanded = expandedChecks.has(check.id);
          return (
            <div
              className="gradelens-check"
              data-status={check.status}
              data-expanded={isExpanded}
              key={check.id}
              style={{ animationDelay: `${ROW_STAGGER_START_MS + index * ROW_STAGGER_STEP_MS}ms` }}
            >
              <button
                type="button"
                className="gradelens-check-row"
                aria-expanded={isExpanded}
                onClick={() => toggleCheckExpanded(check.id)}
              >
                <div className="gradelens-check-left">
                  <CheckStatusIcon status={check.status} />
                  <span className={isShortfall ? 'gradelens-check-label gradelens-check-label--wrap' : 'gradelens-check-label'}>
                    {check.label}
                  </span>
                </div>
                {!isShortfall ? (
                  <span className="gradelens-check-right">
                    <span className="gradelens-check-chip">{statusLabel(check.status)}</span>
                    <ChevronIcon className="gradelens-check-chevron" />
                  </span>
                ) : null}
              </button>
              {isExpanded && !isShortfall ? <p className="gradelens-check-detail">{check.detail}</p> : null}
            </div>
          );
        })}
      </div>

      <hr className="gradelens-divider" />

      <div className="gradelens-plan-row">
        <span className="gradelens-plan-badge" data-plan={isPro ? 'pro' : 'free'}>{isPro ? 'Pro' : 'Free'}</span>
        {!isPro ? (
          <span className="gradelens-trials-inline">{remainingTrials} of {FREE_TRIAL_LIMIT} free analyses left</span>
        ) : null}
      </div>

      <button className="gradelens-button" disabled={busy || analysis.grade === 'Insufficient data'} onClick={handleDeepDive}>
        {busy ? 'Analyzing...' : ctaText(isPro, remainingTrials)}
      </button>

      {deepDiveStatus ? <p className="gradelens-status">{deepDiveStatus}</p> : null}
      {deepDive ? renderDeepDiveBody(deepDive) : null}

      <hr className="gradelens-divider" />

      <footer className="gradelens-footer">
        <div className="gradelens-disclaimer-row">
          <p className="gradelens-disclaimer">{SHORT_DISCLAIMER}</p>
          <button
            type="button"
            className="gradelens-disclaimer-info"
            aria-expanded={showFullDisclaimer}
            aria-label="How this works"
            onClick={() => setShowFullDisclaimer((prev) => !prev)}
          >
            ⓘ
          </button>
        </div>
        {showFullDisclaimer ? <p className="gradelens-disclaimer-full">{analysis.disclaimer}</p> : null}
        <button
          className="gradelens-settings-link"
          onClick={() => browser.runtime.sendMessage({ type: 'gradelens:open-options' }).catch(() => undefined)}
        >
          Settings
        </button>
      </footer>
    </section>
  );
}

// See the useMemo call above — analyzeReviews should never throw, but if an
// unforeseen page shape somehow does trip an exception here, catching it
// and returning an honest "Insufficient data" read keeps the panel visible
// and correct rather than letting React discard the whole tree.
function safeAnalyze(page: ScrapedAmazonPage): StatisticalAnalysis {
  try {
    return analyzeReviews(page);
  } catch (error) {
    console.warn('[GradeLens] analyzeReviews threw unexpectedly — falling back to Insufficient data.', error);
    const label = 'GradeLens hit an unexpected error reading this page and could not compute a grade.';
    return {
      grade: 'Insufficient data',
      score: null,
      sampleSize: page.reviews.length,
      checks: [{ id: 'sample-size', label, status: 'unknown', score: 0, detail: label }],
      disclaimer: 'GradeLens shows pattern-based confidence signals from visible review data. It does not prove whether any review, reviewer, seller, or product is fake.',
      confidence: 'Low',
      verdict: 'Not enough data on this page to make a call — read a handful of recent reviews yourself before deciding.',
    };
  }
}

// The AI deep-dive comes back as a "quick verdict card": a bare one-line
// verdict, then 3-5 sentiment-emoji bullets, each with one **key phrase**
// (see lib/deep-analysis.ts's prompt). This renders that shape with real
// visual hierarchy instead of dumping it into one flat paragraph — the
// verdict line is the headline, each bullet's emphasized span gets a
// sentiment-tinted background so the key finding jumps out at a glance.
function renderDeepDiveBody(text: string) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const [verdictLine, ...bulletLines] = lines;

  return (
    <div className="gradelens-deep-dive">
      <p className="gradelens-deepdive-verdict">{renderEmphasis(truncateWords(verdictLine, HEADLINE_MAX_WORDS), 'neutral')}</p>
      {bulletLines.length > 0 ? (
        <ul className="gradelens-deepdive-bullets">
          {bulletLines.map((line, index) => {
            const sentiment = bulletSentiment(line);
            return (
              <li key={index} className="gradelens-deepdive-bullet" data-sentiment={sentiment}>
                {renderEmphasis(line, sentiment)}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

// Item 6: the prompt already asks for a <=10-word headline, but this is the
// actual enforcement — a rendering-side cap means a model that ignores the
// instruction still can't produce the 3-line serif wall this was meant to
// fix. Small slack over the requested 10 (12) before an ellipsis kicks in,
// consistent with how the rest of this file treats prompt limits as
// targets the model aims for, not hard contracts it always honors.
const HEADLINE_MAX_WORDS = 12;

function truncateWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;
  return `${words.slice(0, maxWords).join(' ')}…`;
}

type EmphasisSentiment = 'pass' | 'risk' | 'neutral';

function bulletSentiment(line: string): EmphasisSentiment {
  if (line.startsWith('✅')) return 'pass';
  if (line.startsWith('⚠️') || line.startsWith('⚠')) return 'risk';
  return 'neutral'; // 🔍 (observation) and ⭐ (standout) share the neutral/slate tint
}

// Splits on **...** spans (stripMarkdown in lib/deep-analysis.ts guarantees
// any surviving ** pair is well-formed) and wraps each in a sentiment-tinted
// <mark> — everything else renders as plain text, so a bullet with zero or
// multiple emphasis spans still renders correctly either way.
//
// Item 5: the prompt asks for a 1-3 word span, but this is the actual
// enforcement — if the model emphasizes a longer phrase anyway, only the
// first 3 words get the tinted-bold treatment; the rest of that phrase
// still renders, just as plain text. Without this cap a model that ignores
// the instruction can boxed-highlight most of a bullet, which is exactly
// the "40% of the text is boxed, nothing stands out" problem being fixed.
const EMPHASIS_MAX_WORDS = 3;

function renderEmphasis(line: string, sentiment: EmphasisSentiment) {
  const parts = line.split(/(\*\*.+?\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      const words = part.slice(2, -2).split(/\s+/).filter(Boolean);
      const emphasized = words.slice(0, EMPHASIS_MAX_WORDS).join(' ');
      const overflow = words.slice(EMPHASIS_MAX_WORDS).join(' ');
      return (
        <span key={index}>
          <mark className="gradelens-emph" data-sentiment={sentiment}>
            {emphasized}
          </mark>
          {overflow ? ` ${overflow}` : ''}
        </span>
      );
    }
    return <span key={index}>{part}</span>;
  });
}

function ctaText(isPro: boolean, remainingTrials: number): string {
  if (isPro) return 'Run Pro deep dive';
  if (remainingTrials <= 0) return 'Upgrade to continue';
  return 'Run AI deep dive';
}

function medallionGlyph(grade: TrustGrade): string {
  return grade === 'Insufficient data' ? '–' : grade;
}

// Item 2: plain-language status text for the signal-row chip — "PASS"/
// "WATCH" read like a CI pipeline, not something a shopper glancing at a
// browser extension expects to parse. Short enough to still fit the pill.
function statusLabel(status: CheckStatus): string {
  switch (status) {
    case 'pass':
      return 'Looks fine';
    case 'watch':
      return 'Worth a look';
    case 'risk':
      return 'Red flag';
    case 'unknown':
      return 'Unclear';
  }
}

// Population-first framing, matching how the grade is actually computed now
// (see analyzeReviews): "Based on N reviews" reflects Amazon's full review
// count, not just the handful of cards GradeLens managed to scrape. The
// "analyzed in detail" count is reviewsScanned, which grows live as organic
// accumulation and opportunistic pagination add more cards (see
// entrypoints/content.tsx) — this re-renders on every growth, so the number
// visibly climbs without a page reload.
function subtitleText(page: ScrapedAmazonPage): string {
  if (page.averageRating !== null && page.totalReviews > 0) {
    const base = `Based on ${page.totalReviews.toLocaleString()} reviews (${page.averageRating.toFixed(1)}★)`;
    return page.reviewsScanned > 0
      ? `${base} · ${page.reviewsScanned.toLocaleString()} analyzed in detail`
      : base;
  }
  if (page.reviewsScanned > 0) {
    return `${page.reviewsScanned.toLocaleString()} reviews analyzed in detail`;
  }
  return 'Limited review data available';
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M12 2.5L4.5 5.4v5.7c0 5.2 3.3 9.6 7.5 11 4.2-1.4 7.5-5.8 7.5-11V5.4L12 2.5z" fill="currentColor" />
    </svg>
  );
}

function CheckStatusIcon({ status }: { status: CheckStatus }) {
  if (status === 'pass') return <CheckIcon />;
  if (status === 'risk') return <WarningIcon />;
  return <DotIcon />;
}

function CheckIcon() {
  return (
    <svg className="gradelens-check-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7.5 12.5l3 3 6-6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg className="gradelens-check-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M12 3.5L21 19H3L12 3.5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M12 9.5v4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="16.5" r="0.9" fill="currentColor" />
    </svg>
  );
}

function DotIcon() {
  return (
    <svg className="gradelens-check-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="3.2" fill="currentColor" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M7 9.5l5 5 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
