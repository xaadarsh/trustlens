import { ensureStorageMigrated } from './storage-migration';
import type { LicenseStatus } from './types';

const LICENSE_KEY = 'gradelens.license';
const RECHECK_INTERVAL_MS = 1000 * 60 * 60 * 24;
const GUMROAD_PRODUCT_ID = 'UUbUxfEn2z_kWSWiTqVMWQ==';

const DEFAULT_STATUS: LicenseStatus = {
  pro: false,
  message: 'Free plan',
};

export async function getCachedLicenseStatus(): Promise<LicenseStatus> {
  await ensureStorageMigrated();
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
  await ensureStorageMigrated();
  await browser.storage.local.set({
    'gradelens.devProOverride': enabled,
  });
}

export async function getDevProOverride(): Promise<boolean> {
  await ensureStorageMigrated();
  const stored = await browser.storage.local.get('gradelens.devProOverride');
  return Boolean(stored['gradelens.devProOverride']);
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
    // Network failure must never demote an already-activated Pro user back to
    // free — retry soon instead of persisting a false "not pro" verdict.
    const previous = await getCachedLicenseStatus();
    const fallback: LicenseStatus = {
      ...previous,
      licenseKey,
      checkedAt: Date.now(),
      nextCheckAt: Date.now() + 1000 * 60 * 15,
      message: previous.pro
        ? 'Could not reach Gumroad to re-verify — staying on Pro until the next check.'
        : 'Could not reach the license server. Check your connection and try again.',
    };
    if (persist) await browser.storage.local.set({ [LICENSE_KEY]: fallback });
    return fallback;
  }
}
