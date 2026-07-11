// diag-histogram-dom.mjs — one-off DOM inspection: dumps whatever HTML looks
// like Amazon's rating histogram on a real product page, so the real
// selectors can be read off instead of guessed.

import { chromium } from '@playwright/test';

const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';
const URL = process.argv[2] || 'https://www.amazon.com/dp/B00FLYWNYQ';

async function main() {
  const browser = await chromium.launch({ executablePath: BRAVE_PATH, headless: false });
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  const info = await page.evaluate(() => {
    const out = {};

    out.histogramTableExists = !!document.querySelector('#histogramTable');
    out.dataHookHistogramTable = !!document.querySelector('[data-hook="histogram-table"]');
    out.dataHookRows = [1, 2, 3, 4, 5].map((n) => !!document.querySelector(`[data-hook="histogram-row-${n}"]`));

    // Broad sweep: any element whose data-hook contains "histogram"
    const hookEls = [...document.querySelectorAll('[data-hook*="histogram" i]')];
    out.anyHistogramHookCount = hookEls.length;
    out.histogramHookSamples = hookEls.slice(0, 8).map((el) => ({
      tag: el.tagName,
      dataHook: el.getAttribute('data-hook'),
      id: el.id,
      className: typeof el.className === 'string' ? el.className.slice(0, 120) : '',
      outerHTMLSnippet: el.outerHTML.slice(0, 300),
    }));

    // Any element whose id contains "histogram"
    const idEls = [...document.querySelectorAll('[id*="histogram" i]')];
    out.anyHistogramIdCount = idEls.length;
    out.histogramIdSamples = idEls.slice(0, 5).map((el) => ({ tag: el.tagName, id: el.id, outerHTMLSnippet: el.outerHTML.slice(0, 300) }));

    // Look for progressbar meters anywhere near reviews
    const meters = [...document.querySelectorAll('[role="progressbar"]')];
    out.progressbarCount = meters.length;
    out.progressbarSamples = meters.slice(0, 8).map((el) => ({
      ariaValuenow: el.getAttribute('aria-valuenow'),
      ariaLabel: el.getAttribute('aria-label'),
      outerHTMLSnippet: el.outerHTML.slice(0, 250),
      parentOuterHTMLSnippet: el.parentElement?.outerHTML.slice(0, 300) ?? '',
    }));

    // Text-based sweep: rows/links mentioning "star" and "%"
    const starPctEls = [...document.querySelectorAll('a, tr, div, span')].filter((el) => {
      const t = el.textContent || '';
      return /\b[1-5]\s*star/i.test(t) && /%/.test(t) && t.length < 200 && el.children.length <= 3;
    });
    out.starPctCount = starPctEls.length;
    out.starPctSamples = starPctEls.slice(0, 10).map((el) => ({
      tag: el.tagName,
      className: typeof el.className === 'string' ? el.className.slice(0, 120) : '',
      text: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 150),
      outerHTMLSnippet: el.outerHTML.slice(0, 250),
    }));

    return out;
  });

  console.log(JSON.stringify(info, null, 2));
  await browser.close();
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
