/* Service worker: keeps the toolbar badge in sync, fires an alarm at the next
 * scheduled change, and relays "recheck" to open Confluence/Jira tabs. */
importScripts('schedule.js');

const S = globalThis.CtpSchedule;
const HOSTS = ['https://confluence.skatelescope.org/*', 'https://jira.skatelescope.org/*'];
const ALARM_NEXT = 'ctp-next-change';
const ALARM_HEARTBEAT = 'ctp-heartbeat';

async function getSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  return S.normalize(settings);
}

async function saveSettings(settings) {
  await chrome.storage.sync.set({ settings });
}

async function updateBadge(settings) {
  let text = '', color = '#45475a';
  if (settings.mode === 'system') { text = 'SYS'; color = '#585b70'; }
  else if (S.shouldApply(settings, null, new Date(), false)) { text = 'ON'; color = '#a6e3a1'; }
  else { text = 'OFF'; color = '#45475a'; }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  try { await chrome.action.setBadgeTextColor({ color: '#11111b' }); } catch (_) { /* older Chrome */ }
}

async function notifyTabs(message) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: HOSTS }); } catch (_) { return; }
  await Promise.all(tabs.map(t => chrome.tabs.sendMessage(t.id, message).catch(() => {})));
}

async function refresh() {
  const settings = await getSettings();
  await updateBadge(settings);
  await chrome.alarms.clear(ALARM_NEXT);
  const next = S.nextChange(settings);
  if (next) chrome.alarms.create(ALARM_NEXT, { when: next.getTime() + 1500 });
  await notifyTabs({ type: 'ctp:recheck' });
}

/* Drop an expired override so storage stays tidy. */
async function expireOverride() {
  const { settings: raw } = await chrome.storage.sync.get('settings');
  const clean = S.normalize(raw);
  if (raw && raw.override && !clean.override) await saveSettings(clean);
}

/* Toggle used by the keyboard shortcut when no themed tab is focused. */
async function toggleFromWorker() {
  const s = await getSettings();
  const now = new Date();
  if (s.mode === 'on') s.mode = 'off';
  else if (s.mode === 'off') s.mode = 'on';
  else {
    const current = S.shouldApply(s, null, now, false);
    s.override = { active: !current, until: S.overrideUntil(s, now) };
  }
  await saveSettings(s);
}

chrome.runtime.onInstalled.addListener(async () => {
  await saveSettings(await getSettings());
  await chrome.storage.local.set({ cacheBuster: Date.now() });
  chrome.alarms.create(ALARM_HEARTBEAT, { periodInMinutes: 15 });
  refresh();
});

chrome.runtime.onStartup.addListener(refresh);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NEXT) await expireOverride();
  refresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.settings) refresh();
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-theme') return;
  // Prefer letting the focused themed tab decide (it knows the OS colour scheme).
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: HOSTS });
    if (tab) {
      await chrome.tabs.sendMessage(tab.id, { type: 'ctp:toggle' });
      return;
    }
  } catch (_) { /* fall through */ }
  await toggleFromWorker();
});
