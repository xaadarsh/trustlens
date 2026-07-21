// lib/ai-request.ts
//
// Shared error classification + retry funnel for every outbound call to
// Gemini or OpenAI — the "Test connection" button in Settings/Welcome AND
// the real deep-dive request (lib/deep-analysis.ts) both route through
// this. A non-2xx response or a network failure must never be phrased as
// "your key was rejected" unless the provider actually said so: a 503
// means the provider's own model is overloaded, which happens constantly
// to perfectly valid free-tier keys, and telling users their key is bad
// makes them regenerate a working key and leave a bad review over a
// problem that was never theirs.

export type AIErrorKind = 'key_rejected' | 'rate_limited' | 'overloaded' | 'network' | 'unknown';

export interface ClassifiedAIError {
  kind: AIErrorKind;
  message: string;
  retryable: boolean;
}

export class AIRequestError extends Error {
  readonly kind: AIErrorKind;
  readonly retryable: boolean;

  constructor(classified: ClassifiedAIError) {
    super(classified.message);
    this.name = 'AIRequestError';
    this.kind = classified.kind;
    this.retryable = classified.retryable;
  }
}

const NETWORK_MESSAGE = 'Request timed out. Check your connection and try again.';

// Both providers embed extra detail beyond the raw HTTP status — Gemini's
// JSON body carries a string `status` ("UNAVAILABLE", "PERMISSION_DENIED",
// ...), OpenAI's carries `error.code` ("invalid_api_key", ...) — so this
// reads the numeric status AND the body text together rather than trusting
// either field alone.
export function classifyAIStatus(providerLabel: string, status: number, bodyText: string): ClassifiedAIError {
  const haystack = `${status} ${bodyText}`.toLowerCase();

  if (
    status === 400 || status === 401 || status === 403
    || /api_key_invalid|permission_denied|invalid[_ ]?api[_ ]?key/.test(haystack)
  ) {
    return {
      kind: 'key_rejected',
      retryable: false,
      message: "This key was rejected. Check that it's correct and the API is enabled for it.",
    };
  }
  if (status === 429 || /resource_exhausted|rate[_ ]limit/.test(haystack)) {
    return {
      kind: 'rate_limited',
      retryable: false,
      message: 'Rate limit reached. Wait a moment and try again.',
    };
  }
  if (status === 500 || status === 503 || /unavailable|overloaded/.test(haystack)) {
    return {
      kind: 'overloaded',
      retryable: true,
      message: `${providerLabel} is overloaded right now — this is on their side, not your key. Try again in a few minutes.`,
    };
  }
  return {
    kind: 'unknown',
    retryable: false,
    message: `Couldn't reach ${providerLabel} (${status}). Try again.`,
  };
}

