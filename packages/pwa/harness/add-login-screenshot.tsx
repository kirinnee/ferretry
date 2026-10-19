/**
 * Settings › Machines › Credentials › **Add a login**: the one screen that picks a provider and asks only
 * for what that provider needs — a Claude Code sign-in with its link, an API-key provider with its key, and
 * the same provider refused — on a phone and a desktop, light and dark.
 *
 *   bun harness/add-login-screenshot.tsx      # writes harness/out/add-login-*.png
 *
 * It renders the REAL `CredentialsTab` against a fake machine (the suites' own fixtures: an invented
 * machine, invented providers and a fake sign-in link). No key is real and none is shown: the key field is
 * a password field filled with a fixed placeholder. It fails if any frame scrolls sideways.
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
import { CredentialsTab } from '../../src/features/fleet/credentials/credentials-tab.tsx';
import { PROVIDERS } from '../../tests/unit/features/fleet/credentials/environment-support.ts';
import { APPLIED, CREDENTIALS, DATA, STUDIO, claudeFlow, credential, machine, runtime, scripted, stagedFrom, withStatus } from '../../tests/unit/features/fleet/account-support.ts';

const refuse = new URLSearchParams(location.search).get('refuse') === '1';
// A machine with a Codex login and its runtime, and nothing for Claude Code yet.
const existing = [CREDENTIALS.credentials.find(item => item.harness === 'codex')];
const runtimes = { ...DATA.runtimes, runtimes: [runtime({ name: 'codex-default', harness: 'codex', credential: { id: existing[0].id, store: 'ferretry', status: 'ready' } })] };
const made = [];
const client = scripted({
  'GET /v1/fleet/credentials': () => ({ ...CREDENTIALS, credentials: [...existing, ...made] }),
  'GET /v1/fleet/runtimes': () => runtimes,
  'GET /v1/fleet/profiles': DATA.profiles,
  'GET /v1/fleet/components': DATA.components,
  'GET /v1/fleet/machine': machine(),
  'GET /v1/fleet/presets': PROVIDERS,
  'GET /v1/secrets': { v: 1, health: 'ready', secrets: [], references: [] },
  'POST /v1/secrets': call => ({ name: call.body.name, createdAt: '2026-10-16T08:00:00.000Z', updatedAt: '2026-10-16T08:00:00.000Z' }),
  'POST /v1/fleet/proposals': call => {
    const change = call.body.change;
    if (refuse) return new FyHttpError('Account setup changes are switched off on studio-mac for now.', 409, 'fleet_change_disabled');
    if (change.kind === 'credential.add')
      made.push(change.store === 'environment'
        ? credential({ id: change.id, store: 'environment', harness: change.harness })
        : credential({ id: change.id, harness: change.harness, email: 'new@example.com', ...withStatus('needs_sign_in') }));
    if (change.kind === 'runtime.put') runtimes.runtimes.push(runtime({ name: change.name, profile: change.profile }));
    return stagedFrom(call);
  },
  'POST /v1/fleet/proposals/fy_fprop_abcdefghijklmnopqrstuv/apply': APPLIED,
  'POST /v1/fleet/login': claudeFlow('awaiting-code', 'claude'),
  'GET /v1/fleet/login/flow-1': claudeFlow('awaiting-code', 'claude'),
});
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <main data-fixture="" style={{ margin: '0 auto', maxWidth: 960, padding: '12px 16px' }}>
    <CredentialsTab connection={STUDIO} machineName="studio-mac" machine={machine()} online checking={false} onRetry={() => undefined} createClient={async () => client} pollMs={600000} />
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/add-login-entry.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
await Bun.write(join(outDir, 'add-login-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(outDir, 'add-login-entry.jsx'), '--outdir', outDir, '--target', 'browser']);
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

const shot = async (page: Page, name: string, theme: string, vp: string): Promise<void> => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) fail(`${name} ${theme} ${vp} scrolls sideways by ${overflow}px`);
  const file = `add-login-${name}-${theme}-${vp}.png`;
  await page.screenshot({ path: join(outDir, file), fullPage: true });
  process.stdout.write(`📸 ${join(outDir, file)}\n`);
};

/** A fixed placeholder, never a key: the field is a password field, so it shows as dots. */
const FAKE_KEY = 'harness-placeholder-not-a-key';

const open = async (page: Page, theme: string, refuse = false): Promise<void> => {
  await page.goto(`${server.url}?theme=${theme}${refuse ? '&refuse=1' : ''}`);
  await page.locator('[data-add-login]').first().click();
};

/** The one screen: pick a tile, fill what it asks, press the one button. */
const walk = async (page: Page, theme: string, vp: string): Promise<void> => {
  await open(page, theme);
  await page.locator('[data-add-login-choices]').waitFor({ state: 'visible' });
  await shot(page, 'claude-pick', theme, vp);
  await page.locator('[data-add-login-choice="claude"]').click();
  await page.locator('[data-add-login-fields="claude"]').waitFor({ state: 'visible' });
  await shot(page, 'claude-ready', theme, vp);
  await page.locator('[data-add-login-fields] [data-change-submit]').click();
  await page.locator('[data-claude-login="awaiting-code"]').waitFor({ state: 'visible' });
  await shot(page, 'claude-signing-in', theme, vp);

  await open(page, theme);
  await page.locator('[data-provider-tile="deepseek"]').click();
  await page.locator('[data-one-click="deepseek"]').waitFor({ state: 'visible' });
  await page.locator('[data-env-secret-input="DEEPSEEK_API_KEY"]').fill(FAKE_KEY);
  await shot(page, 'key-ready', theme, vp);
  await page.locator('[data-add-login-fields] [data-change-submit]').click();
  await page.locator('[data-add-login-done]').waitFor({ state: 'visible' });
  await shot(page, 'key-added', theme, vp);

  await open(page, theme, true);
  await page.locator('[data-provider-tile="deepseek"]').click();
  await page.locator('[data-env-secret-input="DEEPSEEK_API_KEY"]').fill(FAKE_KEY);
  await page.locator('[data-add-login-fields] [data-change-submit]').click();
  await page.locator('[data-change-refusal]').waitFor({ state: 'visible' });
  await shot(page, 'key-refused', theme, vp);
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
  process.stdout.write('✅ Add a login does not scroll sideways at 390px\n');
} finally {
  await browser.close();
  server.stop();
}
