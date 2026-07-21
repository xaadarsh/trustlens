// entrypoints/options/Settings.tsx
//
// Full-tab Settings page (WXT "options" entrypoint, opens in its own tab via
// options_ui.open_in_tab — see index.html's manifest.open_in_tab meta tag).
// This is the real end-user settings surface: BYO API keys, provider choice,
// license management, appearance, and about info. Reachable via right-click
// extension icon -> Options, or the popup's "Open Settings" button.

import { useEffect, useState } from 'react';
import { AIProviderSetup } from '@/components/AIProviderSetup';
import { clearProviderKey, getProviderKey, getSettings, saveSettings } from '@/lib/byo-key';
import { clearHistory } from '@/lib/history';
import { checkProStatus, getCachedLicenseStatus, GUMROAD_CHECKOUT_URL, saveLicenseKey } from '@/lib/license';
import { FREE_TRIAL_LIMIT, getRemainingTrials } from '@/lib/usage-limits';
import type { LicenseStatus, StoredSettings, ThemePreference } from '@/lib/types';

const PRIVACY_POLICY_URL = 'https://xaadarsh.github.io/gradelens-privacy/';
const SUPPORT_EMAIL = 'aadarshraj380@gmail.com';

function Settings() {
  const [settings, setSettings] = useState<StoredSettings>({ provider: 'gemini', enabled: true, theme: 'light' });
  const [licenseKey, setLicenseKey] = useState('');
  const [license, setLicense] = useState<LicenseStatus>({ pro: false, message: 'Free plan' });
  const [remainingTrials, setRemainingTrials] = useState(FREE_TRIAL_LIMIT);
  const [status, setStatus] = useState('');
  const [historyStatus, setHistoryStatus] = useState('');
  const [keyRemovedStatus, setKeyRemovedStatus] = useState('');

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
      setLicense(storedLicense);
      setRemainingTrials(remaining);
      setLicenseKey(storedLicense.licenseKey ?? '');
      checkProStatus().then(setLicense).catch(() => undefined);
    }
    load().catch(() => undefined);
  }, []);

  async function updateTheme(theme: ThemePreference) {
    try {
      setSettings(await saveSettings({ theme }));
    } catch {
      // Storage write failed — leave the previous selection in place rather
      // than throw an unhandled rejection out of a click handler.
    }
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

  // Independent of license state on purpose — this only ever writes the BYO
  // key fields in 'gradelens.settings' (see clearProviderKey), never
  // 'gradelens.license'. Removing a key can't revoke Pro; the two are
  // stored and read from entirely separate places.
  async function handleRemoveKey() {
    try {
      const next = await clearProviderKey(settings.provider);
      setSettings(next);
      setKeyRemovedStatus(`${settings.provider === 'gemini' ? 'Gemini' : 'OpenAI'} key removed.`);
    } catch {
      setKeyRemovedStatus('Could not remove the key — try again.');
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
          <AIProviderSetup settings={settings} onSettingsChange={setSettings} />
        </div>

        {/* License */}
        <div className="settings-section">
          <p className="section-label"><LicenseIcon /> License</p>
          <div className="card">
            {license.pro ? (
              <>
                <div className="row">
                  <span className="row-label">Plan</span>
                  <span className="pill pill-gold">Pro</span>
                </div>
                <div className="divider" />
                <div className="row row-static">
                  <span className="pro-status-text">{license.message}</span>
                </div>
                {getProviderKey(settings) ? (
                  <>
                    <div className="divider" />
                    <div className="row">
                      <span className="row-label">{settings.provider === 'gemini' ? 'Gemini' : 'OpenAI'} key saved</span>
                      <button className="btn-sm btn-outline-sm" onClick={handleRemoveKey}>Remove key</button>
                    </div>
                  </>
                ) : null}
                {/* Rendered outside the getProviderKey check above (not
                    nested inside it) — the moment removal succeeds,
                    getProviderKey(settings) goes falsy and would hide this
                    confirmation in the same render if it were nested there. */}
                {keyRemovedStatus ? <p className="key-row-feedback key-row-feedback--ok">{keyRemovedStatus}</p> : null}
              </>
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
                <div className="divider" />
                <div className="row row-static">
                  <p className="license-upsell">
                    Don't have a key?{' '}
                    <a className="license-upsell-link" href={GUMROAD_CHECKOUT_URL} target="_blank" rel="noopener noreferrer">
                      Get GradeLens Pro — $9 lifetime →
                    </a>
                  </p>
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
