import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  filterEntrypoints: process.env.NODE_ENV === 'production' ? ['popup', 'content', 'background', 'options'] : undefined,
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
