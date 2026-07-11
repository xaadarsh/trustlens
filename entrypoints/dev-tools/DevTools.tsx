// entrypoints/dev-tools/DevTools.tsx
//
// Dev-only controls (Reset trial counter, Local dev Pro override), physically
// separated out of the production popup/settings surfaces. This entrypoint is
// an "unlisted-page" (folder deliberately named "dev-tools", not "devtools" —
// WXT reserves "devtools.html"/"devtools/index.html" for Chrome's real
// devtools_page manifest feature, which is a different thing entirely), so
// it is never referenced in manifest.json, and it's excluded from production
// builds via wxt.config.ts's filterEntrypoints. main.tsx also throws unless
// import.meta.env.DEV, as a second layer of defense.

import { useEffect, useState } from 'react';
import { getSettings, saveSettings } from '@/lib/byo-key';
import { FREE_TRIAL_LIMIT, getRemainingTrials, resetUsageForDev } from '@/lib/usage-limits';

function DevTools() {
  const [devProOverride, setDevProOverride] = useState(false);
  const [remainingTrials, setRemainingTrials] = useState(FREE_TRIAL_LIMIT);

  useEffect(() => {
    async function load() {
      const [settings, remaining] = await Promise.all([getSettings(), getRemainingTrials()]);
      setDevProOverride(settings.devProOverride);
      setRemainingTrials(remaining);
    }
    load();
  }, []);

  async function updateDevProOverride(next: boolean) {
    setDevProOverride(next);
    await saveSettings({ devProOverride: next });
  }

  async function resetTrialCounter() {
    await resetUsageForDev();
    setRemainingTrials(await getRemainingTrials());
  }

  return (
    <main className="dev-tools-shell">
      <div className="dev-tools-inner">
        <h1>TrustLens Dev Tools</h1>
        <p className="dev-tools-note">
          Never referenced in manifest.json (unlisted page) and excluded from production builds via
          filterEntrypoints — reachable only by loading this page's path directly during development.
        </p>

        <section className="section toggle-row">
          <div>
            <h2>Local dev Pro</h2>
            <p>Use this only while testing Pro UI flows locally.</p>
          </div>
          <label className="switch">
            <input checked={devProOverride} onChange={(event) => updateDevProOverride(event.target.checked)} type="checkbox" />
            <span />
          </label>
        </section>

        <section className="section">
          <h2>Free trial usage</h2>
          <div className="trial-meter">
            <span>{remainingTrials} of {FREE_TRIAL_LIMIT} free AI analyses left</span>
            <button onClick={resetTrialCounter}>Reset counter</button>
          </div>
        </section>
      </div>
    </main>
  );
}

export default DevTools;
