// entrypoints/popup/App.tsx
//
// Quick-glance popup only: master on/off toggle, plan badge, one-line trial
// summary, and a link into the full Settings page. All BYO-key/provider/
// license management lives in entrypoints/options/Settings.tsx now.

import { useEffect, useState } from 'react';
import { getSettings, saveSettings } from '@/lib/byo-key';
import { checkProStatus } from '@/lib/license';
import { FREE_TRIAL_LIMIT, getRemainingTrials } from '@/lib/usage-limits';
import type { StoredSettings } from '@/lib/types';
import './App.css';

// Deliberately never themed off the user's Appearance setting or the OS —
// same reasoning as TrustPanel. Light-only, always.
function App() {
  const [settings, setSettings] = useState<StoredSettings>({ provider: 'gemini', devProOverride: false, enabled: true, theme: 'light' });
  const [isPro, setIsPro] = useState(false);
  const [remainingTrials, setRemainingTrials] = useState(FREE_TRIAL_LIMIT);

  useEffect(() => {
    async function load() {
      const [storedSettings, license, remaining] = await Promise.all([getSettings(), checkProStatus(), getRemainingTrials()]);
      setSettings(storedSettings);
      setIsPro(license.pro);
      setRemainingTrials(remaining);
    }
    load();
  }, []);

  async function toggleEnabled() {
    const next = !settings.enabled;
    setSettings(await saveSettings({ enabled: next }));
  }

  function openSettings() {
    browser.runtime.openOptionsPage();
  }

  return (
    <main className="popup-shell">
      <header className="popup-header">
        <div className="popup-brand">
          <ShieldIcon className="popup-shield" />
          <p>TrustLens</p>
        </div>
        <span className={isPro ? 'pill pro' : 'pill'}>{isPro ? 'Pro' : 'Free'}</span>
      </header>

      <div className="toggle-row">
        <span className="toggle-label">{settings.enabled ? 'Enabled' : 'Disabled'}</span>
        <label className="switch">
          <input checked={settings.enabled} onChange={toggleEnabled} type="checkbox" />
          <span />
        </label>
      </div>

      <div className="flow-card">
        <div className="flow-step">
          <span className="flow-icon-circle"><ScanIcon /></span>
          <span className="flow-label">Scan</span>
        </div>
        <div className="flow-step">
          <span className="flow-icon-circle"><ScoreIcon /></span>
          <span className="flow-label">Score</span>
        </div>
        <div className="flow-step">
          <span className="flow-icon-circle"><DecideIcon /></span>
          <span className="flow-label">Decide</span>
        </div>
      </div>

      {!isPro ? <p className="trial-summary">{remainingTrials} of {FREE_TRIAL_LIMIT} free AI analyses left</p> : null}

      <button className="primary" onClick={openSettings}>Open Settings</button>
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

// Static, presentational only — Scan / Score / Decide flow icons, Tabler-style outline glyphs.
function ScanIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M20 20l-4.8-4.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ScoreIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M12 3.5l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4-3.9-3.8 5.4-.8 2.4-4.9z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DecideIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 12.3l2.6 2.6 5.4-5.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default App;
