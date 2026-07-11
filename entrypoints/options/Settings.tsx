// entrypoints/options/Settings.tsx
//
// Full-tab Settings page (WXT "options" entrypoint, opens in its own tab via
// options_ui.open_in_tab — see index.html's manifest.open_in_tab meta tag).
// This is the real end-user settings surface: BYO API keys, provider choice,
// license management, appearance, and about info. Reachable via right-click
// extension icon -> Options, or the popup's "Open Settings" button.

import { useEffect, useState } from 'react';
import { getSettings, maskApiKey, saveSettings, testApiKey } from '@/lib/byo-key';
import { checkProStatus, getCachedLicenseStatus, saveLicenseKey } from '@/lib/license';
import { FREE_TRIAL_LIMIT, getRemainingTrials } from '@/lib/usage-limits';
import type { DeepAnalysisProvider, LicenseStatus, StoredSettings, ThemePreference } from '@/lib/types';

const PRIVACY_POLICY_URL = 'https://xaadarsh.com/trustlens/privacy';
const SUPPORT_EMAIL = 'aadarshraj380@gmail.com';

function Settings() {
  const [settings, setSettings] = useState<StoredSettings>({ provider: 'gemini', devProOverride: false, enabled: true, theme: 'light' });
  const [draftGeminiKey, setDraftGeminiKey] = useState('');
  const [draftOpenAIKey, setDraftOpenAIKey] = useState('');
  const [licenseKey, setLicenseKey] = useState('');
  const [license, setLicense] = useState<LicenseStatus>({ pro: false, message: 'Free plan' });
  const [remainingTrials, setRemainingTrials] = useState(FREE_TRIAL_LIMIT);
  const [status, setStatus] = useState('');

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
    load();
  }, []);

  async function updateProvider(provider: DeepAnalysisProvider) {
    setSettings(await saveSettings({ provider }));
  }

  async function updateTheme(theme: ThemePreference) {
    setSettings(await saveSettings({ theme }));
  }

  async function saveKey(provider: DeepAnalysisProvider) {
    const draft = provider === 'gemini' ? draftGeminiKey : draftOpenAIKey;
    if (draft.includes('*')) {
      setStatus('Key is already saved.');
      return;
    }

    const next = provider === 'gemini'
      ? await saveSettings({ geminiKey: draft.trim() })
      : await saveSettings({ openaiKey: draft.trim() });
    setSettings(next);
    setDraftGeminiKey(maskApiKey(next.geminiKey));
    setDraftOpenAIKey(maskApiKey(next.openaiKey));
    setStatus(`${provider === 'gemini' ? 'Gemini' : 'OpenAI'} key saved.`);
  }

  async function testKey(provider: DeepAnalysisProvider) {
    const key = provider === 'gemini'
      ? (draftGeminiKey.includes('*') ? settings.geminiKey : draftGeminiKey)
      : (draftOpenAIKey.includes('*') ? settings.openaiKey : draftOpenAIKey);
    const result = await testApiKey(provider, key ?? '');
    setStatus(result.message);
  }

  async function verifyLicense() {
    const result = await saveLicenseKey(licenseKey);
    setLicense(result);
    setStatus(result.message);
  }

  const trialFillPct = Math.round((remainingTrials / FREE_TRIAL_LIMIT) * 100);

  return (
    <main className="settings-shell" data-theme={settings.theme}>
      <header className="settings-header">
        <div className="settings-brand">
          <ShieldIcon className="settings-shield" />
          <p className="settings-wordmark">TrustLens</p>
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
              <div className="segmented">
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
              <div className="segmented">
                <button className={settings.theme === 'light' ? 'active' : ''} onClick={() => updateTheme('light')}>Light</button>
                <button className={settings.theme === 'dark' ? 'active' : ''} onClick={() => updateTheme('dark')}>Dark</button>
              </div>
            </div>
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
  onSave: () => void;
  onTest: () => void;
}) {
  return (
    <div className="row key-row">
      <label className="key-row-label">
        {props.label}
        <input
          autoComplete="off"
          onFocus={() => {
            if (props.value.includes('*')) props.onChange('');
          }}
          onChange={(event) => props.onChange(event.target.value)}
          placeholder="Paste API key"
          type={props.value.includes('*') ? 'text' : 'password'}
          value={props.value}
        />
      </label>
      <button className="btn-sm btn-primary-sm" onClick={props.onSave} title="Save key">Save</button>
      <button className="btn-sm btn-outline-sm" onClick={props.onTest} title="Test connection">Test</button>
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
