import { fetchAIResponse, GEMINI_MODEL_FALLBACK_CHAIN, requestWithModelFallback, requestWithRetry } from './ai-request';
import type { DeepAnalysisProvider, ScrapedAmazonPage, StatisticalAnalysis } from './types';

const SYSTEM_PROMPT = `You are GradeLens, a review-authenticity assistant. Your job is spotting PATTERNS IN THE REVIEWS THEMSELVES — signs of genuine vs. manipulated feedback — not reviewing the product. Do not accuse a seller, reviewer, brand, product, or review of fraud. Do not claim proof.

CRITICAL RULE — confidence is not yours to call: GradeLens's statistical engine already computes and displays a High/Moderate/Low confidence rating elsewhere on the same screen. You must NEVER state, imply, or hedge about confidence, certainty, or sample size in your own words. Do not write "moderate confidence", "high confidence", "low confidence", "limited signal", "limited data", "small sample", "not enough reviews to be sure", or anything similar — in the verdict line OR in any bullet. If two different confidence claims appear on the same card, that's a contradiction the shopper will notice and distrust. Report FINDINGS only; leave confidence entirely to the engine.

Output a "quick verdict card", never an essay:
Line 1: one short sentence, MAXIMUM 10 WORDS — the bottom-line finding, nothing else, no confidence language. Plain text, no emphasis markers.
Then 3-5 bullet lines (never more than 5), each its own line, each ONE line only — max about 12-15 words, never a paragraph, never wrapping.
Each bullet starts with exactly one symbol for its sentiment: ✅ positive/reassuring, ⚠️ caution/concern, 🔍 neutral observation, ⭐ standout point.
Lead each bullet with the key word or finding first — no filler like "It appears that" or "One thing to note is".
Bullets are about REVIEW AUTHENTICITY, not product quality: patterns across the reviews (timing clusters, repeated phrasing, verified-purchase mix, rating-shape anomalies, price-vs-review-count sanity), red flags, and what a skeptical shopper should specifically check. At most ONE bullet may comment on product sentiment (what reviewers liked/disliked about the product itself) — the rest must be about the reviews' own trustworthiness patterns.
Within each bullet, wrap only the single most essential 1-3 word phrase — the key finding — in **double asterisks**. Exactly one such span per bullet, kept SHORT (1-3 words, never a whole clause), never the whole sentence, never zero.
That double-asterisk span is the ONLY formatting allowed anywhere in the response — no *italics*, no # headers, no - or * list dashes, no backticks.`;

interface DeepAnalysisInput {
  provider: DeepAnalysisProvider;
  apiKey: string;
  page: ScrapedAmazonPage;
  statistical: StatisticalAnalysis;
}

export async function runDeepAnalysis(input: DeepAnalysisInput): Promise<string> {
  const prompt = buildPrompt(input.page, input.statistical);
  return input.provider === 'gemini'
    ? runGemini(input.apiKey, prompt)
    : runOpenAI(input.apiKey, prompt);
}

// A hung request must never leave the panel stuck on "Running deep dive…"
// forever with the button disabled — a slow/dead network or a provider
// stall would otherwise do exactly that (plain fetch has no timeout).
// fetchAIResponse (lib/ai-request.ts) turns a timeout/abort into a clean,
// friendly, retryable error the deep-dive handler shows. Retries happen
// entirely inside runGemini/runOpenAI below and TrustPanel only calls
// incrementUsage() *after* runDeepAnalysis resolves — so neither a timeout
// nor an exhausted retry loop ever burns a free-trial analysis, and a
// mid-retry success only burns one even though multiple attempts fired.
const DEEP_DIVE_TIMEOUT_MS = 30000;

