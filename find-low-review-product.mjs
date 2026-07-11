// find-low-review-product.mjs — one-off discovery helper: finds a real
// Amazon product with a very small review count (1-25) to use as the
// sparse-histogram test case for the population-core grading restructure.

import { chromium } from '@playwright/test';

const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';
const QUERIES = [
  'artisan hand carved wooden spoon',
  'handmade ceramic incense holder',
  'niche perfume oil sample',
  'small batch leather keychain',
  'obscure board game expansion',
];

function parseCount(text) {
  const match = text.match(/\(([\d,.]+)(K|M)?\)/);
  if (!match) return null;
  const num = Number(match[1].replace(/,/g, ''));
  if (match[2] === 'K') return Math.round(num * 1000);
  if (match[2] === 'M') return Math.round(num * 1000000);
  return Math.round(num);
}

async function main() {
  const browser = await chromium.launch({ executablePath: BRAVE_PATH, headless: false });
  const page = await browser.newPage();
  const candidates = [];

  for (const query of QUERIES) {
    if (candidates.length >= 8) break;
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
      if (!r.asin) continue;
      const reviewCount = parseCount(r.countText);
      if (reviewCount === null || reviewCount < 1 || reviewCount > 25) continue;
      candidates.push({ title: r.title, rating: r.rating, reviewCount, url: `https://www.amazon.com/dp/${r.asin}`, fromQuery: query });
      if (candidates.length >= 8) break;
    }
  }

  console.log(JSON.stringify(candidates, null, 2));
  await browser.close();
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
