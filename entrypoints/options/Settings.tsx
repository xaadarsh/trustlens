// entrypoints/options/Settings.tsx
//
// Full-tab Settings page (WXT "options" entrypoint, opens in its own tab via
// options_ui.open_in_tab — see index.html's manifest.open_in_tab meta tag).
// This is the real end-user settings surface: BYO API keys, provider choice,
// license management, appearance, and about info. Reachable via right-click
// extension icon -> Options, or the popup's "Open Settings" button.

import { useEffect, useRef, useState } from 'react';
import { getSettings, maskApiKey, saveSettings, testApiKey } from '@/lib/byo-key';
import { clearHistory } from '@/lib/history';
import { checkProStatus, getCachedLicenseStatus, saveLicenseKey } from '@/lib/license';
import { FREE_TRIAL_LIMIT, getRemainingTrials } from '@/lib/usage-limits';
import type { DeepAnalysisProvider, KeyTestResult, LicenseStatus, StoredSettings, ThemePreference } from '@/lib/types';

const PRIVACY_POLICY_URL = 'https://xaadarsh.github.io/gradelens-privacy/';
const SUPPORT_EMAIL = 'aadarshraj380@gmail.com';

function Settings() {
  const [settings, setSettings] = useState<StoredSettings>({ provider: 'gemini', enabled: true, theme: 'light' });
  const [draftGeminiKey, setDraftGeminiKey] = useState('');
  const [draftOpenAIKey, setDraftOpenAIKey] = useState('');
  const [licenseKey, setLicenseKey] = useState('');
  const [license, setLicense] = useState<LicenseStatus>({ pro: false, message: 'Free plan' });
  const [remainingTrials, setRemainingTrials] = useState(FREE_TRIAL_LIMIT);
  const [status, setStatus] = useState('');
  const [historyStatus, setHistoryStatus] = useState('');

  const version = browser.runtime.getManifest().version;

  // Settings is the only surface that can be dark (it's a standalone tab,
  // not rendered over Amazon) — no 'system' resolution needed since that
  // option was removed; the stored preference IS the effective theme.
  // html/body sit outside .settings-shell in the tree, so mirror onto
  // <html> too or Settings.css's page-canvas rule can't see it.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme);
  }, [settings.theme]);

  useEffect(() => {
    async function load() {
      const [storedSettings, storedLicense, remaining] = await Promise.all([getSettings(), getCachedLicenseStatus(), getRemainingTrials()]);
      setSettings(storedSettings);
      setDraftGeminiKey(maskApiKey(storedSettings.geminiKey));
      setDraftOpenAIKey(maskApiKey(storedSettings.openaiKey));
      setLicense(storedLicense);
      setRemainingTrials(remaining);
      setLicenseKey(storedLicense.licenseKey ?? '');
      checkProStatus().then(setLicense).catch(() => undefined);
    }
    load().catch(() => undefined);
  }, []);

  async function updateProvider(provider: DeepAnalysisProvider) {
    try {
      setSettings(await saveSettings({ provider }));
    } catch {
      // Storage write failed — leave the previous selection in place rather
      // than throw an unhandled rejection out of a click handler.
    }
  }

  async function updateTheme(theme: ThemePreference) {
    try {
      setSettings(await saveSettings({ theme }));
    } catch {
      // Same as updateProvider above.
    }
  }

  // Return the outcome instead of pushing it into the page-bottom `status`
  // string — KeyRow shows it inline next to the button that triggered it.
  async function saveKey(provider: DeepAnalysisProvider): Promise<KeyTestResult> {
    const draft = (provider === 'gemini' ? draftGeminiKey : draftOpenAIKey).trim();
    if (draft.includes('*')) {
      return { ok: true, message: 'Key is already saved.' };
    }
    // Guards against wiping an already-saved key: an empty draft here used
    // to come from the field's own onFocus handler clearing the masked
    // display the instant it was clicked (fixed in KeyRow below), and
    // clicking Save right after would have persisted that empty string
    // over the real stored key. Keeping this check even with that fixed —
    // a stray empty Save should never be able to erase a saved key.
    if (!draft) {
      return { ok: false, message: 'Enter an API key first.' };
    }

    const next = provider === 'gemini'
      ? await saveSettings({ geminiKey: draft })
      : await saveSettings({ openaiKey: draft });
    setSettings(next);
    setDraftGeminiKey(maskApiKey(next.geminiKey));
    setDraftOpenAIKey(maskApiKey(next.openaiKey));
    return { ok: true, message: `${provider === 'gemini' ? 'Gemini' : 'OpenAI'} key saved.` };
  }

  async function testKey(provider: DeepAnalysisProvider): Promise<KeyTestResult> {
    const key = provider === 'gemini'
      ? (draftGeminiKey.includes('*') ? settings.geminiKey : draftGeminiKey)
      : (draftOpenAIKey.includes('*') ? settings.openaiKey : draftOpenAIKey);
    return testApiKey(provider, key ?? '');
  }

  async function verifyLicense() {
    try {
      const result = await saveLicenseKey(licenseKey);
      setLicense(result);
      setStatus(result.message);
    } catch {
      setStatus('Could not verify the license key. Check your connection and try again.');
    }
  }

  async function handleClearHistory() {
    try {
      await clearHistory();
      setHistoryStatus('Local grading history cleared.');
    } catch {
      setHistoryStatus('Could not clear history — try again.');
    }
  }

  const trialFillPct = Math.round((remainingTrials / FREE_TRIAL_LIMIT) * 100);

  return (
    <main className="settings-shell" data-theme={settings.theme}>
      <header className="settings-header">
        <div className="settings-brand">
          <ShieldIcon className="settings-shield" />
          <p className="settings-wordmark">GradeLens</p>
        </div>
        <span className={license.pro ? 'pill pro' : 'pill'}>{license.pro ? 'Pro' : 'Free'}</span>
      </header>

      <div className="settings-inner">
        <h1>Settings</h1>

        {/* AI Provider */}
        <div className="settings-section">
          <p className="section-label"><ProviderIcon /> AI Provider</p>
          <div className="card">
            <div className="row">
              <span className="row-label">Deep-dive provider</span>
              <div className="segmented" data-active={settings.provider === 'gemini' ? 0 : 1}>
                <button className={settings.provider === 'gemini' ? 'active' : ''} onClick={() => updateProvider('gemini')}>
                  Gemini
                </button>
                <button className={settings.provider === 'openai' ? 'active' : ''} onClick={() => updateProvider('openai')}>
                  OpenAI
                </button>
              </div>
            </div>
            <div className="divider" />
            {/* Bug fix: only the active provider's key field renders — previously
                both Gemini and OpenAI inputs rendered unconditionally regardless
                of the selected tab, so a user could fill in the wrong key. Keying
                on settings.provider also re-triggers the crossfade animation. */}
            <div className="key-field-wrap" key={settings.provider}>
              {settings.provider === 'gemini' ? (
                <KeyRow
                  label="Gemini API key"
                  value={draftGeminiKey}
                  onChange={setDraftGeminiKey}
                  onSave={() => saveKey('gemini')}
                  onTest={() => testKey('gemini')}
                />
              ) : (
                <KeyRow
                  label="OpenAI API key"
                  value={draftOpenAIKey}
                  onChange={setDraftOpenAIKey}
                  onSave={() => saveKey('openai')}
                  onTest={() => testKey('openai')}
                />
              )}
            </div>
          </div>
        </div>

        {/* License */}
        <div className="settings-section">
          <p className="section-label"><LicenseIcon /> License</p>
          <div className="card">
            {license.pro ? (
              <div className="row">
                <span className="row-label">Plan</span>
                <span className="pro-status-text">{license.message}</span>
              </div>
            ) : (
              <>
                <div className="row">
                  <span className="row-label">Free trial</span>
                  <div className="trial-progress">
                    <div className="trial-track">
                      <div className="trial-fill" style={{ width: `${trialFillPct}%` }} />
                    </div>
                    <span className="trial-count">{remainingTrials}/{FREE_TRIAL_LIMIT}</span>
                  </div>
                </div>
                <div className="divider" />
                <div className="row key-row">
                  <input value={licenseKey} onChange={(event) => setLicenseKey(event.target.value)} placeholder="XXXX-XXXX-XXXX" />
                  <button className="btn-sm btn-primary-sm" onClick={verifyLicense}>Verify</button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Appearance */}
        <div className="settings-section">
          <p className="section-label"><AppearanceIcon /> Appearance</p>
          <div className="card">
            <div className="row">
              <span className="row-label">Theme</span>
              <div className="segmented" data-active={settings.theme === 'light' ? 0 : 1}>
                <button className={settings.theme === 'light' ? 'active' : ''} onClick={() => updateTheme('light')}>Light</button>
                <button className={settings.theme === 'dark' ? 'active' : ''} onClick={() => updateTheme('dark')}>Dark</button>
              </div>
            </div>
          </div>
        </div>

        {/* Privacy */}
        <div className="settings-section">
          <p className="section-label"><PrivacyIcon /> Privacy</p>
          <div className="card">
            <div className="row">
              <span className="row-label">Local grading history</span>
              <button className="btn-sm btn-outline-sm" onClick={handleClearHistory}>Clear history</button>
            </div>
            {historyStatus ? <p className="key-row-feedback key-row-feedback--ok">{historyStatus}</p> : null}
          </div>
        </div>

        {/* About */}
        <div className="settings-section">
          <p className="section-label"><InfoIcon /> About</p>
          <div className="card">
            <div className="row row-static">
              <span className="row-label">Version</span>
              <span className="row-value">{version}</span>
            </div>
            <div className="divider" />
            <a className="row row-link" href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer">
              <span className="row-label">Privacy Policy</span>
              <ChevronIcon />
            </a>
            <div className="divider" />
            <a className="row row-link" href={`mailto:${SUPPORT_EMAIL}`}>
              <span className="row-label">Support</span>
              <ChevronIcon />
            </a>
          </div>
        </div>

        {status ? <p className="status">{status}</p> : null}
      </div>
    </main>
  );
}

