import type { DeepAnalysisProvider, ScrapedAmazonPage, StatisticalAnalysis } from './types';

export const SYSTEM_PROMPT = `You are TrustLens, a review-pattern assistant. Use cautious, pattern/confidence language only. Do not accuse a seller, reviewer, brand, product, or review of fraud. Do not claim proof. Explain what the visible data suggests, what is uncertain, and what a shopper may want to inspect next.`;

export interface DeepAnalysisInput {
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
    'Write a concise shopper-facing deep dive in 3-5 bullets using only pattern/confidence language.',
  ].join('\n\n');
}

async function runGemini(apiKey: string, prompt: string): Promise<string> {
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 700, temperature: 0.2 },
    }),
  });
  if (!response.ok) throw new Error(`Gemini deep dive failed (${response.status}).`);
  const payload = await response.json();
  return payload.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text).join('').trim() || 'No deep-dive text returned.';
}

async function runOpenAI(apiKey: string, prompt: string): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-5-mini',
      instructions: SYSTEM_PROMPT,
      input: prompt,
      max_output_tokens: 700,
    }),
  });
  if (!response.ok) throw new Error(`OpenAI deep dive failed (${response.status}).`);
  const payload = await response.json();
  return payload.output_text || payload.output?.flatMap((item: { content?: { text?: string }[] }) => item.content ?? []).map((content: { text?: string }) => content.text).join('').trim() || 'No deep-dive text returned.';
}
