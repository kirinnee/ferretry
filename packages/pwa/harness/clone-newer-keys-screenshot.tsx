/**
 * Clone and a key that is NEWER on the source (docs/secrets.md): the Preview step reports "A newer X exists on
 * <source>" with the `fy secret set X` command to run here, says so when this machine changed the key too, and
 * leaves a plain missing key copying as it always did. The secret copy panel shows a key this machine already
 * holds as "kept". Phone and desktop, light and dark.
 *
 *   bun harness/clone-newer-keys-screenshot.tsx      # writes harness/out/clone-newer-keys-*.png
 *   SHOTS_DIR=<dir> bun harness/clone-newer-keys-screenshot.tsx
 *
 * It renders the REAL `CloneMachine`, `CloneNeedsList` and `SecretCopyLauncher` against invented machines. No
 * value exists anywhere in it: the fake machines answer names, instants, a fake review and a fake offer. It fails
 * if any frame scrolls sideways.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out');
const shotsDir = process.env.SHOTS_DIR ?? outDir;

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
import { CloneMachine } from '../../src/features/fleet/setup/clone.tsx';
import { SecretCopyLauncher } from '../../src/features/secrets/secret-copy-panel.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import {
  bundle,
  credentials,
  FRESH_MACHINE,
  machineAnswer,
  machineView,
  STAGED,
} from '../../tests/unit/features/fleet/setup/setup-support.ts';

const AT = '2026-10-20T10:00:00.000Z';
const LATER = '2026-11-02T09:30:00.000Z';
const STUDIO = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'd-studio' });
const WORK = daemonConnection({ daemonId: 'work', baseUrl: 'https://work.example.test', deviceId: 'd-work' });
const WORK_RECORD = { ...WORK, label: 'work-linux', pairedAt: 0, lastSelectedAt: 0 };
const NAMES = { studio: 'studio-mac', work: 'work-linux' };
const machineName = machine => NAMES[machine.daemonId] ?? machine.baseUrl;

const params = new URLSearchParams(location.search);
// missing | newer | both — how DEMO_API_KEY stands against the source.
const STATE = params.get('state') ?? 'missing';
const VIEW = params.get('view') ?? 'clone';

const SOURCE_KEYS = ['DEMO_API_KEY', 'DEMO_SERVICE_TOKEN'];
// This machine already holds the key in the two "newer" states; in "missing" it holds nothing.
const HELD_HERE = STATE === 'missing' ? [] : ['DEMO_API_KEY'];

const BUNDLE = bundle({
  credentials: [
    { id: 'demo-env', harness: 'claude', label: 'Demo', store: 'environment', preset: 'zai-glm',
      env: { ANTHROPIC_BASE_URL: 'https://api.demo.example.test/anthropic', ANTHROPIC_AUTH_TOKEN: '\${secret:DEMO_API_KEY}' } },
  ],
  components: { instructions: { default: { file: 'components/instructions/default.md' } } },
  files: [{ path: 'components/instructions/default.md', content: 'Be kind and concise.\\n' }],
  runtimes: { 'demo-default': { credential: 'demo-env', profile: 'default' } },
});

const file = path => ({ path, absolutePath: '/home/me/.fy/config/' + path, kind: path.replace('.yaml', ''), schema: path.replace('.yaml', ''), exists: false, text: '', etag: 'etag-' + path, state: 'ok', issues: [] });
const secrets = (names, updatedAt) => ({ v: 1, health: 'ready', secrets: names.map(name => ({ name, createdAt: AT, updatedAt })), references: [] });

const REVIEW = {
  mode: STATE === 'missing' ? 'first' : 'update',
  source: { name: 'work-linux', ...(STATE === 'missing' ? {} : { lastCopiedAt: AT }), verified: 'browser' },
  items: [],
  settings: [],
  logins: [],
  keys: [{ name: 'DEMO_API_KEY', outcome: STATE === 'missing' ? 'missing' : STATE }],
  same: { count: 0, probable: 0 },
  fingerprint: 'review-fingerprint',
};

const answerFor = machine => (path, init) => {
  const method = init?.method ?? 'GET';
  const isWork = machine === 'work';
  if (path === '/v1/fleet/machine') return isWork ? machineView({ name: 'work-linux', runtimeCount: 1 }) : machineAnswer();
  if (path.startsWith('/v1/config/file')) return method === 'GET' ? file(decodeURIComponent(path.split('=')[1] ?? 'warden.yaml')) : { path: 'x', etag: 'e', outcome: 'applied' };
  if (path === '/v1/secrets') return isWork ? secrets(SOURCE_KEYS, STATE === 'missing' ? AT : LATER) : { ...secrets(HELD_HERE, AT), references: [] };
  if (isWork && path === '/v1/fleet/export') return BUNDLE;
  if (!isWork) {
    if (path === '/v1/fleet/profiles') return { format: 'version-2', profiles: [] };
    if (path === '/v1/speedups') return { vault: 'ok', providers: [] };
    if (path === '/v1/fleet/proposals') return STAGED;
    if (path === '/v1/fleet/credentials') return credentials([]);
    if (path === '/v1/fleet/clone/review') return REVIEW;
  }
  throw new Error('the harness has no answer for ' + method + ' ' + path);
};

const createClient = async connection => {
  const answer = answerFor(connection.daemonId);
  return { request: async (path, schema, init) => schema.parse(answer(path, init)) };
};

// The secret copy panel, from the new machine's side: the source's names, and what this machine already holds.
const PANEL_SOURCE = daemonConnection({ daemonId: 'work', baseUrl: 'https://work.example.test', deviceId: 'd-work', daemonName: 'work-linux' });
const PANEL_HERE = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'd-studio', daemonName: 'studio-mac' });

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <main data-fixture="" style={{ margin: '0 auto', maxWidth: 960, padding: '12px 16px' }}>
    {VIEW === 'panel' ? (
      <SecretCopyLauncher
        label="Copy secrets from work-linux…"
        direction="from"
        here={PANEL_HERE}
        others={[PANEL_SOURCE]}
        createClient={createClient}
        machineName={machineName}
        preselect={SOURCE_KEYS}
      />
    ) : (
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
    )}
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/clone-newer-keys-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });
await Bun.write(join(outDir, 'clone-newer-keys-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'clone-newer-keys-entry.jsx'), '--outdir', outDir, '--target', 'browser']);
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

const STATES = [
  { state: 'newer', name: 'newer-key' },
  { state: 'both', name: 'both-changed' },
  { state: 'missing', name: 'missing-key' },
] as const;

/** The page from `from` down to the bottom of `to`, so one frame shows the whole story. */
const shot = async (page: Page, name: string, theme: string, vp: string, from: string, to: string): Promise<void> => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) fail(`${name} ${theme} ${vp} scrolls sideways by ${overflow}px`);
  const box = await page.evaluate(
    ([a, b]) => {
      const top = (document.querySelector(a as string) as HTMLElement).getBoundingClientRect();
      const bottom = (document.querySelector(b as string) as HTMLElement).getBoundingClientRect();
      return { y: top.top + window.scrollY - 8, height: bottom.bottom - top.top + 16, width: window.innerWidth };
    },
    [from, to],
  );
  const file = `${name}-${vp}-${theme.replace('studio-', '')}.png`;
  await page.screenshot({
    path: join(shotsDir, file),
    fullPage: true,
    clip: { x: 0, y: Math.max(0, box.y), width: box.width, height: box.height },
  });
  process.stdout.write(`📸 ${join(shotsDir, file)}\n`);
};

