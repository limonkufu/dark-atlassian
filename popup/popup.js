(() => {
  'use strict';
  const S = globalThis.CtpSchedule;
  const $ = (id) => document.getElementById(id);
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  let settings = S.normalize(null);

  async function load() {
    const { settings: raw } = await chrome.storage.sync.get('settings');
    settings = S.normalize(raw);
    render();
  }

  async function save() {
    settings = S.normalize(settings);
    await chrome.storage.sync.set({ settings });
    render();
  }

  function describe() {
    const now = new Date();
    const dark = S.shouldApply(settings, null, now, mql.matches);
    const next = S.nextChange(settings, now);
    const until = next ? ` until ${S.formatTime(next)}` : '';
    if (settings.override) return `${dark ? 'On' : 'Off'} (temporary)${until}`;
    switch (settings.mode) {
      case 'on': return 'On all the time';
      case 'off': return 'Off';
      case 'system': return dark ? 'On (system is dark)' : 'Off (system is light)';
      default: return dark ? `On${until}` : `Off${until}`;
    }
  }

  function render() {
    const dark = S.shouldApply(settings, null, new Date(), mql.matches);
    $('dot').className = 'dot ' + (dark ? 'on' : 'off');
    $('status').textContent = describe();
    document.querySelectorAll('input[name="mode"]').forEach(r => { r.checked = r.value === settings.mode; });
    $('scheduleBox').hidden = settings.mode !== 'schedule';
    $('start').value = settings.start;
    $('end').value = settings.end;
    $('siteConfluence').checked = settings.sites.confluence !== false;
    $('siteJira').checked = settings.sites.jira !== false;

    const btn = $('override');
    if (settings.mode === 'on' || settings.mode === 'off') {
      btn.hidden = true;
    } else {
      btn.hidden = false;
      if (settings.override) {
        btn.textContent = 'Back to ' + (settings.mode === 'schedule' ? 'schedule' : 'system setting');
      } else {
        const until = S.formatTime(S.overrideUntil(settings));
        btn.textContent = (dark ? 'Turn off' : 'Turn on') + ' until ' + until;
      }
    }
  }

  document.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener('change', () => {
    settings.mode = r.value;
    settings.override = null;
    save();
  }));
  $('start').addEventListener('change', () => { if ($('start').value) { settings.start = $('start').value; settings.override = null; save(); } });
  $('end').addEventListener('change', () => { if ($('end').value) { settings.end = $('end').value; settings.override = null; save(); } });
  $('siteConfluence').addEventListener('change', () => { settings.sites.confluence = $('siteConfluence').checked; save(); });
  $('siteJira').addEventListener('change', () => { settings.sites.jira = $('siteJira').checked; save(); });
  $('override').addEventListener('click', () => {
    if (settings.override) settings.override = null;
    else {
      const now = new Date();
      const dark = S.shouldApply(settings, null, now, mql.matches);
      settings.override = { active: !dark, until: S.overrideUntil(settings, now) };
    }
    save();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) { settings = S.normalize(changes.settings.newValue); render(); }
  });
  mql.addEventListener('change', render);
  setInterval(render, 30000);
  load();
})();
