/**
 * Clone, settings merged key by key (PR #1482, design F498 §14.4): the Preview step lists each setting that
 * differs with a Take / Keep choice (a key both machines changed has none until picked), shows the default runtime
 * as a row of its own only when the fleet is not copied, and says so when the review could not be made; Done shows
 * a merge this machine holds as waiting, with its Confirm action, and as copied once confirmed. Phone and desktop,
 * light and dark.
 *
 *   bun harness/clone-merge-screenshot.tsx [outDir]     # writes <outDir>/<state>-<phone|desktop>-<light|dark>.png
 *
 * It renders the REAL `CloneMachine` against two invented machines. No value exists anywhere in it: every setting,
 * name and etag is made up. It fails if any frame scrolls sideways.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out');

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const PAGE_ENTRY = `
import { createRoot } from 'react-dom/client';
import { FyHttpError } from '@ferretry/protocol/client';
import { CloneMachine } from '../../src/features/fleet/setup/clone.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import {
  APPLY_PATH,
  bundle,
  credentials,
  credentialView,
  FRESH_MACHINE,
  machineView,
  STAGED,
} from '../../tests/unit/features/fleet/setup/setup-support.ts';

const AT = '2026-11-05T10:00:00.000Z';
const SCENARIO = new URLSearchParams(location.search).get('scenario') ?? 'review';
const STUDIO = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'd-studio' });
const WORK = daemonConnection({ daemonId: 'work', baseUrl: 'https://work.example.test', deviceId: 'd-work' });
const WORK_RECORD = { ...WORK, label: 'work-linux', pairedAt: 0, lastSelectedAt: 0 };

const BUNDLE = bundle();
const WARDEN_TEXT = 'enabled: true\\ntriage: jev\\n';
const LEARNING_TEXT = 'passive: true\\n';
const VOICE_TEXT = 'provider: groq\\nmodel: tiny\\n';

const file = (path, text) => ({ path, absolutePath: '/home/me/.fy/config/' + path, kind: path.replace('.yaml', ''), schema: path.replace('.yaml', ''), exists: true, text, etag: 'etag-' + path, state: 'ok', issues: [] });
const status = pending => ({ directory: '/home/me/.fy/config', files: [], issues: [], pending, checkedAt: AT });

const WARDEN_KEYS = [
  { key: 'intervalMinutes', outcome: 'both', mine: '5', theirs: '10' },
  { key: 'caps.jevUsdPerDay', outcome: 'theirs', choice: 'take', mine: '1', theirs: '5', loosens: true },
  { key: 'triage', outcome: 'mine', choice: 'keep', mine: 'groq', theirs: 'jev' },
];
const DEFAULT_ROW = { key: 'defaultRuntime', outcome: 'new', choice: 'take', theirs: '"claude-default"' };

const review = call => ({
  mode: 'update',
  source: { name: 'work-linux', verified: 'browser' },
  items: [],
  settings: call.settings.map(document =>
    document.path === 'warden.yaml' ? { path: document.path, keys: WARDEN_KEYS }
      : { path: document.path, keys: document.path === 'controls' ? [DEFAULT_ROW] : [] }),
  logins: [],
  keys: [],
  same: { count: 1, probable: 0 },
  fingerprint: 'a'.repeat(64),
});

let applied = false;
let confirmed = false;
const HELD = { path: 'warden.yaml', etag: 'etag-held', changes: ['the Warden may spend more', 'agents may act alone'] };

const answerFor = machine => (path, init) => {
  const method = init?.method ?? 'GET';
  const isWork = machine === 'work';
  const body = init?.body === undefined ? undefined : JSON.parse(init.body);
  if (path === '/v1/fleet/machine') return isWork ? machineView({ name: 'work-linux', runtimeCount: 3 }) : machineView({ name: 'studio-mac' });
  if (isWork && path === '/v1/fleet/export') return BUNDLE;
  if (isWork && path.startsWith('/v1/config/file')) {
    const name = decodeURIComponent(path.split('=')[1] ?? 'warden.yaml');
    return file(name, name === 'warden.yaml' ? WARDEN_TEXT : name === 'learning.yaml' ? LEARNING_TEXT : VOICE_TEXT);
  }
  if (isWork) throw new Error('the harness has no answer for ' + method + ' ' + path);
  if (path.startsWith('/v1/config/file')) return method === 'GET' ? file(decodeURIComponent(path.split('=')[1] ?? 'warden.yaml'), '# here\\n') : { path: 'x', etag: 'e', outcome: 'applied' };
  if (path === '/v1/fleet/clone/review') {
    if (SCENARIO === 'failed') throw new FyHttpError('the machine could not be reached', 503, 'unavailable');
    return review(body);
  }
  if (path === '/v1/config/status') return status(applied && SCENARIO === 'held' && !confirmed ? [HELD] : []);
  if (path === '/v1/config/confirm') { confirmed = true; return { path: 'warden.yaml', confirmed: true }; }
  if (path === '/v1/fleet/profiles') return { format: 'version-2', profiles: [] };
  if (path === '/v1/speedups') return { vault: 'ok', providers: [] };
  if (path === '/v1/secrets') return { v: 1, health: 'ready', secrets: [], references: [] };
  if (path === '/v1/fleet/proposals') {
    applied = true;
    return STAGED;
  }
  if (path === APPLY_PATH) return { outcome: 'executed', executor: 'clone', summary: 'Copied 3 runtimes from work-linux' };
  if (path === '/v1/fleet/credentials') return credentials([credentialView('claude-work', { clonedFrom: 'work-linux', usedBy: ['claude-default'] })]);
  throw new Error('the harness has no answer for ' + method + ' ' + path);
};

const createClient = async connection => {
  const answer = answerFor(connection.daemonId);
  return { request: async (path, schema, init) => schema.parse(await answer(path, init)) };
};

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <main data-fixture="" style={{ margin: '0 auto', maxWidth: 960, padding: '12px 16px' }}>
    <CloneMachine
      sources={[WORK_RECORD]}
      connection={STUDIO}
      machineName="studio-mac"
      machine={FRESH_MACHINE}
      online
      checking={false}
      onRetry={() => undefined}
      createClient={createClient}
      onDone={() => undefined}
      onLeave={() => undefined}
    />
  </main>,
);
`;

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body { height: auto !important; overflow: visible !important; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/clone-merge-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'clone-merge-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'clone-merge-entry.jsx'), '--outdir', outDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(outDir, 'app.css'),
]);

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    return new Response(Bun.file(join(outDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });

const PHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: PHONE_UA },
  desktop: { viewport: { width: 1280, height: 900 } },
} as const;

const shotsDir = process.argv[2] ?? join(outDir, 'shots');
mkdirSync(shotsDir, { recursive: true });

/** The page from the top of `from` down to the bottom of `to`, so one frame shows the whole story. */
const shot = async (page: Page, state: string, theme: string, vp: string, from: string, to: string): Promise<void> => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) fail(`${state} ${theme} ${vp} scrolls sideways by ${overflow}px`);
  const box = await page.evaluate(
    ([a, b]) => {
      const top = (document.querySelector(a as string) as HTMLElement).getBoundingClientRect();
      const end = document.querySelector(b as string) as HTMLElement;
      const bottom = end.getBoundingClientRect();
      // Whatever follows the frame is hidden (not removed: nothing moves), so the margin below the card is empty
      // and no heading of the next section shows cut in half at the edge of the capture.
      for (let node: HTMLElement | null = end; node !== null && node.id !== 'root'; node = node.parentElement)
        for (let sibling = node.nextElementSibling; sibling !== null; sibling = sibling.nextElementSibling)
          (sibling as HTMLElement).style.visibility = 'hidden';
      const margin = 16;
      return {
        y: top.top + window.scrollY - 8,
        height: bottom.bottom - top.top + 8 + margin,
        width: window.innerWidth,
      };
    },
    [from, to],
  );
  const file = `${state}-${vp}-${theme.endsWith('dark') ? 'dark' : 'light'}.png`;
  await page.screenshot({
    path: join(shotsDir, file),
    fullPage: true,
    clip: { x: 0, y: Math.max(0, box.y), width: box.width, height: box.height },
  });
  process.stdout.write(`📸 ${join(shotsDir, file)}\n`);
};

