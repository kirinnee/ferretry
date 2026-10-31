/**
 * Screenshots of Settings › this machine's three credential tabs (docs/secrets.md) and the AI logins label, at a
 * 390px phone and a 1440px desktop, in the light and dark studio themes. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/credential-tabs-screenshot.tsx [out-dir] [states]   # writes credential-tabs-{secrets,accounts,secure-copy,ai-logins}-*.png
 *
 * `states` is a comma list (secrets,accounts,secure-copy,ai-logins) when only some are wanted. Fake fixtures only: a
 * secret's name, a username and a route; never a value. "ai-logins" is the Warden's failover control, whose label
 * used to say "Logins".
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? buildDir);

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
import { DEFAULT_WARDEN_CONFIG } from '@ferretry/protocol';
import { DaemonSettingsFrame } from '../../src/features/settings/daemon-settings-frame.tsx';
import { WardenSettingsForm } from '../../src/features/warden/warden-settings-form.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { signInLogins } from '../../tests/support/input-fixtures.ts';

const view = new URLSearchParams(location.search).get('view') ?? 'secrets';
const at = '2026-10-30T09:00:00.000Z';
const secrets = {
  v: 1,
  health: 'ready',
  secrets: [
    { name: 'GITHUB_TOKEN', createdAt: at, updatedAt: at },
    { name: 'ANTHROPIC_API_KEY', createdAt: at, updatedAt: at },
  ],
  references: [],
};
const copyRules = {
  rules: [
    { id: '1'.repeat(32), from: { kind: 'command', program: 'gh' }, to: { kind: 'terminal', program: 'vercel' }, remaining: 3, used: 1, createdAt: at, createdBy: { kind: 'host' }, expiresAt: '2026-11-01T09:00:00.000Z' },
  ],
};
const createSecretClient = async () => ({
  request: async (path: string) => (path === '/v1/secrets/logins' ? signInLogins() : path === '/v1/copy-rules' ? copyRules : secrets),
});
const connection = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'studio-token' });
const nothing = async () => { throw new Error('the harness has no daemon'); };

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <div className="kt-shell flex min-h-full flex-col items-center bg-bg p-3">
    <div className="w-full max-w-[640px]">
      {view === 'ai-logins' ? (
        <div data-ai-logins="">
          <WardenSettingsForm
            value={{ ...DEFAULT_WARDEN_CONFIG, accounts: [{ agent: 'claude-default' }], layers: { ...DEFAULT_WARDEN_CONFIG.layers, llm: true } }}
            onChange={() => undefined}
            jevKey={{ state: 'set' }}
            errors={{}}
          />
        </div>
      ) : (
        <DaemonSettingsFrame
          connection={connection}
          name="studio"
          panel={view}
          onOpenPanel={() => undefined}
          readWardenStatus={nothing as never}
          createWardenClient={nothing as never}
          createSecretClient={createSecretClient as never}
        />
      )}
    </div>
  </div>,
);
`;
const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="/app.css" />
    <style>html, body, #root { min-height: 100%; margin: 0; }</style>
  </head>
  <body><div id="root"></div><script type="module" src="/credential-tabs-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'credential-tabs-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'credential-tabs-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(buildDir, 'app.css'),
]);

const wanted = process.argv[3]?.split(',');
const STATES = (['secrets', 'accounts', 'secure-copy', 'ai-logins'] as const).filter(
  state => wanted === undefined || wanted.includes(state),
);

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') {
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    }
    const file = url.pathname.startsWith('/assets/fonts/')
      ? Bun.file(join(packageDir, 'src', url.pathname))
      : Bun.file(join(buildDir, url.pathname));
    return new Response(file);
  },
});

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, shot: 1_320, touch: true },
  { name: 'desktop', width: 1_440, height: 900, shot: 1_060, touch: false },
] as const;

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.shot },
        colorScheme: scheme,
        reducedMotion: 'reduce',
        hasTouch: viewport.touch,
        isMobile: viewport.touch,
      });
      try {
        await context.route('**/*', async route => {
          if (new URL(route.request().url()).origin !== server.url.origin) return await route.abort();
          return await route.continue();
        });
        const page = await context.newPage();
        page.on('pageerror', error => process.stderr.write(`page error: ${error.message}\n`));
        for (const state of STATES) {
          await page.goto(`${server.url}?theme=studio-${scheme}&view=${state}`);
          const surface =
            state === 'ai-logins' ? page.locator('[data-ai-logins]') : page.locator('[data-daemon-settings-frame]');
          await surface.waitFor({ state: 'visible' });
          const where = `${state} at ${viewport.name}/${scheme}`;
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
          if (viewport.touch) {
            // The touch floor is asked of this feature's own controls; the agenda's chrome has its own harness.
            for (const height of await surface
              .locator('button')
              .evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height)))
              if (height < 44) fail(`${where}: a button is ${height}px tall, under the 44px floor`);
          }
          const target = join(outDir, `credential-tabs-${state}-${viewport.name}-${scheme}.png`);
          await page.screenshot({ path: target, fullPage: true });
          process.stdout.write(`📸 ${target}\n`);
        }
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
