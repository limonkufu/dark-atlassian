/* Shared schedule logic. Loaded by the content script, the popup and the
 * service worker, so it must stay plain (no modules, no DOM). */
(function (root) {
  'use strict';

  const DEFAULTS = Object.freeze({
    mode: 'schedule',          // 'schedule' | 'on' | 'off' | 'system'
    start: '19:00',            // schedule: theme turns on at this local time
    end: '07:00',              // schedule: theme turns off at this local time
    sites: { confluence: true, jira: true },
    override: null             // { active: boolean, until: epochMs } | null
  });

  const MODES = ['schedule', 'on', 'off', 'system'];
  const HM = /^\d{1,2}:\d{2}$/;

  function normalize(raw) {
    const s = Object.assign({}, DEFAULTS, raw || {});
    s.sites = Object.assign({}, DEFAULTS.sites, (raw && raw.sites) || {});
    if (!MODES.includes(s.mode)) s.mode = DEFAULTS.mode;
    if (!HM.test(s.start)) s.start = DEFAULTS.start;
    if (!HM.test(s.end)) s.end = DEFAULTS.end;
    const o = s.override;
    if (!(o && typeof o.until === 'number' && o.until > Date.now())) s.override = null;
    else s.override = { active: !!o.active, until: o.until };
    return s;
  }

  function toMinutes(hm) {
    const [h, m] = hm.split(':').map(Number);
    return (((h * 60 + m) % 1440) + 1440) % 1440;
  }

  function minutesOfDay(d) {
    return d.getHours() * 60 + d.getMinutes();
  }

  /* True when `now` falls inside [start, end), wrapping past midnight. */
  function inWindow(now, start, end) {
    const n = minutesOfDay(now), s = toMinutes(start), e = toMinutes(end);
    if (s === e) return true;
    return s < e ? (n >= s && n < e) : (n >= s || n < e);
  }

  function atMinutes(now, minutes, dayOffset) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + dayOffset);
    d.setMinutes(minutes);
    return d;
  }

  /* Next Date at which the schedule flips, or null if it never does. */
  function nextBoundary(now, start, end) {
    const s = toMinutes(start), e = toMinutes(end);
    if (s === e) return null;
    let best = null;
    for (const m of [s, e]) {
      for (const off of [0, 1]) {
        const d = atMinutes(now, m, off);
        if (d > now && (!best || d < best)) best = d;
      }
    }
    return best;
  }

  function siteOf(hostname) {
    const h = String(hostname || '').toLowerCase();
    if (h.includes('confluence')) return 'confluence';
    if (h.includes('jira')) return 'jira';
    return null;
  }

  function baseDecision(s, now, systemDark) {
    switch (s.mode) {
      case 'on': return true;
      case 'off': return false;
      case 'system': return !!systemDark;
      default: return inWindow(now, s.start, s.end);
    }
  }

  /* Should the theme be applied right now for this site? */
  function shouldApply(s, site, now, systemDark) {
    now = now || new Date();
    if (site && s.sites[site] === false) return false;
    if (s.override && s.override.until > now.getTime()) return !!s.override.active;
    return baseDecision(s, now, systemDark);
  }

  /* Next Date at which shouldApply() may change its answer (null = never). */
  function nextChange(s, now) {
    now = now || new Date();
    let best = null;
    const consider = (d) => { if (d && d > now && (!best || d < best)) best = d; };
    if (s.override && s.override.until > now.getTime()) consider(new Date(s.override.until));
    if (s.mode === 'schedule') consider(nextBoundary(now, s.start, s.end));
    return best;
  }

  /* When a temporary override (pause / force) should expire. */
  function overrideUntil(s, now) {
    now = now || new Date();
    if (s.mode === 'schedule') {
      const b = nextBoundary(now, s.start, s.end);
      if (b) return b.getTime();
    }
    const d = new Date(now);
    d.setHours(24, 0, 0, 0); // next midnight
    return d.getTime();
  }

  function formatTime(d) {
    return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  root.CtpSchedule = {
    DEFAULTS, MODES, normalize, inWindow, nextBoundary, siteOf,
    shouldApply, nextChange, overrideUntil, formatTime
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
