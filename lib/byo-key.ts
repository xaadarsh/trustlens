import type { DeepAnalysisProvider, KeyTestResult, StoredSettings } from './types';

const SETTINGS_KEY = 'trustlens.settings';

const DEFAULT_SETTINGS: StoredSettings = {
  provider: 'gemini',
  devProOverride: false,
  enabled: true,
  theme: 'light',
};

export async function getSettings(): Promise<StoredSettings> {
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

  try {
    if (provider === 'gemini') {
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Reply with OK.' }] }],
          generationConfig: { maxOutputTokens: 8 },
        }),
      });
      return response.ok ? { ok: true, message: 'Gemini key works.' } : { ok: false, message: `Gemini rejected the key (${response.status}).` };
    }

    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return response.ok ? { ok: true, message: 'OpenAI key works.' } : { ok: false, message: `OpenAI rejected the key (${response.status}).` };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Unable to test the key.',
    };
  }
}
