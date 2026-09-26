/* Dev-only: runs the real content script inside a page with chrome.* stubbed.
 * Usage (in DevTools / automation on a Confluence or Jira tab):
 *   fetch('http://localhost:8765/scripts/test-harness.js').then(r => r.text()).then(eval)
 */
(async () => {
  const ORIGIN = 'http://localhost:8765/';
  const listeners = { storage: [], message: [] };
  window.__ctpStub = { settings: { mode: 'on' }, cacheBuster: Date.now() };
  window.chrome = window.chrome || {};
  window.chrome.runtime = Object.assign(window.chrome.runtime || {}, {
    getManifest: () => ({ version: 'dev-' + Date.now() }),
    getURL: (p) => ORIGIN + p + '?v=' + Date.now(),
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    sendMessage: async () => ({})
  });
  window.chrome.storage = {
    sync: { get: async () => ({ settings: window.__ctpStub.settings }), set: async (o) => { Object.assign(window.__ctpStub, o); listeners.storage.forEach(fn => fn({ settings: { newValue: o.settings } }, 'sync')); } },
    local: { get: async () => ({ cacheBuster: window.__ctpStub.cacheBuster }) },
    onChanged: { addListener: (fn) => listeners.storage.push(fn) }
  };
  window.__ctpSetMode = (mode) => window.chrome.storage.sync.set({ settings: Object.assign({}, window.__ctpStub.settings, { mode }) });
  try { localStorage.removeItem('ctpMocha.buster'); } catch (_) {}
  delete window.__ctpMochaLoaded;
  for (const f of ['src/schedule.js', 'src/content.js']) {
    const code = await fetch(ORIGIN + f + '?v=' + Date.now()).then(r => r.text());
    (0, eval)(code);
  }
  return 'harness loaded';
})();