function KeyRow(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => Promise<KeyTestResult>;
  onTest: () => Promise<KeyTestResult>;
}) {
  // busyRef is the actual guard: a ref mutates synchronously and is shared
  // across handler invocations regardless of React's render/batching
  // timing, unlike a useState value, which is only updated after a
  // re-render — two click() calls fired back-to-back in the same tick both
  // still read the OLD state value if the guard were state-based, so both
  // would slip past an `if (busy !== 'idle') return` check and fire two
  // concurrent requests with the same key. That's exactly what was tripping
  // Gemini's rate limit and producing inconsistent pass/fail results.
  // `busy` state stays alongside it purely to drive the visible
  // "Saving…"/"Testing…" label and disabled styling.
  const busyRef = useRef(false);
  const [busy, setBusy] = useState<'idle' | 'saving' | 'testing'>('idle');
  const [feedback, setFeedback] = useState<KeyTestResult | null>(null);

  async function run(phase: 'saving' | 'testing', action: () => Promise<KeyTestResult>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(phase);
    setFeedback(null);
    try {
      setFeedback(await action());
    } catch (error) {
      // Without this catch, a throw from action() (e.g. storage.local.set
      // failing) would leave busyRef stuck true forever — Save/Test would
      // be permanently disabled for the rest of the session.
      setFeedback({ ok: false, message: error instanceof Error ? error.message : 'Something went wrong.' });
    } finally {
      busyRef.current = false;
      setBusy('idle');
    }
  }

  return (
    <div className="key-field-block">
      <div className="row key-row">
        <label className="key-row-label">
          {props.label}
          <input
            autoComplete="off"
            onFocus={(event) => {
              // Select-all, don't clear: a plain click/tab into the field
              // was wiping the masked value on focus alone, before any
              // typing — the field looked like the saved key had vanished.
              // Selecting it instead means clicking-away leaves it
              // untouched, while typing still naturally replaces the
              // selected mask with the new key (standard input behavior).
              if (props.value.includes('*')) event.target.select();
            }}
            onChange={(event) => props.onChange(event.target.value)}
            placeholder="Paste API key"
            type={props.value.includes('*') ? 'text' : 'password'}
            value={props.value}
          />
        </label>
        <button
          className="btn-sm btn-primary-sm"
          disabled={busy !== 'idle'}
          onClick={() => run('saving', props.onSave)}
          title="Save key"
        >
          {busy === 'saving' ? 'Saving…' : 'Save'}
        </button>
        <button
          className="btn-sm btn-outline-sm"
          disabled={busy !== 'idle'}
          onClick={() => run('testing', props.onTest)}
          title="Test connection"
        >
          {busy === 'testing' ? 'Testing…' : 'Test'}
        </button>
      </div>
      {feedback ? (
        <p className={`key-row-feedback ${feedback.ok ? 'key-row-feedback--ok' : 'key-row-feedback--error'}`}>
          {feedback.message}
        </p>
      ) : null}
    </div>
  );
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M12 2.5L4.5 5.4v5.7c0 5.2 3.3 9.6 7.5 11 4.2-1.4 7.5-5.8 7.5-11V5.4L12 2.5z" fill="currentColor" />
    </svg>
  );
}

function ProviderIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function LicenseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="8.5" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12.2 8.8L20 8.8M20 8.8v3.2M20 8.8l-3.2 3.2M15.5 8.8l2 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function AppearanceIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function PrivacyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M12 2.5L4.5 5.4v5.7c0 5.2 3.3 9.6 7.5 11 4.2-1.4 7.5-5.8 7.5-11V5.4L12 2.5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8.7 12.3l2.2 2.2 4.4-4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 11v5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="7.8" r="0.9" fill="currentColor" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg className="chevron" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M9 5.5l6.5 6.5-6.5 6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default Settings;
