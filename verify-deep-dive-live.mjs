// verify-deep-dive-live.mjs — real-key verification of the Bug 2 fix
// (Gemini deep-dive truncation + raw markdown). Calls the EXACT same
// endpoint/config/prompt as lib/deep-analysis.ts's runGemini(), using a
// realistic sample product+review dataset, so this proves the actual fix
// works rather than a synthetic mock. Prints the full raw response
// (finishReason, usageMetadata, text) plus the cleaned final text, and
// flags any leftover markdown symbols.
//
// Usage: set the key via an env var, never as a CLI arg (avoids it landing
// in shell history) — e.g.:
//   GEMINI_KEY=AIzaSy... node verify-deep-dive-live.mjs

const apiKey = process.env.GEMINI_KEY;
if (!apiKey) {
  console.error('Set GEMINI_KEY env var first, e.g.: GEMINI_KEY=AIzaSy... node verify-deep-dive-live.mjs');
  process.exit(1);
}

const SYSTEM_PROMPT = `You are TrustLens, a review-pattern assistant. Use cautious, pattern/confidence language only. Do not accuse a seller, reviewer, brand, product, or review of fraud. Do not claim proof. Explain what the visible data suggests, what is uncertain, and what a shopper may want to inspect next. Respond in plain text only — never use markdown formatting (no **bold**, no *italics*, no # headers, no markdown list markers). For list items, write plain lines starting with "1.", "2.", etc.`;

// A realistic stand-in for a scraped Pilgrim-style product + review sample,
// same shape buildPrompt() in lib/deep-analysis.ts produces.
const prompt = [
  'Product: PILGRIM French Red Vine Anti Aging Night Cream',
  'ASIN: B08RQJKF6D',
  'Average rating: 4.1',
  'Total reviews: 1920',
  'Product first available: unknown',
  'Statistical grade: B',
  'Rule checks: Rating distribution shape: pass (54% 5★, 22% 4★, 13% 3★, 4% 2★, 7% 1★ — a natural, gradually declining curve across the full review population.) Overall rating & review volume: watch (4.1 average across 1,920 total reviews is a limited independent signal.)',
  'Visible review sample:',
  [
    '1. 5 stars | verified=true | vine=false | date=2026-05-12 | Great texture Absorbs fast, no greasy feel, noticed brighter skin after 2 weeks.',
    '2. 4 stars | verified=true | vine=false | date=2026-04-30 | Good but pricey Works well but the jar is small for the price.',
    '3. 2 stars | verified=false | vine=false | date=2026-03-18 | Broke me out Caused some breakouts on my chin, had to stop using it.',
    '4. 5 stars | verified=true | vine=false | date=2026-05-02 | Love it Repurchased twice already, skin feels firmer.',
    '5. 3 stars | verified=true | vine=false | date=2026-02-11 | Its ok Nothing special, mild moisturizing effect only.',
  ].join('\n'),
  'Write a concise shopper-facing deep dive as 3-5 short numbered points (e.g. "1. ...", "2. ..."). Plain text only — do not use any markdown symbols (**, *, #, -, backticks). Use pattern/confidence language only.',
].join('\n\n');

function stripMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/(\*\*|__)(.*?)\1/gs, '$2')
    .replace(/(\*|_)(.*?)\1/gs, '$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/[*_#`]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

async function main() {
  console.log('=== Calling Gemini 3.5 Flash (same config as lib/deep-analysis.ts) ===\n');

  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        thinkingConfig: { thinkingLevel: 'low' },
        maxOutputTokens: 1536,
        temperature: 0.2,
      },
    }),
  });

  console.log('HTTP status:', response.status);
  const payload = await response.json();

  console.log('\n=== FULL RAW RESPONSE ===');
  console.log(JSON.stringify(payload, null, 2));

  if (!response.ok) {
    console.error('\nRequest failed — see raw response above for the error details.');
    process.exit(1);
  }

  const candidate = payload.candidates?.[0];
  console.log('\n=== finishReason ===', candidate?.finishReason);
  console.log('=== usageMetadata ===', JSON.stringify(payload.usageMetadata, null, 2));

  const rawText = candidate?.content?.parts?.map((part) => part.text).join('').trim();
  console.log('\n=== RAW TEXT (before markdown stripping) ===');
  console.log(rawText);

  const cleaned = stripMarkdown(rawText);
  console.log('\n=== CLEANED TEXT (what the panel will actually show) ===');
  console.log(cleaned);

  console.log('\n=== CHECKS ===');
  const wasTruncated = candidate?.finishReason === 'MAX_TOKENS';
  console.log('Truncated (finishReason=MAX_TOKENS):', wasTruncated);
  const leftoverMarkdown = /[*_#`]/.test(cleaned);
  console.log('Leftover markdown symbols in cleaned text:', leftoverMarkdown);
  console.log('Cleaned text length (chars):', cleaned.length);
  console.log(!wasTruncated && !leftoverMarkdown && cleaned.length > 50 ? '\nPASS' : '\nFAIL — investigate above');
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
