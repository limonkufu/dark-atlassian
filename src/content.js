/* Content script (runs at document_start in every frame of the two hosts).
 *
 * Layers, from strongest to weakest:
 *   1. styles/*.css   hand-written Catppuccin Mocha rules (tokens + AUI + product)
 *   2. dynamic layer  every page stylesheet is scanned and light colours are
 *                     rewritten to dark equivalents (covers plugins/unknown pages)
 *   3. inline layer   inline style="" colours are remapped in view mode only
 *                     (never inside editors, so page content is never changed)
 */
(() => {
  'use strict';
  if (window.__ctpMochaLoaded) return;
  window.__ctpMochaLoaded = true;

  const S = globalThis.CtpSchedule;
  const isTop = window === window.top;
  const site = detectSite();
  if (!site) return;

  const VERSION = chrome.runtime.getManifest().version;
  const STYLE_ID = 'ctp-mocha-theme';
  const INLINE_ID = 'ctp-mocha-inline';
  const FRAME_ATTR = 'data-ctp-frame';
  const FILES = ['styles/tokens.css', 'styles/aui.css', 'styles/' + site + '.css'];
  const LS_ACTIVE = 'ctpMocha.active';
  const LS_CSS = 'ctpMocha.css.' + site;
  const LS_BUSTER = 'ctpMocha.buster';

  let settings = S.normalize(null);
  let active = false;
  let cssText = null;
  let timer = null;
  const mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function detectSite() {
    let host = location.hostname;
    if (!host) {
      try { host = window.parent.location.hostname; } catch (_) {
        try { host = new URL(location.ancestorOrigins[0]).hostname; } catch (_2) { host = ''; }
      }
    }
    return S.siteOf(host);
  }

  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* quota / sandbox */ } }
  };

  /* ------------------------------------------------------------------ */
  /* Colour maths shared by the dynamic and inline layers                 */
  /* ------------------------------------------------------------------ */
  const NAMED = {
    white: [255, 255, 255], black: [0, 0, 0], gray: [128, 128, 128], grey: [128, 128, 128],
    silver: [192, 192, 192], whitesmoke: [245, 245, 245], gainsboro: [220, 220, 220],
    lightgray: [211, 211, 211], lightgrey: [211, 211, 211], darkgray: [169, 169, 169],
    darkgrey: [169, 169, 169], dimgray: [105, 105, 105], dimgrey: [105, 105, 105],
    red: [255, 0, 0], blue: [0, 0, 255], green: [0, 128, 0], yellow: [255, 255, 0],
    orange: [255, 165, 0], navy: [0, 0, 128], maroon: [128, 0, 0], purple: [128, 0, 128],
    lightblue: [173, 216, 230], lightyellow: [255, 255, 224], ivory: [255, 255, 240],
    beige: [245, 245, 220], linen: [250, 240, 230], snow: [255, 250, 250],
    aliceblue: [240, 248, 255], lavender: [230, 230, 250], honeydew: [240, 255, 240],
    mintcream: [245, 255, 250], azure: [240, 255, 255], ghostwhite: [248, 248, 255],
    seashell: [255, 245, 238], oldlace: [253, 245, 230], floralwhite: [255, 250, 240],
    khaki: [240, 230, 140], lightgreen: [144, 238, 144], pink: [255, 192, 203],
    lightpink: [255, 182, 193], salmon: [250, 128, 114], gold: [255, 215, 0],
    tomato: [255, 99, 71], crimson: [220, 20, 60], teal: [0, 128, 128], olive: [128, 128, 0],
    darkblue: [0, 0, 139], darkred: [139, 0, 0], darkgreen: [0, 100, 0]
  };

  function parseColor(v) {
    if (!v) return null;
    v = String(v).trim().toLowerCase();
    if (!v || v === 'transparent' || v === 'currentcolor' || v === 'inherit' || v === 'initial' ||
        v === 'unset' || v === 'none' || v.includes('var(') || v.includes('mix(')) return null;
    let m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+%?)\s*)?\)$/.exec(v) ||
            /^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?)\s*)?\)$/.exec(v);
    if (m) {
      let a = 1;
      if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return { r: +m[1], g: +m[2], b: +m[3], a };
    }
    m = /^#([0-9a-f]{3,8})$/.exec(v);
    if (m) {
      let h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
      if (h.length !== 6 && h.length !== 8) return null;
      const n = parseInt(h.slice(0, 6), 16);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a };
    }
    m = /^hsla?\(\s*([\d.]+)(?:deg)?\s*,?\s*([\d.]+)%\s*,?\s*([\d.]+)%\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(v);
    if (m) {
      const [r, g, b] = hslToRgb(+m[1], +m[2] / 100, +m[3] / 100);
      let a = 1;
      if (m[4] !== undefined) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return { r, g, b, a };
    }
    if (NAMED[v]) { const [r, g, b] = NAMED[v]; return { r, g, b, a: 1 }; }
    return null;
  }

  function rgbToHsl(c) {
    const r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h * 60, s, l };
  }

  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r, g, b;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }

  const hsl = (h, s, l) => `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
  const rgba = (rgb, a) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a.toFixed(3)})`;
  const BASE_RGB = [30, 30, 46];      // #1e1e2e
  const TEXT_RGB = [205, 214, 244];   // #cdd6f4

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* Map a light-theme colour to its Catppuccin Mocha counterpart.
   * Returns null when the colour should be left alone. */
  function mapColor(prop, c) {
    const { h, s, l } = rgbToHsl(c);
    const isBg = prop === 'background-color';
    const isBorder = prop.startsWith('border') || prop === 'outline-color' || prop === 'column-rule-color';

    if (c.a < 0.05) return null;
    if (c.a < 0.6) {
      // translucent overlays: flip dark tints to light tints and vice versa
      if (isBg) return l > 0.5 ? rgba(BASE_RGB, c.a) : rgba(TEXT_RGB, c.a);
      return l < 0.5 ? rgba(TEXT_RGB, c.a) : null;
    }

    if (isBg) {
      if (l < 0.55) return null;                      // already dark / saturated: keep
      const neutral = s < 0.12;
      const nl = clamp(0.15 + (1 - l) * 0.45, 0.15, 0.36);
      return neutral ? hsl(240, 0.21, nl) : hsl(h, clamp(s * 0.8, 0.2, 0.45), nl);
    }

    if (isBorder) {
      if (l > 0.6) {
        const neutral = s < 0.15;
        const nl = clamp(0.32 - (l - 0.6) * 0.15, 0.24, 0.34);
        return neutral ? hsl(240, 0.13, nl) : hsl(h, clamp(s * 0.6, 0.15, 0.4), nl);
      }
      if (l < 0.3 && s < 0.2) return hsl(240, 0.13, 0.32);
      return null;
    }

    // text-like properties: color, fill, stroke, caret, text-decoration
    if (l >= 0.5) return null;                         // already light
    if (s < 0.6 || l < 0.12) {
      const neutral = s < 0.15;
      const nl = clamp(0.88 - l * 0.4, 0.68, 0.9);
      return neutral ? hsl(226, 0.6, nl) : hsl(h, clamp(s, 0.3, 0.6), nl);
    }
    return hsl(h, Math.min(0.9, s), Math.max(0.72, l + 0.35)); // saturated: lighten
  }

  function mapValue(prop, value) {
    const c = parseColor(value);
    return c ? mapColor(prop, c) : null;
  }

  /* ------------------------------------------------------------------ */
  /* Style element management                                             */
  /* ------------------------------------------------------------------ */
  function isEditorDocument() {
    return document.designMode === 'on' || !!(document.body && document.body.isContentEditable);
  }

  /* Where our <style> elements live. Editors serialise <body>, so inside
   * frames / editable documents we always use <head>. */
  function styleHost() {
    if (!isTop || isEditorDocument()) return document.head || document.documentElement;
    return document.body || document.head || document.documentElement;
  }

  /* Documents we theme: the page itself plus same-origin iframes (editor
   * bodies, gadgets). Frames run their own copy of this script, which marks
   * <html> with FRAME_ATTR (claimFrame); the parent keeps out of those and
   * only covers frames whose copy is missing, e.g. a document.write()-based
   * editor before its copy has caught up. */
  const docs = new Set([document]);
  const selfThemed = (d) => d !== document && d.documentElement.hasAttribute(FRAME_ATTR);
  const liveDocs = () => Array.from(docs).filter(d => d.defaultView && d.documentElement && !selfThemed(d));

  function hostIn(doc) {
    if (doc === document) return styleHost();
    return doc.head || doc.documentElement;
  }

  function ensureStyleIn(doc, id, text) {
    let el = doc.getElementById(id);
    if (!el) {
      el = doc.createElement('style');
      el.id = id;
      el.setAttribute('data-ctp', '');
      el.textContent = text;
      hostIn(doc).appendChild(el);
      bringToFrontIn(doc);
    } else if (el.textContent !== text) {
      el.textContent = text;
    }
    return el;
  }

  function ensureStyle(id, text) { return ensureStyleIn(document, id, text); }

  function removeStyleIn(doc, id) {
    const el = doc.getElementById(id);
    if (el) el.remove();
  }

  function removeStyle(id) { removeStyleIn(document, id); }

  /* Keep [dynamic, inline, theme] as the last children of the host so they
   * win cascade ties against stylesheets the page adds later. */
  function bringToFrontIn(doc) {
    const host = hostIn(doc);
    if (!host) return;
    const want = [INLINE_ID, STYLE_ID].map(id => doc.getElementById(id)).filter(Boolean);
    if (!want.length) return;
    const tail = Array.from(host.children).slice(-want.length);
    const ok = want.length === tail.length && want.every((el, i) => el === tail[i]);
    if (!ok) want.forEach(el => host.appendChild(el));
  }

  let lastFront = 0;
  function bringToFront() {
    const now = Date.now();
    if (now - lastFront < 1000) return;
    lastFront = now;
    bringToFrontIn(document);
  }

  /* ------------------------------------------------------------------ */
  /* Dynamic layer: rewrite light colours found in page stylesheets       */
  /* ------------------------------------------------------------------ */
  const dyn = (() => {
    const PROPS = ['background-color', 'color', 'border-top-color', 'border-right-color',
      'border-bottom-color', 'border-left-color', 'outline-color', 'fill', 'stroke',
      'text-decoration-color', 'caret-color', 'column-rule-color'];
    const cache = new WeakMap();
    let enabled = false, pending = null;

    function convertRule(rule) {
      const st = rule.style;
      if (!st || !st.length) return '';
      let decl = '';
      for (const p of PROPS) {
        const v = st.getPropertyValue(p);
        if (!v) continue;
        const m = mapValue(p, v);
        if (!m) continue;
        decl += p + ':' + m + (st.getPropertyPriority(p) ? ' !important' : '') + ';';
      }
      return decl;
    }

    /* Rule types are compared by name: instanceof would fail for rules that
     * belong to another realm (iframe documents). */
    const kind = (r) => (r && r.constructor && r.constructor.name) || '';

    function walk(rules, out) {
      for (const r of rules) {
        const k = kind(r);
        if (k === 'CSSStyleRule') {
          const d = convertRule(r);
          if (d) out.push(r.selectorText + '{' + d + '}');
          if (r.cssRules && r.cssRules.length) {         // CSS nesting
            const inner = [];
            walk(r.cssRules, inner);
            if (inner.length) out.push(r.selectorText + '{' + inner.join('') + '}');
          }
        } else if (k === 'CSSMediaRule') {
          const cond = r.conditionText || (r.media && r.media.mediaText) || '';
          if (/\bprint\b/.test(cond) && !/\bscreen\b/.test(cond)) continue;
          const inner = [];
          walk(r.cssRules, inner);
          if (inner.length) out.push('@media ' + cond + '{' + inner.join('') + '}');
        } else if (k === 'CSSSupportsRule') {
          const inner = [];
          walk(r.cssRules, inner);
          if (inner.length) out.push('@supports ' + r.conditionText + '{' + inner.join('') + '}');
        } else if (k === 'CSSContainerRule') {
          const inner = [];
          walk(r.cssRules, inner);
          if (inner.length) out.push('@container ' + r.conditionText + '{' + inner.join('') + '}');
        } else if (k === 'CSSLayerBlockRule') {
          walk(r.cssRules, out);
        } else if (k === 'CSSImportRule') {
          try { if (r.styleSheet) walk(r.styleSheet.cssRules, out); } catch (_) { /* cross-origin */ }
        }
      }
    }

    function processSheet(sheet) {
      let rules;
      try { rules = sheet.cssRules; } catch (_) { return ''; }  // cross-origin
      const out = [];
      walk(rules, out);
      return out.join('\n');
    }

    let seq = 0;

    /* Insert the generated element just before our inline/theme styles so
     * those keep winning ties, without ever moving existing elements. */
    function place(doc, el) {
      const host = hostIn(doc);
      const anchor = doc.getElementById(INLINE_ID) || doc.getElementById(STYLE_ID);
      if (anchor && anchor.parentNode === host) host.insertBefore(el, anchor);
      else host.appendChild(el);
    }

    function run() {
      pending = null;
      if (!enabled) return;
      for (const doc of liveDocs()) {
        for (const sheet of doc.styleSheets) {
          const node = sheet.ownerNode;
          if (!node || (node.hasAttribute && node.hasAttribute('data-ctp'))) continue;
          if (sheet.disabled) continue;
          let len = 0;
          try { len = sheet.cssRules.length; } catch (_) { continue; }
          let entry = cache.get(sheet);
          if (!entry) { entry = { len: -1, text: '', el: null }; cache.set(sheet, entry); }
          if (entry.len !== len) { entry.len = len; entry.text = processSheet(sheet); if (entry.el) entry.el.textContent = entry.text; }
          if (!entry.text) continue;
          if (!entry.el || entry.el.ownerDocument !== doc) {
            const el = doc.createElement('style');
            el.setAttribute('data-ctp', '');
            el.setAttribute('data-ctp-dyn', String(++seq));
            el.textContent = entry.text;
            place(doc, el);
            entry.el = el;
          } else if (!entry.el.isConnected) {
            place(doc, entry.el);
          }
        }
      }
    }

    function clear() {
      for (const doc of liveDocs()) doc.querySelectorAll('style[data-ctp-dyn]').forEach(el => el.remove());
    }

    return {
      enable() { enabled = true; this.refresh(); },
      disable() { enabled = false; if (pending) { clearTimeout(pending); pending = null; } clear(); },
      refresh() { if (enabled && !pending) pending = setTimeout(run, 80); },
      clear
    };
  })();

  /* ------------------------------------------------------------------ */
  /* Inline layer: style="" colours are remapped through generated rules  */
  /* ([style="…"] selectors), so page content is never modified. This is  */
  /* what makes it safe inside editors, whose <body> gets serialised.     */
  /* ------------------------------------------------------------------ */
  const inline = (() => {
    const rules = new Map();          // style attribute text -> generated declarations ('' = nothing to do)
    let enabled = false, pending = null, dirty = false;
    const queue = new Set();

    function declsFor(styleText) {
      const probe = inline.probe || (inline.probe = document.createElement('span'));
      probe.setAttribute('style', styleText);
      const st = probe.style;
      let decl = '';
      const bg = st.getPropertyValue('background-color');
      const col = st.getPropertyValue('color');
      const bc = st.getPropertyValue('border-color') || st.getPropertyValue('border-top-color');
      const nbg = bg ? mapValue('background-color', bg) : null;
      const ncol = col ? mapValue('color', col) : null;
      const nbc = bc ? mapValue('border-top-color', bc) : null;
      if (nbg) decl += 'background-color:' + nbg + ' !important;';
      if (ncol) decl += 'color:' + ncol + ' !important;';
      if (nbc) decl += 'border-color:' + nbc + ' !important;';
      return decl;
    }

    const MAX_RULES = 4000;

    function consider(el) {
      const text = el.getAttribute('style');
      if (!text || rules.has(text)) return;
      if (!/color|background/i.test(text)) return;
      if (rules.size >= MAX_RULES) return;           // pathological pages: stop growing
      rules.set(text, declsFor(text));
      dirty = true;
    }

    function process(root) {
      if (root.nodeType === 1) {
        if (root.hasAttribute('style')) consider(root);
        root.querySelectorAll('[style*="color"],[style*="background"]').forEach(consider);
      } else if (root.nodeType === 9) {
        root.querySelectorAll('[style*="color"],[style*="background"]').forEach(consider);
      }
    }

    function cssEscapeAttr(text) {
      return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ') + '"';
    }

    function render() {
      const out = [];
      for (const [text, decl] of rules) if (decl) out.push('[style=' + cssEscapeAttr(text) + ']{' + decl + '}');
      const text = out.join('\n');
      for (const doc of liveDocs()) ensureStyleIn(doc, INLINE_ID, text);
    }

    function flush() {
      pending = null;
      if (!enabled) return;
      const items = Array.from(queue);
      queue.clear();
      items.forEach(process);
      if (dirty) { dirty = false; render(); }
    }

    return {
      enable() { enabled = true; queue.add(document); if (!pending) pending = setTimeout(flush, 0); },
      disable() { enabled = false; queue.clear(); if (pending) { clearTimeout(pending); pending = null; } removeStyle(INLINE_ID); },
      queue(node) { if (!enabled || !node) return; queue.add(node); if (!pending) pending = setTimeout(flush, 40); },
      /* attribute change: only the element itself, never its subtree */
      queueSelf(el) { if (!enabled || !el || el.nodeType !== 1) return; consider(el); if (dirty && !pending) pending = setTimeout(flush, 40); }
    };
  })();

  /* ------------------------------------------------------------------ */
  /* Same-origin iframes (editor bodies, gadgets) get the theme too        */
  /* ------------------------------------------------------------------ */
  const frames = (() => {
    function docOf(iframe) {
      try { return iframe.contentDocument; } catch (_) { return null; }
    }
    function apply(iframe) {
      const doc = docOf(iframe);
      if (!doc || !doc.documentElement) return;
      if (selfThemed(doc)) { docs.delete(doc); return; }
      if (active && cssText) {
        docs.add(doc);
        doc.documentElement.setAttribute('data-ctp-mocha', 'true');
        ensureStyleIn(doc, STYLE_ID, cssText);
        dyn.refresh();
        inline.queue(doc);
      } else {
        docs.delete(doc);
        doc.documentElement.removeAttribute('data-ctp-mocha');
        for (const id of [STYLE_ID, INLINE_ID]) removeStyleIn(doc, id);
        doc.querySelectorAll('style[data-ctp-dyn]').forEach(el => el.remove());
      }
    }
    function watch(iframe) {
      if (!iframe.__ctpWatched) {
        iframe.__ctpWatched = true;
        iframe.addEventListener('load', () => { apply(iframe); setTimeout(() => apply(iframe), 300); });
      }
      apply(iframe);
    }
    return {
      sync() { document.querySelectorAll('iframe').forEach(watch); },
      added(node) {
        if (node.nodeType !== 1) return;
        if (node.tagName === 'IFRAME') watch(node);
        else if (node.querySelectorAll) node.querySelectorAll('iframe').forEach(watch);
      }
    };
  })();

  /* Inside a frame: mark the document as ours so the parent's copy keeps out
   * (see liveDocs), and drop whatever that copy already generated here.
   * Returns true when the mark had to be set: on start-up, or after
   * document.write() replaced <html> along with everything we had added. */
  function claimFrame() {
    const root = document.documentElement;
    if (isTop || !root || root.hasAttribute(FRAME_ATTR)) return false;
    root.setAttribute(FRAME_ATTR, '');
    document.querySelectorAll('style[data-ctp-dyn]').forEach(el => el.remove());
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Activation                                                           */
  /* ------------------------------------------------------------------ */
  function applyTheme(on) {
    active = on;
    ls.set(LS_ACTIVE, on ? '1' : '0');
    const root = document.documentElement;
    if (on) {
      root.setAttribute('data-ctp-mocha', 'true');
      if (cssText) ensureStyle(STYLE_ID, cssText);
      dyn.enable();
      inline.enable();
      bringToFront();
    } else {
      root.removeAttribute('data-ctp-mocha');
      removeStyle(STYLE_ID);
      removeStyle(INLINE_ID);
      dyn.disable();
      inline.disable();
    }
    frames.sync();
  }

  function decide() {
    return S.shouldApply(settings, site, new Date(), mql ? mql.matches : false);
  }

  function scheduleNext() {
    clearTimeout(timer);
    const next = S.nextChange(settings);
    if (next) timer = setTimeout(recheck, Math.max(1000, next.getTime() - Date.now() + 750));
  }

  function recheck() {
    const on = decide();
    if (on !== active) applyTheme(on);
    else if (on && cssText) { ensureStyle(STYLE_ID, cssText); frames.sync(); }
    scheduleNext();
  }

  async function loadSettings() {
    try {
      const { settings: raw } = await chrome.storage.sync.get('settings');
      settings = S.normalize(raw);
    } catch (_) { /* extension reloaded; keep defaults */ }
  }

  async function loadCss() {
    let buster = '';
    try { buster = String((await chrome.storage.local.get('cacheBuster')).cacheBuster || ''); } catch (_) { /* ignore */ }
    const key = VERSION + ':' + buster;
    if (cssText && ls.get(LS_BUSTER) === key) return;
    if (ls.get(LS_BUSTER) === key && ls.get(LS_CSS)) { cssText = ls.get(LS_CSS); return; }
    const parts = await Promise.all(FILES.map(f => fetch(chrome.runtime.getURL(f)).then(r => r.text())));
    cssText = parts.join('\n');
    ls.set(LS_CSS, cssText);
    ls.set(LS_BUSTER, key);
  }

  async function toggleFromPage() {
    await loadSettings();
    const now = new Date();
    if (settings.mode === 'on') settings.mode = 'off';
    else if (settings.mode === 'off') settings.mode = 'on';
    else settings.override = { active: !decide(), until: S.overrideUntil(settings, now) };
    try { await chrome.storage.sync.set({ settings }); } catch (_) { /* ignore */ }
    recheck();
  }

  function observe() {
    const mo = new MutationObserver((records) => {
      let stylesChanged = false;
      for (const rec of records) {
        if (rec.type === 'attributes') { inline.queueSelf(rec.target); continue; }
        for (const node of rec.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.hasAttribute('data-ctp')) continue;
          const tag = node.tagName;
          if (tag === 'STYLE' || (tag === 'LINK' && /stylesheet/i.test(node.rel || ''))) stylesChanged = true;
          else if (tag === 'HTML' || tag === 'HEAD' || tag === 'BODY') stylesChanged = true;
          if (tag === 'HTML') claimFrame();   // document.write(): before the parent sees the load
          frames.added(node);
          inline.queue(node);
        }
      }
      if (stylesChanged && active) {
        if (cssText && !document.getElementById(STYLE_ID)) ensureStyle(STYLE_ID, cssText);
        bringToFront();
        dyn.refresh();
      }
    });
    mo.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });

    // Stylesheets finishing their download also change the cascade.
    document.addEventListener('load', (e) => {
      if (e.target && e.target.tagName === 'LINK' && active) dyn.refresh();
    }, true);

    if (!isTop) {
      // Editor iframes are rewritten with document.write(); make sure we survive it
      // (the observer above normally re-claims first; this is the backstop).
      setInterval(() => {
        const reclaimed = claimFrame();
        if (active && cssText && (reclaimed || !document.getElementById(STYLE_ID))) {
          document.documentElement.setAttribute('data-ctp-mocha', 'true');
          ensureStyle(STYLE_ID, cssText);
          dyn.refresh();
        }
      }, 1000);
    }
  }

  async function init() {
    claimFrame();
    // 1. Synchronous fast path from the last known state, to avoid a light flash.
    if (ls.get(LS_ACTIVE) === '1' && ls.get(LS_CSS)) {
      cssText = ls.get(LS_CSS);
      applyTheme(true);
    }
    observe();

    // 2. Real settings and (possibly refreshed) CSS.
    await loadSettings();
    await loadCss();
    recheck();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { if (active) { bringToFront(); dyn.refresh(); frames.sync(); } });
    }
    window.addEventListener('load', () => { if (active) { bringToFront(); dyn.refresh(); frames.sync(); } });

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes.settings) { settings = S.normalize(changes.settings.newValue); recheck(); }
        if (area === 'local' && changes.cacheBuster) loadCss().then(recheck);
      });
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg) return;
        if (msg.type === 'ctp:recheck') { loadSettings().then(recheck); }
        else if (msg.type === 'ctp:toggle' && isTop) { toggleFromPage().then(() => sendResponse({ ok: true })); return true; }
        else if (msg.type === 'ctp:state') { sendResponse({ active, site }); }
      });
    } catch (_) { /* extension context invalidated */ }

    if (mql) mql.addEventListener('change', recheck);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) recheck(); });
  }

  init();
})();