/** A button a thumb can hit: at least 44px tall, and clear of whatever sits above it. */
const touchSized = async (page: Page, selector: string, what: string): Promise<void> => {
  const height = await page.locator(selector).evaluate(el => el.getBoundingClientRect().height);
  if (height < 44) fail(`${what} is ${height}px tall, under the 44px touch target`);
};

const ITEMS = '[data-setup-choices="clone-items"]';
const SUBMIT = '[data-change-submit]';

const open = async (page: Page, theme: string, scenario: string): Promise<void> => {
  await page.goto(`${server.url}?theme=${theme}&scenario=${scenario}`);
  await page.locator('[data-setup-choice="work"]').waitFor({ state: 'visible' });
  await page.locator('[data-setup-choice="work"]').click();
  await page.locator('[data-step-next]').click();
  await page.locator(ITEMS).waitFor({ state: 'visible' });
};

const walk = async (page: Page, theme: string, vp: string): Promise<void> => {
  // Review made: a key both machines changed has no choice (Copy is off), one that loosens is marked.
  await open(page, theme, 'review');
  await page.locator('[data-clone-key="warden.yaml:intervalMinutes"]').waitFor({ state: 'visible' });
  await shot(page, 'merge-preview', theme, vp, ITEMS, '[data-setup-note="settings-undecided"]');

  // Fleet unticked: the default runtime is a row of its own.
  await page.locator(`${ITEMS} [data-setup-choice="fleet"]`).click();
  await page.locator('[data-clone-key="controls:defaultRuntime"]').waitFor({ state: 'visible' });
  await shot(page, 'merge-default-runtime-row', theme, vp, ITEMS, '[data-clone-key="controls:defaultRuntime"]');

  // The review could not be made: Copy is blocked and Check again is offered.
  await open(page, theme, 'failed');
  await page.locator('[data-clone-review-retry]').waitFor({ state: 'visible' });
  await touchSized(page, '[data-clone-review-retry]', 'Check again');
  await shot(page, 'review-failed', theme, vp, ITEMS, '[data-setup-note="settings-undecided"]');

  // A merge this machine holds: shown as waiting with its Confirm, then as copied.
  await open(page, theme, 'held');
  await page.locator('[data-clone-key="warden.yaml:intervalMinutes"] label').first().click();
  await page.locator(SUBMIT).evaluate(el => (el as HTMLButtonElement).click());
  await page.locator('[data-clone-step="done"]').waitFor({ state: 'visible' });
  await page.locator('[data-clone-confirm="warden.yaml"]').waitFor({ state: 'visible' });
  await touchSized(page, '[data-clone-confirm="warden.yaml"]', 'Confirm');
  await shot(page, 'held-merge', theme, vp, '[data-clone-step="done"]', '[data-clone-step="done"]');
  await page.locator('[data-clone-confirm="warden.yaml"]').click();
  await page.locator('[data-clone-outcome="warden"][data-outcome="copied"]').waitFor({ state: 'visible' });
  await shot(page, 'held-merge-confirmed', theme, vp, '[data-clone-step="done"]', '[data-clone-step="done"]');
};

try {
  for (const theme of ['studio-light', 'studio-dark'] as const) {
    for (const [vp, options] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({
        ...options,
        deviceScaleFactor: vp === 'phone' ? 2 : 1,
        colorScheme: theme.endsWith('dark') ? 'dark' : 'light',
      });
      try {
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin !== server.url.origin ? await route.abort() : await route.continue(),
        );
        const page = await context.newPage();
        page.on('pageerror', error => fail(`the page threw: ${error.message}`));
        await walk(page, theme, vp);
        await page.close();
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write('✅ Clone settings merge does not scroll sideways at 390px\n');
} finally {
  await browser.close();
  server.stop();
}
