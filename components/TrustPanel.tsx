import { useEffect, useMemo, useState } from 'react';
import { getProviderKey, getSettings } from '@/lib/byo-key';
import { runDeepAnalysis } from '@/lib/deep-analysis';
import { checkProStatus, getDevProOverride } from '@/lib/license';
import { analyzeReviews } from '@/lib/statistical-engine';
import { FREE_TRIAL_LIMIT, getRemainingTrials, hasTrialsLeft, incrementUsage } from '@/lib/usage-limits';
import type { CheckStatus, ScrapedAmazonPage, TrustGrade } from '@/lib/types';

interface TrustPanelProps {
  page: ScrapedAmazonPage;
}

// Deliberately never themed off the user's Appearance setting or the OS —
// this renders inline on top of Amazon's own (always-white) page, so a dark
// card here would look broken regardless of preference. Light-only, always.
export function TrustPanel({ page }: TrustPanelProps) {
  const analysis = useMemo(() => analyzeReviews(page), [page]);
  const [deepDive, setDeepDive] = useState('');
  const [deepDiveStatus, setDeepDiveStatus] = useState('');
  const [isPro, setIsPro] = useState(false);
  const [remainingTrials, setRemainingTrials] = useState(FREE_TRIAL_LIMIT);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    async function loadAccessState() {
      const [license, devOverride, settings, remaining] = await Promise.all([
        checkProStatus(),
        getDevProOverride(),
        getSettings(),
        getRemainingTrials(),
      ]);
      setIsPro(Boolean(license.pro || (import.meta.env.DEV && (devOverride || settings.devProOverride))));
      setRemainingTrials(remaining);
    }
    loadAccessState().catch(() => undefined);
  }, []);

  async function handleDeepDive() {
    setBusy(true);
    setDeepDiveStatus('Checking AI analysis access...');
    setDeepDive('');

    try {
      const [license, devOverride, settings, trialAvailable] = await Promise.all([
        checkProStatus(),
        getDevProOverride(),
        getSettings(),
        hasTrialsLeft(),
      ]);
      const hasProAccess = Boolean(license.pro || (import.meta.env.DEV && (devOverride || settings.devProOverride)));
      setIsPro(hasProAccess);

      if (!hasProAccess && !trialAvailable) {
        setRemainingTrials(0);
        setDeepDiveStatus('Free AI analyses are used up. Upgrade to continue.');
        return;
      }

      const apiKey = getProviderKey(settings);
      if (!apiKey) {
        setDeepDiveStatus(`Add a ${settings.provider === 'gemini' ? 'Gemini' : 'OpenAI'} key in TrustLens settings first.`);
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
      setBusy(false);
    }
  }

  return (
    <section className="trustlens-panel" aria-label="TrustLens review confidence">
      <div className="trustlens-brand">
        <ShieldIcon className="trustlens-shield" />
        <p className="trustlens-wordmark">TrustLens</p>
      </div>

      <div className="trustlens-summary-row">
        <div className="trustlens-medallion" data-grade={analysis.grade}>
          <span className="trustlens-medallion-letter">{medallionGlyph(analysis.grade)}</span>
        </div>
        <div className="trustlens-summary-text">
          <p className="trustlens-title">Review confidence</p>
          <p className="trustlens-subtitle">{page.reviewsScanned.toLocaleString()} of {page.totalReviews.toLocaleString()} scanned</p>
        </div>
      </div>

      <div className="trustlens-checks">
        {analysis.checks.map((check, index) => {
          const isShortfall = check.id === 'sample-size';
          const needsWrap = isShortfall || check.id === 'population-evidence';
          return (
            <div
              className="trustlens-check"
              data-status={check.status}
              key={check.id}
              style={{ animationDelay: `${100 + index * 35}ms` }}
            >
              <div className="trustlens-check-left">
                <CheckStatusIcon status={check.status} />
                <span className={needsWrap ? 'trustlens-check-label trustlens-check-label--wrap' : 'trustlens-check-label'}>
                  {check.label}
                </span>
              </div>
              {!isShortfall ? <span className="trustlens-check-chip">{check.status}</span> : null}
            </div>
          );
        })}
      </div>

      <hr className="trustlens-divider" />

      <div className="trustlens-plan-row">
        <span className="trustlens-plan-badge" data-plan={isPro ? 'pro' : 'free'}>{isPro ? 'Pro' : 'Free'}</span>
        {!isPro ? (
          <span className="trustlens-trials-inline">{remainingTrials} of {FREE_TRIAL_LIMIT} free analyses left</span>
        ) : null}
      </div>

      <button className="trustlens-button" disabled={busy || analysis.grade === 'Insufficient data'} onClick={handleDeepDive}>
        {busy ? 'Analyzing...' : ctaText(isPro, remainingTrials)}
      </button>

      {deepDiveStatus ? <p className="trustlens-status">{deepDiveStatus}</p> : null}
      {deepDive ? <div className="trustlens-deep-dive">{deepDive}</div> : null}

      <hr className="trustlens-divider" />

      <footer className="trustlens-footer">
        <p className="trustlens-disclaimer">{analysis.disclaimer}</p>
        <button
          className="trustlens-settings-link"
          onClick={() => browser.runtime.sendMessage({ type: 'trustlens:open-options' }).catch(() => undefined)}
        >
          Settings
        </button>
      </footer>
    </section>
  );
}

function ctaText(isPro: boolean, remainingTrials: number): string {
  if (isPro) return 'Run Pro deep dive';
  if (remainingTrials <= 0) return 'Upgrade to continue';
  return 'Run AI deep dive';
}

function medallionGlyph(grade: TrustGrade): string {
  return grade === 'Insufficient data' ? '–' : grade;
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
    <svg className="trustlens-check-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7.5 12.5l3 3 6-6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg className="trustlens-check-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M12 3.5L21 19H3L12 3.5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M12 9.5v4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="16.5" r="0.9" fill="currentColor" />
    </svg>
  );
}

function DotIcon() {
  return (
    <svg className="trustlens-check-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="3.2" fill="currentColor" />
    </svg>
  );
}
