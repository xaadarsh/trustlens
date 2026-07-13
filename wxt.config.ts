import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'GradeLens',
    short_name: 'GradeLens',
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
      // Content-script matches: where the panel scrapes and mounts.
      'https://www.amazon.com/*',
      'https://www.amazon.co.uk/*',
      'https://www.amazon.ca/*',
      'https://www.amazon.com.au/*',
      'https://www.amazon.de/*',
      'https://www.amazon.fr/*',
      'https://www.amazon.it/*',
      'https://www.amazon.es/*',
      'https://www.amazon.in/*',
      // Exact API endpoints GradeLens calls directly with the user's own
      // BYO key / license key (lib/byo-key.ts, lib/deep-analysis.ts,
      // lib/license.ts) — declared explicitly rather than relying on each
      // provider's own CORS headers, since host_permissions is what
      // actually grants a content-script or extension-page fetch a CORS
      // bypass to a third-party origin in MV3.
      'https://generativelanguage.googleapis.com/*',
      'https://api.openai.com/*',
      'https://api.gumroad.com/*',
    ],
    // Strictest CSP the extension pages (popup.html/options.html) can
    // function under. Content scripts are NOT governed by this policy —
    // they run as part of the host page and their own network requests are
    // controlled by host_permissions above, not this directive — so this
    // only needs to cover what popup/options actually load: the bundled
    // JS/CSS, the Google Fonts stylesheet + font files tokens.css pulls in,
    // and direct API calls to the three providers above. No inline
    // scripts, no eval, no remote code, no plugins, no forms.
    content_security_policy: {
      extension_pages:
        "default-src 'self'; script-src 'self'; object-src 'none'; " +
        "style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
        "img-src 'self'; " +
        'connect-src \'self\' https://api.gumroad.com https://generativelanguage.googleapis.com https://api.openai.com; ' +
        "base-uri 'none';",
    },
  },
});