function buildPrompt(page: ScrapedAmazonPage, statistical: StatisticalAnalysis): string {
  const reviewLines = page.reviews.slice(0, 12).map((review, index) => {
    return `${index + 1}. ${review.rating ?? 'n/a'} stars | verified=${review.verified} | vine=${review.vine} | date=${review.date ?? 'unknown'} | ${review.title} ${review.body}`.slice(0, 900);
  });

  return [
    `Product: ${page.title}`,
    `ASIN: ${page.asin ?? 'unknown'}`,
    `Average rating: ${page.averageRating ?? 'unknown'}`,
    `Total reviews: ${page.totalReviewCount ?? 'unknown'}`,
    `Product first available: ${page.productFirstAvailable ?? 'unknown'}`,
    `Statistical grade: ${statistical.grade}`,
    `Rule checks: ${statistical.checks.map((check) => `${check.label}: ${check.status} (${check.detail})`).join(' ')}`,
    'Visible review sample:',
    reviewLines.join('\n'),
    [
      'Write the deep dive as a quick verdict card, exactly this shape:',
      'Line 1: one bottom-line finding, MAXIMUM 10 WORDS, no confidence/certainty language, no emphasis markers.',
      'Then 3-5 bullets, one short line each (max ~12-15 words), each starting with ✅, ⚠️, 🔍, or ⭐ based on sentiment. Lead with the key word. No paragraphs.',
      'Focus on REVIEW AUTHENTICITY (timing patterns, repeated phrasing, verified-purchase mix, rating-shape anomalies, price-vs-review-count sanity, red flags to check) — not product opinions. At most ONE bullet may be about product sentiment.',
      'Never mention confidence, certainty, or sample size in your own words (no "moderate/high/low confidence", no "limited data", no "small sample") — that is shown elsewhere on screen and is not yours to state.',
      'Within each bullet, wrap only the one key 1-3 word phrase in **double asterisks** — exactly one short span per bullet. No other markdown symbols anywhere (no *italics*, no #, no - list dashes, no backticks).',
      '',
      'Example of the target shape (do not reuse this content — match the format only):',
      'Reviews show a natural pattern with minor cautions.',
      '✅ **Verified purchases** dominate the sample, not incentivized',
      '⚠️ A cluster of reviews **posted the same week** — worth a look',
      '🔍 Similar phrasing appears across a **few reviews**',
      '⭐ Rating shape declines naturally, no artificial spike',
    ].join('\n'),
  ].join('\n\n');
}

interface GeminiResponse {
  candidates?: {
    finishReason?: string;
    content?: {
      parts?: { text?: string }[];
    };
  }[];
  usageMetadata?: unknown;
}

interface OpenAIResponse {
  status?: string;
  incomplete_details?: unknown;
  output_text?: string;
  output?: {
    content?: { text?: string }[];
  }[];
}

// thinkingConfig.thinkingLevel is only confirmed valid against
// gemini-3.5-flash (see the truncation-fix comment this was verified
// against) — the older fallback models use a different thinking-budget
// shape or none at all, so sending this field to a model it was never
// tested against risks trading a 503 for an unnecessary 400. Only the
// first/primary model gets it; fallback models get the plain config.
function geminiGenerationConfig(modelId: string): Record<string, unknown> {
  const base = { maxOutputTokens: 1536, temperature: 0.2 };
  if (modelId !== GEMINI_MODEL_FALLBACK_CHAIN[0]) return base;
  return { ...base, thinkingConfig: { thinkingLevel: 'low' } };
}

async function runGemini(apiKey: string, prompt: string): Promise<string> {
  const response = await requestWithModelFallback(GEMINI_MODEL_FALLBACK_CHAIN, (modelId) => fetchAIResponse(
    'Gemini',
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: geminiGenerationConfig(modelId),
      }),
    },
    DEEP_DIVE_TIMEOUT_MS,
  ));
  const payload = (await response.json()) as GeminiResponse;

  const candidate = payload.candidates?.[0];
  if (candidate?.finishReason === 'MAX_TOKENS') {
    console.warn('[GradeLens] Gemini deep-dive response hit MAX_TOKENS and was truncated.', payload.usageMetadata);
  }

  const text = candidate?.content?.parts?.map((part) => part.text).join('').trim();
  return cleanDeepDiveText(text) || 'No deep-dive text returned.';
}

