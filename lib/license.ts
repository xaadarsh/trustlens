import type { LicenseStatus } from './types';

const LICENSE_KEY = 'trustlens.license';
const RECHECK_INTERVAL_MS = 1000 * 60 * 60 * 24;
const GUMROAD_PRODUCT_ID = import.meta.env.WXT_GUMROAD_PRODUCT_ID || 'trustlens';

const DEFAULT_STATUS: LicenseStatus = {
  pro: false,
  message: 'Free plan',
};

export async function getCachedLicenseStatus(): Promise<LicenseStatus> {
  const stored = await browser.storage.local.get(LICENSE_KEY);
  return { ...DEFAULT_STATUS, ...(stored[LICENSE_KEY] ?? {}) };
}

export async function saveLicenseKey(licenseKey: string): Promise<LicenseStatus> {
  const current = await getCachedLicenseStatus();
  const next = { ...current, licenseKey: licenseKey.trim() };
  await browser.storage.local.set({ [LICENSE_KEY]: next });
  return verifyLicense(next.licenseKey, true);
}

export async function checkProStatus(force = false): Promise<LicenseStatus> {
  const cached = await getCachedLicenseStatus();
  if (!cached.licenseKey) return cached;
  if (!force && cached.nextCheckAt && cached.nextCheckAt > Date.now()) return cached;
  return verifyLicense(cached.licenseKey, true);
}

export async function setDevProOverride(enabled: boolean): Promise<void> {
  await browser.storage.local.set({
    'trustlens.devProOverride': enabled,
  });
}

export async function getDevProOverride(): Promise<boolean> {
  const stored = await browser.storage.local.get('trustlens.devProOverride');
  return Boolean(stored['trustlens.devProOverride']);
}

async function verifyLicense(licenseKey: string | undefined, persist: boolean): Promise<LicenseStatus> {
  if (!licenseKey) return DEFAULT_STATUS;

  try {
    const body = new URLSearchParams({
      product_id: GUMROAD_PRODUCT_ID,
      license_key: licenseKey,
    });
    const response = await fetch('https://api.gumroad.com/v2/licenses/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const payload = await response.json();
    const pro = Boolean(response.ok && payload.success && !payload.purchase?.refunded && !payload.purchase?.chargebacked);
    const status: LicenseStatus = {
      pro,
      licenseKey,
      checkedAt: Date.now(),
      nextCheckAt: Date.now() + RECHECK_INTERVAL_MS,
      message: pro ? 'Pro license active' : payload.message || 'License was not accepted.',
    };
    if (persist) await browser.storage.local.set({ [LICENSE_KEY]: status });
    return status;
  } catch (error) {
    const fallback: LicenseStatus = {
      pro: false,
      licenseKey,
      checkedAt: Date.now(),
      nextCheckAt: Date.now() + RECHECK_INTERVAL_MS,
      message: error instanceof Error ? error.message : 'License check failed.',
    };
    if (persist) await browser.storage.local.set({ [LICENSE_KEY]: fallback });
    return fallback;
  }
}
