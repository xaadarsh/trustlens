import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  filterEntrypoints: process.env.NODE_ENV === 'production' ? ['popup', 'content', 'background', 'options'] : undefined,
  // Every verify-*.mjs script in this repo drives its own Playwright-launched
  // Brave against .output/chrome-mv3(-dev) directly — WXT's own auto-launched
  // browser is never used and, in a non-interactive shell, its runner
  // lifecycle can cause `wxt dev` to exit prematurely once that browser
  // process ends. Disabled so `npm run dev` just runs the dev server and
  // writes output, nothing more.
  webExt: { disabled: true },
  manifest: {
    name: 'TrustLens',
    short_name: 'TrustLens',
    description: 'Pattern-based Amazon review confidence checks.',
    icons: {
      16: '/icon/16.png',
      32: '/icon/32.png',
      48: '/icon/48.png',
      96: '/icon/96.png',
      128: '/icon/128.png',
    },
    permissions: ['storage'],
    host_permissions: [
      'https://www.amazon.com/*',
      'https://www.amazon.co.uk/*',
      'https://www.amazon.ca/*',
      'https://www.amazon.com.au/*',
      'https://www.amazon.de/*',
      'https://www.amazon.fr/*',
      'https://www.amazon.it/*',
      'https://www.amazon.es/*',
      'https://www.amazon.in/*',
    ],
  },
});
