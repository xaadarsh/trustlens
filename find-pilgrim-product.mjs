// find-pilgrim-product.mjs — one-off discovery helper: searches Amazon for a
// "Pilgrim" brand product with ~1,920 reviews and a ~4.1 average rating, to
// use as the histogram-grading test case (a product that previously failed
// with "insufficient data" under the old 30-review-minimum gate).

import { chromium } from '@playwright/test';

const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';
const SITES = ['https://www.amazon.in/s?k=pilgrim', 'https://www.amazon.com/s?k=pilgrim+skincare'];

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
  const all = [];

  for (const url of SITES) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
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
          title: titleEl?.textContent?.trim().slice(0, 100) ?? '',
          rating: ratingMatch ? Number(ratingMatch[1]) : null,
          countText,
        };
      });
    });

    const base = url.includes('amazon.in') ? 'https://www.amazon.in' : 'https://www.amazon.com';
    for (const r of results) {
      if (!r.asin || !r.rating) continue;
      const reviewCount = parseCount(r.countText);
      if (!reviewCount) continue;
      all.push({ title: r.title, rating: r.rating, reviewCount, url: `${base}/dp/${r.asin}` });
    }
  }

  all.sort((a, b) => Math.abs(a.reviewCount - 1920) - Math.abs(b.reviewCount - 1920));
  console.log(JSON.stringify(all.slice(0, 15), null, 2));
  await browser.close();
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
