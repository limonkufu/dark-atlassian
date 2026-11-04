/* Local browser regression checks; all requests are fulfilled with fixtures.
 * Run: node scripts/test-theme.js (requires Node.js, npx and Chrome).
 * Uses Playwright CLI, without a server or access to the live Atlassian sites. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

async function checkTheme(page, files) {
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const results = [];
  const fixture = mode => `<!doctype html><html data-theme="light:light dark:dark" ${mode ? `data-color-mode="${mode}"` : ''}><head><style>
    html[data-color-mode="dark"][data-theme] { --ds-surface: #1d2125; --ds-text: #b6c2cf; --ds-text-inverse: #161a1d; --ds-text-danger: #f87168; --ds-background-brand-bold: #579dff; }
    body { background: white; color: black; }
    html[data-color-mode="dark"] body { background: var(--ds-surface); color: var(--ds-text); }
    .aui-button { padding: 7px 13px; background: var(--aui-button-default-bg-color, #eee); color: var(--aui-button-default-text-color, #333); }
    .aui-button-primary { background: var(--ds-background-brand-bold, #0052cc); color: var(--ds-text-inverse, white); }
    .semantic-danger { color: var(--ds-text-danger, #de350b); }
    .plugin { background-color: #fff; color: #222; border: 1px solid #ddd; }
  </style></head><body>
    <h1>Theme regression fixture</h1>
    <a href="#" id="primary" class="aui-button aui-button-primary">Create</a>
    <span id="danger" class="semantic-danger">Danger</span>
    <div id="plugin" class="plugin">Legacy plugin</div>
    <div id="inline" style="background-color: white; color: black">Inline legacy content</div>
    <div id="overlay" style="background-color: rgba(0, 0, 0, 0.35)">Native overlay</div>
    <svg><path id="chart" style="fill: rgb(0, 100, 0); stroke: rgb(0, 80, 120)" d="M0 0L20 20"/></svg>
    <span id="inprogress" class="jira-issue-status-lozenge jira-issue-status-lozenge-inprogress">In progress</span>
    <span id="done" class="jira-issue-status-lozenge jira-issue-status-lozenge-success">Done</span>
    <button id="opsbar-transitions_more" class="opsbar-transitions__status-category_indeterminate">In progress</button>
    <section id="story.burn-up"><div class="mod-content"><div style="background-color: white; color: black"><table><tr><td>Story Burn-up</td></tr></table><progress value="1" max="2"></progress></div></div></section>
    <div class="user-content-block"><blockquote><font id="quote" color="#000000">Quoted text</font><a href="#"><font id="quote-link" color="#000000">Quoted link</font></a></blockquote></div>
    <iframe id="legacy-frame" srcdoc="<!doctype html><html><head><style>.plugin { background-color: white; color: black; }</style></head><body contenteditable='true'><p class='plugin' style='background-color: white; color: black'>Editor content</p></body></html>"></iframe>
    <iframe id="native-frame" srcdoc="<!doctype html><html data-color-mode='dark' data-theme='light:light dark:dark'><head></head><body><div style='background-color: rgba(0, 0, 0, 0.35)'>Native gadget</div></body></html>"></iframe>
  </body></html>`;

  await page.route('https://extension.test/**', route => {
    const file = new URL(route.request().url()).pathname.slice(1);
    return route.fulfill({ contentType: 'text/css', body: files[file] || '' });
  });
  await page.route(/^https:\/\/(jira|confluence)\.skatelescope\.org\//, route => {
    const mode = new URL(route.request().url()).searchParams.get('mode');
    return route.fulfill({ contentType: 'text/html', body: fixture(mode) });
  });

  const inject = async target => {
    await target.evaluate(version => {
      const listeners = [];
      window.chrome = {
        runtime: {
          getManifest: () => ({ version }), getURL: file => 'https://extension.test/' + file,
          onMessage: { addListener() {} }
        },
        storage: {
          sync: { get: async () => ({ settings: { mode: 'on' } }) },
          local: { get: async () => ({ cacheBuster: 'fixture' }) },
          onChanged: { addListener: listener => listeners.push(listener) }
        }
      };
      window.setThemeSettings = settings => listeners.forEach(fn => fn({ settings: { newValue: settings } }, 'sync'));
    }, JSON.parse(files['manifest.json']).version);
    await target.addScriptTag({ content: files['src/schedule.js'] });
    await target.addScriptTag({ content: files['src/content.js'] });
    await target.waitForFunction(() => document.getElementById('ctp-mocha-theme'));
  };
  const css = (selector, property) => page.$eval(selector, (el, prop) => getComputedStyle(el).getPropertyValue(prop), property);
  const generated = () => page.locator('style[data-ctp-dyn], #ctp-mocha-inline').count();
  const setMode = mode => page.evaluate(value => document.documentElement.setAttribute('data-color-mode', value), mode);
  const waitFallback = () => page.waitForFunction(() =>
    !document.documentElement.hasAttribute('data-ctp-native-dark') &&
    document.querySelector('style[data-ctp-dyn]') && document.getElementById('ctp-mocha-inline'));
  const contrast = (first, second) => {
    const luminance = color => {
      const rgb = color.startsWith('color(srgb') ? color.match(/[\d.]+/g).map(Number) : color.match(/[\d.]+/g).slice(0, 3).map(x => +x / 255);
      return rgb.map(x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4).reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i], 0);
    };
    const a = luminance(first), b = luminance(second);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };

  await page.goto('https://jira.skatelescope.org/fixture?mode=dark');
  await inject(page);
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-ctp-native-dark'));
  check(await generated() === 0, 'Native dark must skip automatic colour conversion');
  check(await css('body', 'background-color') === 'rgb(30, 30, 46)', 'Native surface must use Mocha');
  check(await css('#primary', 'color') === 'rgb(17, 17, 27)', 'Native primary link must preserve inverse text');
  check(await css('#primary', 'padding') === '7px 13px', 'Native component geometry must be preserved');
  check(await css('#danger', 'color') === 'rgb(243, 139, 168)', 'Native semantic danger token must use Mocha red');
  check(await css('#overlay', 'background-color') === 'rgba(0, 0, 0, 0.35)', 'Native overlay must not be inverted');
  check(await css('#chart', 'fill') === 'rgb(0, 100, 0)', 'Chart series must not be rewritten');
  check(await css('#quote-link', 'color') === 'rgb(137, 180, 250)', 'Quoted links must remain readable');
  check(await css('[id="story.burn-up"] .mod-content > div', 'background-color') === 'rgb(30, 30, 46)', 'Burn-up plugin must remain dark');
  for (const selector of ['#inprogress', '#done', '#opsbar-transitions_more']) {
    const ratio = contrast(await css(selector, 'color'), await css(selector, 'background-color'));
    check(ratio >= 4.5, `${selector} contrast too low: ${ratio}`);
  }
  results.push('Native palette, component semantics, chart colours, status contrast and plugin fixes');

  const legacy = page.frames().find(frame => frame !== page.mainFrame() && frame.url() === 'about:srcdoc');
  await legacy.waitForFunction(() => document.getElementById('ctp-mocha-inline'));
  const savedBody = await legacy.locator('body').innerHTML();
  check(!savedBody.includes('data-ctp'), 'Editor body must not contain theme styles');
  check(await legacy.locator('p').getAttribute('style') === 'background-color: white; color: black', 'Editor inline content must be unchanged');
  check(await legacy.$eval('p', el => getComputedStyle(el).backgroundColor) !== 'rgb(255, 255, 255)', 'Legacy editor must use fallback under native parent');
  const nativeFrame = page.frames().filter(frame => frame.url() === 'about:srcdoc')[1];
  check(await nativeFrame.locator('html[data-ctp-native-dark]').count() === 1, 'Native frame must be detected independently');
  check(await nativeFrame.locator('style[data-ctp-dyn], #ctp-mocha-inline').count() === 0, 'Native frame must skip conversion');
  await legacy.evaluate(() => document.documentElement.setAttribute('data-color-mode', 'dark'));
  await legacy.waitForFunction(() => document.documentElement.hasAttribute('data-ctp-native-dark') && !document.getElementById('ctp-mocha-inline'));
  await legacy.evaluate(() => document.documentElement.removeAttribute('data-color-mode'));
  await legacy.waitForFunction(() => document.getElementById('ctp-mocha-inline'));
  check(await legacy.locator('body').innerHTML() === savedBody, 'Frame mode changes must preserve editor body');
  results.push('Parent-managed native/legacy frames and editor serialization');

  await setMode('light');
  await waitFallback();
  check(await css('#plugin', 'background-color') !== 'rgb(255, 255, 255)', 'Light plugin stylesheet must be converted');
  check(await css('#inline', 'background-color') !== 'rgb(255, 255, 255)', 'Light inline background must be converted');
  check(await page.locator('html').getAttribute('data-theme') === 'light:light dark:dark', 'Available dark theme must not be confused with active mode');
  await setMode('dark');
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-ctp-native-dark') && !document.querySelector('style[data-ctp-dyn], #ctp-mocha-inline'));
  await setMode('light');
  await waitFallback();
  results.push('Repeated native/light switching and conversion cache restoration');

  await page.evaluate(() => window.setThemeSettings({ mode: 'off' }));
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-ctp-mocha'));
  check(await page.locator('style[data-ctp]').count() === 0, 'Off must remove all top-level theme styles');
  await page.evaluate(() => window.setThemeSettings({ mode: 'on' }));
  await waitFallback();
  check(await css('#inline', 'background-color') !== 'rgb(255, 255, 255)', 'Off/on must restore cached inline rules');
  await setMode('dark');
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-ctp-native-dark'));
  await page.evaluate(() => window.setThemeSettings({ mode: 'off' }));
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-ctp-mocha'));
  check(await css('body', 'background-color') === 'rgb(29, 33, 37)', 'Off must restore native Jira dark');
  check(await page.locator('html').getAttribute('data-color-mode') === 'dark', 'Jira appearance must not be changed');
  check(await legacy.locator('body').innerHTML() === savedBody, 'Off/on must preserve editor content');
  await page.evaluate(() => window.setThemeSettings({ mode: 'on', sites: { jira: false } }));
  check(await page.locator('html[data-ctp-mocha]').count() === 0, 'Site opt-out must be respected');
  results.push('Off/on, native appearance restoration and site opt-out');

  await page.evaluate(() => window.setThemeSettings({ mode: 'on' }));
  await inject(legacy); // frame now claims its own document, like all_frames injection
  await legacy.evaluate(() => document.documentElement.setAttribute('data-color-mode', 'dark'));
  await legacy.waitForFunction(() => document.documentElement.hasAttribute('data-ctp-native-dark'));
  await legacy.evaluate(() => { document.open(); document.write('<html><head></head><body contenteditable="true"><p style="background-color: white; color: black">Rewritten editor</p></body></html>'); document.close(); });
  await legacy.waitForFunction(() => document.documentElement.hasAttribute('data-ctp-frame') && document.documentElement.hasAttribute('data-ctp-mocha') && !document.documentElement.hasAttribute('data-ctp-native-dark') && document.getElementById('ctp-mocha-theme'));
  check(await legacy.locator('body style[data-ctp]').count() === 0, 'Rewritten editor styles must remain in head');
  results.push('Self-managed frame mode changes and document.write recovery');

  await page.goto('https://jira.skatelescope.org/fixture');
  await inject(page);
  await waitFallback();
  check(await css('#plugin', 'background-color') !== 'rgb(255, 255, 255)', 'Original Jira mode must retain fallback');
  results.push('Original Jira theme fallback');

  await page.goto('https://confluence.skatelescope.org/fixture?mode=dark');
  await inject(page);
  await waitFallback();
  check(await css('#plugin', 'background-color') !== 'rgb(255, 255, 255)', 'Confluence must retain full conversion');
  check(await page.locator('html[data-ctp-native-dark]').count() === 0, 'Jira native mode must not affect Confluence');
  results.push('Confluence legacy theme isolation');
  check(failures.length === 0, `Browser errors: ${failures.join('; ')}`);
  await page.evaluate(value => { window.themeCheckResults = value; }, results);
}

const root = path.resolve(__dirname, '..');
const files = Object.fromEntries(['manifest.json', 'src/schedule.js', 'src/content.js',
  ...fs.readdirSync(path.join(root, 'styles')).filter(file => file.endsWith('.css')).map(file => 'styles/' + file)]
  .map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dark-atlassian-test-'));
const session = 'dark-atlassian-' + process.pid;
function cli(...args) {
  const result = spawnSync('npx', ['--yes', '--package', '@playwright/cli', 'playwright-cli', '-s=' + session, ...args],
    { cwd: tmp, env: { ...process.env, PWTEST_DAEMON_SESSION_DIR: path.join(tmp, 'daemon') },
      encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0 || result.error || result.stdout.includes('### Error')) {
    throw new Error((result.stdout + result.stderr).slice(0, 4000) || String(result.error));
  }
  return result.stdout;
}
try {
  const filename = path.join(tmp, 'checks.js');
  fs.writeFileSync(filename, `async (page) => { await (${checkTheme.toString()})(page, ${JSON.stringify(files)}); }`);
  cli('open', 'about:blank');
  cli('run-code', '--filename', filename);
  process.stdout.write(cli('eval', '() => window.themeCheckResults'));
} finally {
  try { cli('close'); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