async function runOpenAI(apiKey: string, prompt: string): Promise<string> {
  const response = await requestWithRetry(() => fetchAIResponse(
    'OpenAI',
    'https://api.openai.com/v1/responses',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-5-mini',
        instructions: SYSTEM_PROMPT,
        input: prompt,
        // Explicit "minimal" rather than relying on the model's default —
        // reasoning tokens count against max_output_tokens on GPT-5-series
        // models the same way Gemini's thinking tokens do, so an unset
        // default is one config change away from the same truncation bug.
        reasoning: { effort: 'minimal' },
        max_output_tokens: 1536,
      }),
    },
    DEEP_DIVE_TIMEOUT_MS,
  ));
  const payload = (await response.json()) as OpenAIResponse;

  if (payload.status === 'incomplete') {
    console.warn('[GradeLens] OpenAI deep-dive response was incomplete.', payload.incomplete_details);
  }

  const text = payload.output_text
    || payload.output?.flatMap((item) => item.content ?? []).map((content) => content.text).join('').trim();
  return cleanDeepDiveText(text) || 'No deep-dive text returned.';
}

// Single funnel both providers' raw text passes through: strip markdown
// formatting, then strip any confidence/certainty language the model
// emitted despite the prompt forbidding it (item 1, CRITICAL) — the
// statistical engine owns the confidence claim shown elsewhere on the same
// card, and two disagreeing authorities on one screen is worse than a
// slightly awkward sentence with the offending phrase removed.
function cleanDeepDiveText(text: string | undefined): string {
  return stripConfidenceLanguage(stripMarkdown(text));
}

// Defense-in-depth backstop for the CRITICAL prompt rule above: LLMs don't
// reliably follow negative instructions ("never say X") under all sampling
// conditions, so this removes the specific banned phrases outright rather
// than trying to rewrite around them — a plain-looking sentence with the
// confidence clause quietly gone is far safer than shipping a second,
// contradicting confidence claim next to the engine's own chip.
const CONFIDENCE_LANGUAGE_RE =
  /\b(high|moderate|medium|low)[- ](?:confidence|certainty)\b|\bconfidence\s+(?:is|level|score|rating)\b|\blimited\s+signal\b|\b(?:small|limited|thin|tiny|not\s+enough)\s+(?:sample(?:\s+size)?|review\s+base|data\s*(?:set)?)\b|\bnot\s+(?:enough|much)\s+data\b/gi;

function stripConfidenceLanguage(text: string): string {
  if (!text) return '';
  return text
    .replace(CONFIDENCE_LANGUAGE_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/^\s*[,;:]\s*/gm, '')
    .trim();
}

// Defense-in-depth: the prompt asks for exactly one **emphasis** span per
// bullet and nothing else, but LLMs don't reliably follow markdown
// constraints, and a response cut off mid-token can leave stray/unpaired
// markers with no closing match for the paired stripping passes to catch —
// so a final unconditional sweep removes anything markdown-ish still
// standing. The one exception is well-formed **pairs**, which TrustPanel
// renders as styled emphasis spans (see renderDeepDiveBody) — those are
// protected here with placeholder tokens so the later stripping passes
// (single *italic*/_italic_, stray leftover *, etc.) can't eat into them.
function stripMarkdown(text: string | undefined): string {
  if (!text) return '';

  const protectedSpans: string[] = [];
  // No whitespace and none of *, _, #, ` in the token — whitespace padding
  // would get collapsed asymmetrically by the trailing whitespace-collapse
  // pass (losing the original spacing around a restored span), and any of
  // those punctuation chars would just get eaten by the stripping passes
  // below, placeholder included.
  const PLACEHOLDER = (i: number) => `@@EMPH${i}@@`;

  let working = text.replace(/\*\*(.+?)\*\*/gs, (_match, inner: string) => {
    const token = PLACEHOLDER(protectedSpans.length);
    protectedSpans.push(inner);
    return token;
  });

  working = working
    .replace(/__(.*?)__/gs, '$1')
    .replace(/(\*|_)(.*?)\1/gs, '$2')
    .replace(/^#{1,6}\s+/gm, '')
    // Stray list-marker habits (numbered "1. " or dash/dot bullets) the
    // model might still lead a line with instead of/before the sentiment
    // emoji the prompt asks for — emoji themselves (✅ ⚠️ 🔍 ⭐) are
    // untouched by any pass here, only ASCII markdown punctuation is.
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/[*_#`]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return working.replace(/@@EMPH(\d+)@@/g, (_match, index: string) => `**${protectedSpans[Number(index)]}**`);
}
