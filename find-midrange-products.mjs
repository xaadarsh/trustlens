// find-midrange-products.mjs — one-off discovery helper: searches Amazon and
// finds real products with 500-2000 total reviews and a non-extreme average
// rating (3.3-4.4 stars), to use as test candidates confirming the new
// population-evidence bypass in statistical-engine.ts does NOT fire for the
// ambiguous middle ground.

import { chromium } from '@playwright/test';

const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';
// Niche/long-tail queries tend to surface smaller sellers with modest review
// counts, unlike generic terms (phone case, etc.) which are dominated by
// huge-volume listings.
const QUERIES = [
  'cast iron trivet',
  'canvas tool tote bag',
  'ceramic soap dish',
  'wool dryer balls unscented',
  'stainless steel garlic press',
  'felt coasters set',
  'wooden knife block',
];

function parseCount(text) {
  const match = text.match(/\(([\d.]+)(K|M)?\)/);
  if (!match) return null;
  const num = Number(match[1]);
  if (match[2] === 'K') return Math.round(num * 1000);
  if (match[2] === 'M') return Math.round(num * 1000000);
  return Math.round(num);
}

async function main() {
  const browser = await chromium.launch({ executablePath: BRAVE_PATH, headless: false });
  const page = await browser.newPage();
  const candidates = [];

  for (const query of QUERIES) {
    if (candidates.length >= 6) break;
    await page.goto(`https://www.amazon.com/s?k=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    const results = await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-component-type="s-search-result"]')];
      return items.map((item) => {
        const asin = item.getAttribute('data-asin');
        const titleEl = item.querySelector('h2, [data-cy="title-recipe"]');
        const ratingAlt = item.querySelector('[data-cy="reviews-ratings-slot"] .a-icon-alt, .a-icon-alt')?.textContent ?? '';
        const ratingMatch = ratingAlt.match(/([\d.]+)\s+out of/);
        const reviewsBlock = item.querySelector('[data-cy="reviews-block"]');
        const countText = reviewsBlock ? reviewsBlock.textContent.replace(/\s+/g, ' ').trim() : '';
        return {
          asin,
          title: titleEl?.textContent?.trim().slice(0, 90) ?? '',
          rating: ratingMatch ? Number(ratingMatch[1]) : null,
          countText,
        };
      });
    });

    for (const r of results) {
      if (!r.asin || !r.rating) continue;
      const reviewCount = parseCount(r.countText);
      if (!reviewCount) continue;
      if (reviewCount < 500 || reviewCount > 2000) continue;
      if (r.rating < 3.3 || r.rating > 4.4) continue;
      candidates.push({ title: r.title, rating: r.rating, reviewCount, url: `https://www.amazon.com/dp/${r.asin}`, fromQuery: query });
      if (candidates.length >= 6) break;
    }
  }

  console.log(JSON.stringify(candidates, null, 2));
  await browser.close();
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
