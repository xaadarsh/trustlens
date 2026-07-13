import { ensureStorageMigrated } from './storage-migration';
import type { LicenseStatus } from './types';

const LICENSE_KEY = 'gradelens.license';
const RECHECK_INTERVAL_MS = 1000 * 60 * 60 * 24;
const GUMROAD_PRODUCT_ID = 'UUbUxfEn2z_kWSWiTqVMWQ==';

const DEFAULT_STATUS: LicenseStatus = {
  pro: false,
  message: 'Free plan',
};

interface GumroadVerifyResponse {
  success?: boolean;
  message?: string;
  purchase?: {
    refunded?: boolean;
    chargebacked?: boolean;
  };
}

// Tamper resistance (hardening pass): the stored record is signed with this
// HMAC key and re-verified on every read, so "open DevTools and run
// chrome.storage.local.set({'gradelens.license': {pro: true}})" — a one-line
// bypass a bare stored boolean has no defense against — no longer works;
// an edited record without a matching signature is treated as untouched.
//
// Be clear about what this does NOT do: there is no server of ours holding
// this key, so it ships inside this same bundle and can be extracted by
// anyone willing to unpack the extension and read this constant. This is
// not, and cannot be, unbypassable — client-side licensing never can be.
// What it does is raise the bar from "one console command anyone can find
// by searching" to "reverse-engineer the bundle and reimplement the signing
// scheme," which is enough to stop casual/curious bypass without pretending
// otherwise.
const SIGNING_SECRET = 'gradelens-license-v1-9f2b6a1d4e8c3f70b5d9a2e6c1f4b8d3';

interface SignedLicenseRecord {
  pro: boolean;
  licenseKey?: string;
  checkedAt?: number;
  nextCheckAt?: number;
  message: string;
  signature?: string;
}

async function hmacSign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SIGNING_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Only the fields that actually determine access are signed — message text
// is free to change (e.g. localized later) without invalidating old records.
function canonicalPayload(record: Pick<SignedLicenseRecord, 'pro' | 'licenseKey' | 'checkedAt'>): string {
  return `${record.pro}|${record.licenseKey ?? ''}|${record.checkedAt ?? ''}`;
}

async function signRecord(record: Omit<SignedLicenseRecord, 'signature'>): Promise<SignedLicenseRecord> {
  return { ...record, signature: await hmacSign(canonicalPayload(record)) };
}

// Re-derives Pro status from the signed record instead of trusting a bare
// stored `pro` boolean: recomputes the HMAC over the stored pro/licenseKey/
// checkedAt fields and only honors pro:true when it matches the stored
// signature. An unsigned or mismatched record — including GradeLens's own
// pre-hardening records from before this signing scheme existed — is
// treated as free rather than trusted as-is.
async function verifyRecordIntegrity(record: SignedLicenseRecord | undefined): Promise<LicenseStatus> {
  if (!record) return DEFAULT_STATUS;
  if (!record.signature) return { ...DEFAULT_STATUS, licenseKey: record.licenseKey };

  const expected = await hmacSign(canonicalPayload(record));
  if (expected !== record.signature) {
    return { ...DEFAULT_STATUS, licenseKey: record.licenseKey, message: 'License record could not be verified — please re-enter your license key.' };
  }

  const { signature: _signature, ...status } = record;
  return status;
}

async function persistStatus(status: Omit<SignedLicenseRecord, 'signature'>): Promise<LicenseStatus> {
  const signed = await signRecord(status);
  await browser.storage.local.set({ [LICENSE_KEY]: signed });
  const { signature: _signature, ...publicStatus } = signed;
  return publicStatus;
}

export async function getCachedLicenseStatus(): Promise<LicenseStatus> {
  await ensureStorageMigrated();
  const stored = await browser.storage.local.get(LICENSE_KEY);
  return verifyRecordIntegrity(stored[LICENSE_KEY] as SignedLicenseRecord | undefined);
}

export async function saveLicenseKey(licenseKey: string): Promise<LicenseStatus> {
  const current = await getCachedLicenseStatus();
  const next = { ...current, licenseKey: licenseKey.trim() };
  await persistStatus(next);
  return verifyLicense(next.licenseKey, true);
}

// Periodic re-verification only — checkProStatus is read on every panel
// mount/deep-dive, but nextCheckAt (24h) means that's a cheap cached-record
// read, not a network call, on all but the first check of the day.
export async function checkProStatus(force = false): Promise<LicenseStatus> {
  const cached = await getCachedLicenseStatus();
  if (!cached.licenseKey) return cached;
  if (!force && cached.nextCheckAt && cached.nextCheckAt > Date.now()) return cached;
  return verifyLicense(cached.licenseKey, true);
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
    const payload = (await response.json()) as GumroadVerifyResponse;
    const pro = Boolean(response.ok && payload.success && !payload.purchase?.refunded && !payload.purchase?.chargebacked);
    const status: Omit<SignedLicenseRecord, 'signature'> = {
      pro,
      licenseKey,
      checkedAt: Date.now(),
      nextCheckAt: Date.now() + RECHECK_INTERVAL_MS,
      message: pro ? 'Pro license active' : payload.message || 'License was not accepted.',
    };
    return persist ? await persistStatus(status) : (await signRecord(status));
  } catch (error) {
    // Network failure must never demote an already-activated Pro user back to
    // free — retry soon instead of persisting a false "not pro" verdict.
    const previous = await getCachedLicenseStatus();
    const fallback: Omit<SignedLicenseRecord, 'signature'> = {
      pro: previous.pro,
      licenseKey,
      checkedAt: Date.now(),
      nextCheckAt: Date.now() + 1000 * 60 * 15,
      message: previous.pro
        ? 'Could not reach Gumroad to re-verify — staying on Pro until the next check.'
        : 'Could not reach the license server. Check your connection and try again.',
    };
    return persist ? await persistStatus(fallback) : (await signRecord(fallback));
  }
}
