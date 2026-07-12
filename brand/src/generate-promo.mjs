// generate-promo.mjs — builds the 3 marketing assets from the same
// icon mark and Warm Editorial palette used across the extension:
//   - 440x280  Chrome Web Store promo tile
//   - 1280x720 Gumroad cover image
//   - 600x600  Gumroad square thumbnail
// Rendered via a real Chromium paint (Playwright) with the actual
// Fraunces/Inter webfonts the panel itself uses, at exact target pixel
// dimensions — not scaled up/down from another size.

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRAND_DIR = path.join(__dirname, '..');

const CREAM = '#F5F1E8';
const CARD = '#FCFBF8';
const INK = '#1A1A1A';
const TEXT_SECONDARY = '#716D62';
const BORDER = '#EAE6DD';
const BAR_LIGHT = '#B8B2A4';
const BAR_MID = '#6F6A5F';

const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap');`;

// Same bar proportions as the 128px icon, reusable inline at any size via
// a viewBox + explicit pixel width/height on the <svg> itself.
function iconSvg(px) {
  return `<svg width="${px}" height="${px}" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
    <rect x="8" y="8" width="112" height="112" rx="24" ry="24" fill="${CREAM}" stroke="${INK}" stroke-width="5" />
    <rect x="29" y="75" width="16" height="21" rx="4" ry="4" fill="${BAR_LIGHT}" />
    <rect x="56" y="56" width="16" height="40" rx="4" ry="4" fill="${BAR_MID}" />
    <rect x="83" y="37" width="16" height="59" rx="4" ry="4" fill="${INK}" />
  </svg>`;
}

const ASSETS = [
  {
    name: 'promo-tile-440x280',
    width: 440,
    height: 280,
    html: () => `
      <div class="tile">
        <div class="icon-wrap">${iconSvg(128)}</div>
        <div class="copy">
          <p class="wordmark">GradeLens</p>
          <p class="tagline">Know if Amazon reviews are real.</p>
        </div>
      </div>
      <style>
        body { margin:0; width:440px; height:280px; background:${CREAM}; }
        .tile {
          box-sizing: border-box;
          width: 440px; height: 280px;
          display: flex; align-items: center; gap: 28px;
          padding: 0 36px;
          border: 2px solid ${INK};
          border-radius: 20px;
        }
        .icon-wrap { flex-shrink: 0; width: 128px; height: 128px; }
        .wordmark {
          margin: 0 0 8px;
          font-family: 'Fraunces', Georgia, serif;
          font-weight: 700;
          font-size: 44px;
          color: ${INK};
          line-height: 1;
        }
        .tagline {
          margin: 0;
          font-family: 'Inter', sans-serif;
          font-weight: 500;
          font-size: 17px;
          color: ${TEXT_SECONDARY};
          line-height: 1.35;
          max-width: 230px;
        }
      </style>
    `,
  },
  {
    name: 'gumroad-cover-1280x720',
    width: 1280,
    height: 720,
    html: () => `
      <div class="cover">
        <div class="icon-wrap">${iconSvg(220)}</div>
        <p class="wordmark">GradeLens</p>
        <p class="tagline">Know if Amazon reviews are real.</p>
      </div>
      <style>
        body { margin:0; width:1280px; height:720px; background:${CREAM}; }
        .cover {
          box-sizing: border-box;
          width: 1280px; height: 720px;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          gap: 28px;
        }
        .icon-wrap { width: 220px; height: 220px; }
        .wordmark {
          margin: 0;
          font-family: 'Fraunces', Georgia, serif;
          font-weight: 700;
          font-size: 88px;
          color: ${INK};
          line-height: 1;
          letter-spacing: -0.01em;
        }
        .tagline {
          margin: 0;
          font-family: 'Inter', sans-serif;
          font-weight: 500;
          font-size: 30px;
          color: ${TEXT_SECONDARY};
        }
      </style>
    `,
  },
  {
    name: 'gumroad-thumb-600x600',
    width: 600,
    height: 600,
    html: () => `
      <div class="thumb">
        <div class="icon-wrap">${iconSvg(280)}</div>
        <p class="wordmark">GradeLens</p>
      </div>
      <style>
        body { margin:0; width:600px; height:600px; background:${CREAM}; }
        .thumb {
          box-sizing: border-box;
          width: 600px; height: 600px;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          gap: 26px;
        }
        .icon-wrap { width: 280px; height: 280px; }
        .wordmark {
          margin: 0;
          font-family: 'Fraunces', Georgia, serif;
          font-weight: 700;
          font-size: 56px;
          color: ${INK};
        }
      </style>
    `,
  },
];

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  for (const asset of ASSETS) {
    await page.setViewportSize({ width: asset.width, height: asset.height });
    await page.setContent(`<!doctype html><html><head><style>${FONT_IMPORT} * { box-sizing: border-box; }</style></head><body>${asset.html()}</body></html>`, {
      waitUntil: 'networkidle',
    });
    // Give webfonts a moment to swap in after networkidle (font-display
    // swap can still paint the fallback for a frame or two).
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(200);

    const buf = await page.screenshot({ clip: { x: 0, y: 0, width: asset.width, height: asset.height } });
    fs.writeFileSync(path.join(BRAND_DIR, `${asset.name}.png`), buf);
    console.log(`Wrote ${asset.name}.png (${asset.width}x${asset.height})`);
  }

  await browser.close();
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
