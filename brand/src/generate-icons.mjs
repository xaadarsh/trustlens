// generate-icons.mjs — builds the GradeLens rating-histogram mark as
// hand-tuned SVG per icon size (not one master SVG naively downscaled —
// stroke width, margins, and bar thickness are recomputed per size so the
// 16px version stays crisp and legible), then rasterizes each to a PNG at
// its native pixel size via a real Chromium paint (Playwright), which
// anti-aliases far better than a generic SVG->PNG converter at these tiny
// dimensions.

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');
const BRAND_DIR = path.join(REPO_ROOT, 'brand');
const ICON_DIR = path.join(REPO_ROOT, 'public', 'icon');

const CREAM = '#F5F1E8';
const INK = '#1A1A1A';
const BAR_LIGHT = '#B8B2A4';
const BAR_MID = '#6F6A5F';

// Each size is a fully independent, hand-computed layout — not a scaled
// copy of another. 48px is the design reference (border=2, matching the
// spec literally); 32/128 scale that proportionally; 16 is rebuilt from
// scratch on an integer grid so the border and bars land on crisp pixel
// boundaries rather than sub-pixel positions that would blur under
// anti-aliasing at that size.
const SIZES = {
  16: {
    canvas: 16,
    border: { x: 1.5, y: 1.5, w: 13, h: 13, rx: 3, stroke: 1 },
    bars: [
      { x: 2, w: 3, h: 3, r: 0.75 },
      { x: 6, w: 3, h: 6, r: 0.75 },
      { x: 10, w: 3, h: 9, r: 0.75 },
    ],
    baseline: 13,
  },
  32: {
    canvas: 32,
    border: { x: 2, y: 2, w: 28, h: 28, rx: 6, stroke: 1.5 },
    bars: [
      { x: 8, w: 4, h: 5, r: 1 },
      { x: 14, w: 4, h: 10, r: 1 },
      { x: 20, w: 4, h: 15, r: 1 },
    ],
    baseline: 24,
  },
  48: {
    canvas: 48,
    border: { x: 3, y: 3, w: 42, h: 42, rx: 9, stroke: 2 },
    bars: [
      { x: 11, w: 6, h: 8, r: 1.5 },
      { x: 21, w: 6, h: 15, r: 1.5 },
      { x: 31, w: 6, h: 22, r: 1.5 },
    ],
    baseline: 36,
  },
  96: {
    canvas: 96,
    border: { x: 6, y: 6, w: 84, h: 84, rx: 18, stroke: 4 },
    bars: [
      { x: 22, w: 12, h: 16, r: 3 },
      { x: 42, w: 12, h: 30, r: 3 },
      { x: 62, w: 12, h: 44, r: 3 },
    ],
    baseline: 72,
  },
  128: {
    canvas: 128,
    border: { x: 8, y: 8, w: 112, h: 112, rx: 24, stroke: 5 },
    bars: [
      { x: 29, w: 16, h: 21, r: 4 },
      { x: 56, w: 16, h: 40, r: 4 },
      { x: 83, w: 16, h: 59, r: 4 },
    ],
    baseline: 96,
  },
};

const BAR_COLORS = [BAR_LIGHT, BAR_MID, INK];

function buildSvg(spec) {
  const { canvas, border, bars, baseline } = spec;
  const barRects = bars
    .map((bar, i) => {
      const y = baseline - bar.h;
      return `<rect x="${bar.x}" y="${y}" width="${bar.w}" height="${bar.h}" rx="${bar.r}" ry="${bar.r}" fill="${BAR_COLORS[i]}" />`;
    })
    .join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}">
    <rect x="${border.x}" y="${border.y}" width="${border.w}" height="${border.h}" rx="${border.rx}" ry="${border.rx}" fill="${CREAM}" stroke="${INK}" stroke-width="${border.stroke}" />
    ${barRects}
  </svg>`;
}

async function main() {
  fs.mkdirSync(ICON_DIR, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();

  for (const [sizeStr, spec] of Object.entries(SIZES)) {
    const size = Number(sizeStr);
    const svg = buildSvg(spec);
    fs.writeFileSync(path.join(BRAND_DIR, `icon-${size}.svg`), svg, 'utf8');

    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent;}</style></head><body>${svg}</body></html>`);
    const pngBuffer = await page.screenshot({ omitBackground: true });

    fs.writeFileSync(path.join(BRAND_DIR, `icon-${size}.png`), pngBuffer);
    // 96 isn't one of the 4 required manifest sizes but was already
    // referenced by the existing wxt.config.ts — regenerated on-brand too
    // so nothing in the manifest still points at a stale placeholder icon.
    fs.writeFileSync(path.join(ICON_DIR, `${size}.png`), pngBuffer);
    console.log(`Wrote icon-${size}.svg / icon-${size}.png / public/icon/${size}.png`);
  }

  await browser.close();
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
