// verify-maximal-animation.mjs — verifies the maximal animation pass across
// all 3 surfaces: popup entrance stagger + micro-interactions, settings
// entrance + sliding tab indicator + focus ring + button punch, and the
// TrustPanel medallion's continuous idle loop (glow-pulse + shimmer).
// Real Brave, computed-style evidence + screenshots, plus a reduced-motion
// instant-static pass for each surface.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-maximal-anim-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';
const PRODUCT_URL = process.env.TL_VERIFY_URL || 'https://www.amazon.in/dp/B08RQJKF6D';

async function clickThroughInterstitial(page) {
  const continueBtn = page.locator('button:has-text("Continue shopping"), input[value="Continue shopping"]');
  if ((await continueBtn.count()) > 0) {
    await continueBtn.first().click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
}

async function main() {
  console.log('=== Building extension ===');
  execSync('npm run build', { stdio: 'inherit', cwd: __dirname });
  fs.mkdirSync(VERIFICATION_DIR, { recursive: true });
  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: BRAVE_PATH,
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  const extensionId = sw ? new URL(sw.url()).hostname : null;

  const report = {};

  try {
    // ============ POPUP: entrance stagger ============
    console.log('\n=== POPUP entrance stagger ===');
    const popupPage = await context.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    const t0 = Date.now();
    const popupCheckpoints = [0, 40, 80, 120, 160, 200, 260, 340, 450];
    report.popupEntrance = [];
    for (const target of popupCheckpoints) {
      const wait = Math.max(0, target - (Date.now() - t0));
      if (wait > 0) await popupPage.waitForTimeout(wait);
      const state = await popupPage.evaluate(() => {
        const els = {
          header: document.querySelector('.popup-header'),
          toggle: document.querySelector('.toggle-row'),
          flow: document.querySelector('.flow-card'),
          trial: document.querySelector('.trial-summary'),
          button: document.querySelector('button.primary'),
        };
        const out = {};
        for (const [k, el] of Object.entries(els)) {
          if (!el) { out[k] = null; continue; }
          const cs = getComputedStyle(el);
          out[k] = { opacity: cs.opacity, transform: cs.transform };
        }
        return out;
      });
      report.popupEntrance.push({ t: Date.now() - t0, ...state });
      console.log(`t=${String(Date.now() - t0).padStart(4)}ms  header.op=${state.header?.opacity} toggle.op=${state.toggle?.opacity} flow.op=${state.flow?.opacity} button.op=${state.button?.opacity}`);
    }
    await popupPage.screenshot({ path: path.join(VERIFICATION_DIR, 'ma-popup-settled.png') });

    // Micro-interactions: toggle press, button hover+press, flow icon hover
    console.log('\n=== POPUP micro-interactions ===');
    const toggleKnobBefore = await popupPage.evaluate(() => getComputedStyle(document.querySelector('.switch span::after') ?? document.body).transform);
    await popupPage.locator('.switch').click();
    await popupPage.waitForTimeout(350);
    const toggleKnobAfter = await popupPage.evaluate(() => {
      const track = document.querySelector('.switch span');
      return { trackBg: getComputedStyle(track).backgroundColor, checked: document.querySelector('.switch input').checked };
    });
    console.log('Toggle after click:', toggleKnobAfter);
    await popupPage.screenshot({ path: path.join(VERIFICATION_DIR, 'ma-popup-toggle-on.png') });

    const flowStep = popupPage.locator('.flow-step').first();
    await flowStep.hover();
    await popupPage.waitForTimeout(200);
    const flowHoverState = await popupPage.evaluate(() => {
      const el = document.querySelector('.flow-icon-circle');
      const cs = getComputedStyle(el);
      return { background: cs.backgroundColor, transform: cs.transform };
    });
    console.log('Flow icon hover state:', flowHoverState);
    await popupPage.screenshot({ path: path.join(VERIFICATION_DIR, 'ma-popup-flow-hover.png') });

    const primaryBtn = popupPage.locator('button.primary');
    await primaryBtn.hover();
    await popupPage.waitForTimeout(150);
    const btnHoverTransform = await popupPage.evaluate(() => getComputedStyle(document.querySelector('button.primary')).transform);
    console.log('Primary button hover transform:', btnHoverTransform);

    // Reduced motion pass
    const popupReducedPage = await context.newPage();
    await popupReducedPage.emulateMedia({ reducedMotion: 'reduce' });
    await popupReducedPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await popupReducedPage.waitForTimeout(60);
    const popupReducedState = await popupReducedPage.evaluate(() => {
      const header = document.querySelector('.popup-header');
      const button = document.querySelector('button.primary');
      return {
        headerOpacity: getComputedStyle(header).opacity,
        headerTransform: getComputedStyle(header).transform,
        buttonOpacity: getComputedStyle(button).opacity,
      };
    });
    console.log('Popup reduced-motion (t=60ms):', popupReducedState);
    report.popupReducedMotion = popupReducedState;
    await popupPage.close();
    await popupReducedPage.close();

    // ============ SETTINGS: entrance, sliding indicator, focus ring, button punch ============
    console.log('\n=== SETTINGS entrance + sliding indicator ===');
    const settingsPage = await context.newPage();
    await settingsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
    const st0 = Date.now();
    const settingsCheckpoints = [0, 60, 120, 180, 260, 400, 600];
    report.settingsEntrance = [];
    for (const target of settingsCheckpoints) {
      const wait = Math.max(0, target - (Date.now() - st0));
      if (wait > 0) await settingsPage.waitForTimeout(wait);
      const state = await settingsPage.evaluate(() => {
        const sections = [...document.querySelectorAll('.settings-section')];
        return sections.map((s) => {
          const cs = getComputedStyle(s);
          return { opacity: cs.opacity, transform: cs.transform };
        });
      });
      report.settingsEntrance.push({ t: Date.now() - st0, sections: state });
      console.log(`t=${String(Date.now() - st0).padStart(4)}ms  sections.opacity=${state.map((s) => s.opacity.slice(0, 4)).join(',')}`);
    }
    await settingsPage.screenshot({ path: path.join(VERIFICATION_DIR, 'ma-settings-settled.png') });

    // Sliding indicator: check ::before transform before/after switching provider tab
    const indicatorBefore = await settingsPage.evaluate(() => {
      const seg = document.querySelectorAll('.segmented')[0];
      return { dataActive: seg.getAttribute('data-active'), before: getComputedStyle(seg, '::before').transform };
    });
    await settingsPage.locator('.segmented button:has-text("OpenAI")').click();
    await settingsPage.waitForTimeout(400);
    const indicatorAfter = await settingsPage.evaluate(() => {
      const seg = document.querySelectorAll('.segmented')[0];
      return { dataActive: seg.getAttribute('data-active'), before: getComputedStyle(seg, '::before').transform };
    });
    console.log('Provider indicator BEFORE switch:', indicatorBefore);
    console.log('Provider indicator AFTER switch:', indicatorAfter);
    report.slidingIndicator = { before: indicatorBefore, after: indicatorAfter };
    await settingsPage.screenshot({ path: path.join(VERIFICATION_DIR, 'ma-settings-openai-tab.png') });

    // Focus ring on input
    await settingsPage.locator('input[placeholder="Paste API key"]').first().focus();
    await settingsPage.waitForTimeout(200);
    const focusRing = await settingsPage.evaluate(() => {
      const input = document.querySelector('input[placeholder="Paste API key"]');
      const cs = getComputedStyle(input);
      return { boxShadow: cs.boxShadow, borderColor: cs.borderColor };
    });
    console.log('Input focus ring:', focusRing);
    report.focusRing = focusRing;
    await settingsPage.screenshot({ path: path.join(VERIFICATION_DIR, 'ma-settings-input-focus.png') });

    // Reduced motion pass for settings
    const settingsReducedPage = await context.newPage();
    await settingsReducedPage.emulateMedia({ reducedMotion: 'reduce' });
    await settingsReducedPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
    await settingsReducedPage.waitForTimeout(60);
    const settingsReducedState = await settingsReducedPage.evaluate(() => {
      const sections = [...document.querySelectorAll('.settings-section')];
      return sections.map((s) => getComputedStyle(s).opacity);
    });
    console.log('Settings reduced-motion (t=60ms) section opacities:', settingsReducedState);
    report.settingsReducedMotion = settingsReducedState;
    await settingsPage.close();
    await settingsReducedPage.close();

    // ============ TRUSTPANEL: continuous idle loop ============
    console.log('\n=== TRUSTPANEL medallion continuous idle loop ===');
    const amazonPage = await context.newPage();
    await amazonPage.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await clickThroughInterstitial(amazonPage);
    const panel = amazonPage.locator('#trustlens-root .trustlens-panel');
    await panel.waitFor({ state: 'visible', timeout: 20000 });
    await panel.scrollIntoViewIfNeeded();

    // Wait past the full 4-act reveal (roughly 250+35+240+100+550+750+300 ~ 2200ms worst case) before sampling idle.
    await amazonPage.waitForTimeout(2500);
    const idleCheckpoints = [0, 700, 1400, 2100, 2800, 3500, 4200, 4900, 5600, 6300, 7000, 8000];
    report.medallionIdle = [];
    const it0 = Date.now();
    for (const target of idleCheckpoints) {
      const wait = Math.max(0, target - (Date.now() - it0));
      if (wait > 0) await amazonPage.waitForTimeout(wait);
      const state = await amazonPage.evaluate(() => {
        const m = document.querySelector('.trustlens-medallion');
        const cs = getComputedStyle(m);
        const beforeCs = getComputedStyle(m, '::before');
        return {
          phase: m.getAttribute('data-medallion-phase'),
          transform: cs.transform,
          boxShadow: cs.boxShadow !== 'none' ? 'GLOW' : 'none',
          shimmerOpacity: beforeCs.opacity,
          shimmerTransform: beforeCs.transform,
        };
      });
      report.medallionIdle.push({ t: Date.now() - it0, ...state });
      console.log(`t=${String(Date.now() - it0).padStart(4)}ms  phase=${state.phase}  transform=${state.transform}  boxShadow=${state.boxShadow}  shimmer.opacity=${state.shimmerOpacity} shimmer.transform=${state.shimmerTransform}`);
    }
    await panel.screenshot({ path: path.join(VERIFICATION_DIR, 'ma-panel-idle-loop.png') });

    // Reduced motion pass for panel
    const panelReducedPage = await context.newPage();
    await panelReducedPage.emulateMedia({ reducedMotion: 'reduce' });
    await panelReducedPage.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await clickThroughInterstitial(panelReducedPage);
    const reducedPanel = panelReducedPage.locator('#trustlens-root .trustlens-panel');
    await reducedPanel.waitFor({ state: 'visible', timeout: 20000 });
    await panelReducedPage.waitForTimeout(80);
    const panelReducedState = await panelReducedPage.evaluate(() => {
      const m = document.querySelector('.trustlens-medallion');
      const letter = document.querySelector('.trustlens-medallion-letter');
      return {
        phase: m.getAttribute('data-medallion-phase'),
        opacity: getComputedStyle(m).opacity,
        transform: getComputedStyle(m).transform,
        letterText: letter.textContent,
        letterOpacity: getComputedStyle(letter).opacity,
      };
    });
    console.log('TrustPanel reduced-motion (t=80ms):', panelReducedState);
    report.panelReducedMotion = panelReducedState;

    await amazonPage.close();
    await panelReducedPage.close();
  } finally {
    await context.close();
  }

  fs.writeFileSync(path.join(VERIFICATION_DIR, 'maximal-animation-report.json'), JSON.stringify(report, null, 2));

  // Summary checks
  console.log('\n=== SUMMARY ===');
  const idleTransforms = new Set(report.medallionIdle.map((s) => s.transform));
  console.log('Distinct medallion transforms during idle window:', idleTransforms.size, '(>1 means it is actually moving, not static)');
  const shimmerOpacities = new Set(report.medallionIdle.map((s) => s.shimmerOpacity));
  console.log('Distinct shimmer opacities observed:', [...shimmerOpacities]);
  const glowSeen = report.medallionIdle.some((s) => s.boxShadow === 'GLOW');
  console.log('Idle glow-pulse observed at least once:', glowSeen);
  console.log('\nReport written to verification/maximal-animation-report.json');
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
