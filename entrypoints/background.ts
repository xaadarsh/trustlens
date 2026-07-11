export default defineBackground(() => {
  console.log('Hello background!', { id: browser.runtime.id });

  // browser.runtime.openOptionsPage() is not available from content-script
  // contexts (only privileged extension pages: background/popup/options),
  // so TrustPanel.tsx's footer Settings link — rendered by the content
  // script on the host page — relays through this listener instead.
  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === 'trustlens:open-options') {
      browser.runtime.openOptionsPage();
    }
  });
});