// Anything that never made it to a Response at all — offline, DNS failure,
// an aborted timeout, a CORS/TLS failure. None of these carry a status
// code, so unlike classifyAIStatus this can't (and shouldn't try to)
// distinguish "your key is bad" from "the network is bad" — the fetch
// never got far enough to find out. A stringified status code embedded in
// the error message (some proxies/SDKs do this, e.g. "[503 Service
// Unavailable]") is still honored as a fallback.
export function classifyThrownError(providerLabel: string, error: unknown): ClassifiedAIError {
  if (error instanceof AIRequestError) {
    return { kind: error.kind, message: error.message, retryable: error.retryable };
  }
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  const statusMatch = text.match(/\b([45]\d{2})\b/);
  if (statusMatch) {
    return classifyAIStatus(providerLabel, Number(statusMatch[1]), text);
  }
  return { kind: 'network', retryable: true, message: NETWORK_MESSAGE };
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Runs one fetch attempt and turns anything other than a clean 2xx into an
// AIRequestError classified by the same rules, regardless of which
// provider or which caller (Test button vs. real deep-dive) is asking.
export async function fetchAIResponse(providerLabel: string, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let response: Response;
  try {
    response = await fetchWithTimeout(url, init, timeoutMs);
  } catch (error) {
    throw new AIRequestError(classifyThrownError(providerLabel, error));
  }
  if (!response.ok) {
    const bodyText = await response.clone().text().catch(() => '');
    throw new AIRequestError(classifyAIStatus(providerLabel, response.status, bodyText));
  }
  return response;
}

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 800;

function backoffDelay(attemptNumber: number): number {
  const base = BASE_DELAY_MS * 2 ** (attemptNumber - 1);
  const jitter = base * (Math.random() * 0.4 - 0.2); // +/-20%
  return Math.max(0, Math.round(base + jitter));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Only retries kinds that can plausibly resolve on their own (provider-side
// overload, a network blip) — never a rejected key or a rate limit, since
// those either can't succeed by retrying or actively make quota exhaustion
// worse. Callers are responsible for making sure whatever they do on
// success (e.g. decrementing a trial count) only happens once the whole
// retry loop actually resolves, never per-attempt.
export async function requestWithRetry<T>(attempt: (attemptNumber: number) => Promise<T>): Promise<T> {
  let lastError: AIRequestError | undefined;
  for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber += 1) {
    try {
      return await attempt(attemptNumber);
    } catch (error) {
      const classified = error instanceof AIRequestError
        ? error
        : new AIRequestError({
          kind: 'unknown',
          retryable: false,
          message: error instanceof Error ? error.message : 'Something went wrong.',
        });
      lastError = classified;
      if (!classified.retryable || attemptNumber === MAX_ATTEMPTS) throw classified;
      await sleep(backoffDelay(attemptNumber));
    }
  }
  throw lastError ?? new Error('Request failed.');
}

// Gemini-only: the model actually being called matters as much as the
// status code. GradeLens hardcoded a single model (gemini-3.5-flash) that
// hits capacity-driven 503s far more than the older, more-provisioned
// models a valid free-tier key can already reach fine — this is why "the
// same key works in my other extensions" while GradeLens 503s. Falling back
// to progressively older/more-available models turns a capacity problem
// into a solved one without ever touching the classification rules above:
// a 400/401/403 is still a rejected key on ANY model (checked first,
// against model #1, and treated as conclusive for the whole key rather than
// wasted re-checking against every other model), and only exhausting every
// model's retryable failures produces the final "overloaded" message.
export const GEMINI_MODEL_FALLBACK_CHAIN = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.0-flash'] as const;

// Deliberately NOT "3 retries x N models" (9-15 calls, a potential 90s+
// hang) — each model gets at most `attemptsPerModel` tries (only for
// retryable failures) before moving to the next model with no extra delay,
// so the worst case across the whole chain is models.length *
// attemptsPerModel total calls, bounded and predictable.
export async function requestWithModelFallback<T>(
  models: readonly string[],
  attempt: (modelId: string) => Promise<T>,
  attemptsPerModel = 2,
): Promise<T> {
  let lastError: AIRequestError | undefined;
  for (const modelId of models) {
    for (let attemptNumber = 1; attemptNumber <= attemptsPerModel; attemptNumber += 1) {
      try {
        return await attempt(modelId);
      } catch (error) {
        const classified = error instanceof AIRequestError
          ? error
          : new AIRequestError({
            kind: 'unknown',
            retryable: false,
            message: error instanceof Error ? error.message : 'Something went wrong.',
          });
        lastError = classified;
        // A rejected key or a rate limit is true of every model behind the
        // same key — trying the next model would just spend another call
        // reproducing an identical failure, so stop immediately rather than
        // masking it behind a fallback loop.
        if (!classified.retryable) throw classified;
        if (attemptNumber < attemptsPerModel) await sleep(backoffDelay(attemptNumber));
        // else: this model's attempts are exhausted — fall through to the
        // next model in the outer loop, no extra delay for the model swap.
      }
    }
  }
  throw lastError ?? new Error('All models failed.');
}
