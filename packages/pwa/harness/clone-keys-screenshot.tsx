/**
 * Clone, with API keys and sign-ins (docs/secrets.md, owner decision 2026-10-20): the Preview step lists
 * a GLM API-key login as "Copies with its key", a Claude Code and a Codex sign-in as "Sign in on <machine>",
 * and the one sealed key copy as a ticked box; Done then offers a Sign in button per login. Phone and
 * desktop, light and dark.
 *
 *   bun harness/clone-keys-screenshot.tsx      # writes harness/out/clone-keys-*.png
 *
 * It renders the REAL `CloneMachine` against two invented machines. No value exists anywhere in it: the
 * fake machines answer names, a fake offer and a fake bundle. It fails if any frame scrolls sideways.
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
import { CloneMachine } from '../../src/features/fleet/setup/clone.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import {
  APPLY_PATH,
  bundle,
  credentials,
  credentialView,
  FRESH_MACHINE,
  machineAnswer,
  machineView,
  STAGED,
} from '../../tests/unit/features/fleet/setup/setup-support.ts';

const AT = '2026-10-20T10:00:00.000Z';
const STUDIO = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'd-studio' });
const WORK = daemonConnection({ daemonId: 'work', baseUrl: 'https://work.example.test', deviceId: 'd-work' });
const WORK_RECORD = { ...WORK, label: 'work-linux', pairedAt: 0, lastSelectedAt: 0 };

const IMPORT_ID = 'fy_secret_import_' + 'a'.repeat(22);
const SOURCE_ID = 'fy_daemon_' + 'S'.repeat(43);
const OFFER = { v: 1, importId: IMPORT_ID, daemonId: 'fy_daemon_' + 'T'.repeat(43), identityKey: 'aWQ', publicKey: 'cHVi', expiresAt: AT, signature: 'c2ln' };

const BUNDLE = bundle({
  credentials: [
    { id: 'glm-env', harness: 'claude', label: 'GLM', store: 'environment', preset: 'zai-glm',
      env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: '\${secret:ZAI_API_KEY}' } },
    { id: 'claude-work', harness: 'claude', email: 'me@work.example' },
    { id: 'codex-work', harness: 'codex', label: 'Work' },
  ],
  components: { instructions: { default: { file: 'components/instructions/default.md' } } },
  files: [{ path: 'components/instructions/default.md', content: 'Be kind and concise.\\n' }],
  runtimes: {
    'glm-default': { credential: 'glm-env', profile: 'default' },
    'claude-default': { credential: 'claude-work', profile: 'default' },
    'codex-default': { credential: 'codex-work', profile: 'default' },
  },
});

const file = path => ({ path, absolutePath: '/home/me/.fy/config/' + path, kind: path.replace('.yaml', ''), schema: path.replace('.yaml', ''), exists: false, text: '', etag: 'etag-' + path, state: 'ok', issues: [] });
const secrets = names => ({ v: 1, health: 'ready', secrets: names.map(name => ({ name, createdAt: AT, updatedAt: AT })), references: [] });

let copied = false;
let imported = false;
const held = [];

const SLOTS = () => credentials([
  credentialView('claude-work', { clonedFrom: 'work-linux', usedBy: ['claude-default'], email: 'me@work.example' }),
  credentialView('codex-work', { harness: 'codex', clonedFrom: 'work-linux', email: undefined, label: 'Work', usedBy: ['codex-default'] }),
]);

const answerFor = machine => (path, init) => {
  const method = init?.method ?? 'GET';
  const isWork = machine === 'work';
  if (path === '/v1/fleet/machine') return isWork ? machineView({ name: 'work-linux', runtimeCount: 3 }) : machineAnswer();
  if (path.startsWith('/v1/config/file')) return method === 'GET' ? file(decodeURIComponent(path.split('=')[1] ?? 'warden.yaml')) : { path: 'x', etag: 'e', outcome: 'applied' };
  if (path === '/v1/secrets') return secrets(isWork ? ['ZAI_API_KEY', 'GITHUB_TOKEN'] : held);
  if (isWork && path === '/v1/fleet/export') return BUNDLE;
  if (isWork && path.startsWith('/v1/secrets/exports/'))
    return { bundle: { v: 1, importId: IMPORT_ID, sourceDaemonId: SOURCE_ID, targetDaemonId: OFFER.daemonId, expiresAt: AT, names: ['ZAI_API_KEY'], ephemeralKey: 'ZXBo', nonce: 'bm9uY2U', ciphertext: 'Y2lwaGVy' }, names: ['ZAI_API_KEY'] };
  if (!isWork) {
    if (path === '/v1/fleet/profiles') return { format: 'version-2', profiles: [] };
    if (path === '/v1/speedups') return { vault: 'ok', providers: [] };
    if (path === '/v1/fleet/proposals') return STAGED;
    if (path === APPLY_PATH) { copied = true; return { outcome: 'executed', executor: 'clone', summary: 'Copied 3 runtimes from work-linux' }; }
    if (path === '/v1/fleet/credentials') return copied ? SLOTS() : credentials([]);
    if (path === '/v1/secrets/imports') return OFFER;
    if (path.startsWith('/v1/secrets/imports/')) { held.push('ZAI_API_KEY'); imported = true; return { importId: IMPORT_ID, sourceDaemonId: SOURCE_ID, imported: ['ZAI_API_KEY'], replaced: [] }; }
  }
  throw new Error('the harness has no answer for ' + method + ' ' + path);
};

const createClient = async connection => {
  const answer = answerFor(connection.daemonId);
  return { request: async (path, schema, init) => schema.parse(answer(path, init)) };
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/clone-keys-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'clone-keys-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'clone-keys-entry.jsx'), '--outdir', outDir, '--target', 'browser']);
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
  desktop: { viewport: { width: 1440, height: 900 } },
} as const;

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
  const file = `clone-keys-${name}-${theme}-${vp}.png`;
  await page.screenshot({
    path: join(outDir, file),
    fullPage: true,
    clip: { x: 0, y: Math.max(0, box.y), width: box.width, height: box.height },
  });
  process.stdout.write(`📸 ${join(outDir, file)}\n`);
};

const walk = async (page: Page, theme: string, vp: string): Promise<void> => {
  await page.goto(`${server.url}?theme=${theme}`);
  await page.locator('[data-setup-choice="work"]').waitFor({ state: 'visible' });
  await page.locator('[data-setup-choice="work"]').click();
  await page.locator('[data-step-next]').click();
  await page.locator('[data-setup-section="clone-logins"]').waitFor({ state: 'visible' });
  await shot(page, 'preview', theme, vp, '[data-setup-section="clone-logins"]', '[data-setup-section="not-copied"]');
  await page.locator('[data-change-submit]').click();
  await page.locator('[data-clone-step="done"]').waitFor({ state: 'visible' });
  await page.locator('[data-clone-slot="claude-work"]').waitFor({ state: 'visible' });
  await shot(page, 'done', theme, vp, '[data-setup-section="clone-outcomes"]', '[data-setup-section="slots"]');
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
  process.stdout.write('✅ Clone with keys and sign-ins does not scroll sideways at 390px\n');
} finally {
  await browser.close();
  server.stop();
}