const walk = async (page: Page, theme: string, vp: string): Promise<void> => {
  for (const { state, name } of STATES) {
    await page.goto(`${server.url}?theme=${theme}&state=${state}`);
    await page.locator('[data-setup-choice="work"]').waitFor({ state: 'visible' });
    await page.locator('[data-setup-choice="work"]').click();
    await page.locator('[data-step-next]').click();
    await page.locator('[data-setup-section="clone-logins"]').waitFor({ state: 'visible' });
    if (state !== 'missing') await page.locator('[data-clone-newer-key="DEMO_API_KEY"]').waitFor({ state: 'visible' });
    await shot(page, name, theme, vp, '[data-setup-section="clone-logins"]', '[data-setup-section="not-copied"]');
  }
  for (const { state, name } of STATES.filter(each => each.state !== 'both')) {
    await page.goto(`${server.url}?theme=${theme}&state=${state}&view=panel`);
    await page.locator('[data-secret-copy-launch]').click();
    await page.locator('[data-secret-copy-row="DEMO_API_KEY"]').waitFor({ state: 'visible' });
    await shot(page, `${name}-panel`, theme, vp, '[data-secret-copy]', '[data-secret-copy]');
  }
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
  process.stdout.write('✅ Clone with newer keys does not scroll sideways at 390px\n');
} finally {
  await browser.close();
  server.stop();
}
