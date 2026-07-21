import { AIRequestError, fetchAIResponse, GEMINI_MODEL_FALLBACK_CHAIN, requestWithModelFallback, requestWithRetry } from './ai-request';
import { ensureStorageMigrated } from './storage-migration';
import type { DeepAnalysisProvider, KeyTestResult, StoredSettings } from './types';

// Short per-attempt timeout for the "Test connection" button specifically —
// it shares the deep-dive's 3-attempt retry funnel (see lib/ai-request.ts),
// but a settings-page button must never spin for anywhere close to the
// deep-dive's 30s-per-attempt budget. 2.5s/attempt keeps the worst case
// (every attempt genuinely hangs) close to the ~10s a user will tolerate a
// button spinning for.
const TEST_TIMEOUT_MS = 2500;

const SETTINGS_KEY = 'gradelens.settings';

const DEFAULT_SETTINGS: StoredSettings = {
  provider: 'gemini',
  enabled: true,
  theme: 'light',
};

export async function getSettings(): Promise<StoredSettings> {
  await ensureStorageMigrated();
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] ?? {}) };
}

export async function saveSettings(settings: Partial<StoredSettings>): Promise<StoredSettings> {
  const next = { ...(await getSettings()), ...settings };
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export function getProviderKey(settings: StoredSettings, provider = settings.provider): string | undefined {
  return provider === 'gemini' ? settings.geminiKey : settings.openaiKey;
}

export function maskApiKey(key?: string): string {
  if (!key) return '';
  if (key.length <= 8) return '********';
  return `${key.slice(0, 4)}********${key.slice(-4)}`;
}

export async function testApiKey(provider: DeepAnalysisProvider, apiKey: string): Promise<KeyTestResult> {
  if (!apiKey.trim()) {
    return { ok: false, message: 'Enter an API key first.' };
  }

  const providerLabel = provider === 'gemini' ? 'Gemini' : 'OpenAI';

  try {
    if (provider === 'gemini') {
      // attemptsPerModel: 1 — the Test button is a quick sanity check, not
      // the full retry depth the deep-dive gets; trying each of the 3
      // fallback models once (no per-model retry) keeps the worst case at
      // 3 * TEST_TIMEOUT_MS with no backoff delays, well inside the ~10s a
      // settings-page button should ever spin for.
      await requestWithModelFallback(GEMINI_MODEL_FALLBACK_CHAIN, (modelId) => fetchAIResponse(
        'Gemini',
        `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'Reply with OK.' }] }],
            generationConfig: { maxOutputTokens: 8 },
          }),
        },
        TEST_TIMEOUT_MS,
      ), 1);
    } else {
      await requestWithRetry(() => fetchAIResponse('OpenAI', 'https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      }, TEST_TIMEOUT_MS));
    }
    return { ok: true, message: `${providerLabel} key works.` };
  } catch (error) {
    const classified = error instanceof AIRequestError
      ? error
      : new AIRequestError({
        kind: 'unknown',
        retryable: false,
        message: error instanceof Error ? error.message : 'Unable to test the key.',
      });
    return { ok: false, message: classified.message };
  }
}

// Clears only the active-key concern (BYO Gemini/OpenAI key), never the
// license. They're stored under entirely separate chrome.storage.local keys
// ('gradelens.settings' here vs. 'gradelens.license' in lib/license.ts) and
// this only ever touches the former — removing a key can never revoke Pro.
export async function clearProviderKey(provider: DeepAnalysisProvider): Promise<StoredSettings> {
  return provider === 'gemini' ? saveSettings({ geminiKey: '' }) : saveSettings({ openaiKey: '' });
}
