/**
 * The on/off switch on a login and a runtime (docs/disabling.md) in Settings → Machines → Credentials and
 * Runtimes: the list with a disabled login, a runtime switched off on its own block, runtimes held off by
 * their login (switch locked, link to the login), the login's own page, and the Switch-off form. At a 390px
 * phone and a 1440px desktop, light and dark. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/disable-switch-screenshot.tsx [out-dir]   # writes disable-login-<surface>-<vp>-<theme>.png
 *
 * It renders the REAL `CredentialsTab` and `RuntimesTab` against the harness catalogue. Nothing touches a
 * network (every request off the loopback origin is aborted). It fails if any surface scrolls sideways or a
 * switch is under 44px on the phone.
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
import { CredentialsTab } from '../../src/features/fleet/credentials/credentials-tab.tsx';
import { RuntimesTab } from '../../src/features/fleet/runtimes/runtimes-tab.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { harnessCatalogAnswer } from '../account-model-catalog.ts';
import { overlay } from '../disable-switch-overlay.ts';

const params = new URLSearchParams(location.search);
const tab = params.get('tab') ?? 'credentials';
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
location.hash = params.get('hash') ?? '';

const client = {
  request: async (path, schema, init) => {
    const answer = harnessCatalogAnswer(path, init);
    if (answer === undefined) throw new Error('no route ' + path);
    return schema.parse(overlay(path, answer));
  },
};
const Tab = tab === 'runtimes' ? RuntimesTab : CredentialsTab;
createRoot(root).render(
  <main data-fixture="" className="mx-auto max-w-[960px] p-4">
    <Tab
      connection={daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 't' })}
      machineName="studio-mac"
      machine={null}
      online={true}
      checking={false}
      onRetry={() => undefined}
      createClient={async () => client}
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/disable-switch-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'disable-switch-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'disable-switch-entry.jsx'), '--outdir', buildDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(buildDir, 'app.css'),
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
    return new Response(Bun.file(join(buildDir, url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });

const PHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const VIEWPORTS = {
  '390': { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: PHONE_UA },
  '1440': { viewport: { width: 1440, height: 900 } },
} as const;

const SURFACES = [
  {
    name: 'login-list',
    tab: 'credentials',
    hash: '#machines/studio-mac/credentials',
    ready: '[data-disable-switch="claude-work"]',
  },
  {
    name: 'login-page',
    tab: 'credentials',
    hash: '#machines/studio-mac/credentials/claude-work',
    ready: '[data-credential-switch] [data-disable-switch]',
  },
  {
    name: 'login-switch-off-form',
    tab: 'credentials',
    hash: '#machines/studio-mac/credentials/claude-personal',
    ready: '[data-credential-switch] [data-disable-switch]',
    open: '[data-credential-switch] [role="switch"]',
  },
  {
    name: 'runtime-list',
    tab: 'runtimes',
    hash: '#machines/studio-mac/runtimes',
    ready: '[data-disable-switch="claude-default"]',
  },
  {
    name: 'runtime-own-block',
    tab: 'runtimes',
    hash: '#machines/studio-mac/runtimes/claude-default',
    ready: '[data-disable-switch="claude-default"]',
  },
  {
    name: 'runtime-held-by-login',
    tab: 'runtimes',
    hash: '#machines/studio-mac/runtimes/claude-review',
    ready: '[data-disable-owner="login"]',
  },
] as const;

try {
  for (const theme of ['light', 'dark'] as const) {
    for (const [vp, options] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({
        ...options,
        deviceScaleFactor: vp === '390' ? 2 : 1,
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      try {
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin !== server.url.origin ? await route.abort() : await route.continue(),
        );
        for (const surface of SURFACES) {
          const page = await context.newPage();
          const where = `${surface.name} at ${vp}/${theme}`;
          const query = new URLSearchParams({ theme: `studio-${theme}`, tab: surface.tab, hash: surface.hash });
          await page.goto(`${server.url}?${query.toString()}`);
          await page.locator(surface.ready).first().waitFor({ state: 'visible' });
          if ('open' in surface) {
            await page.locator(surface.open).first().click();
            await page.locator('[data-disable-form]').waitFor({ state: 'visible' });
            await page.locator('[data-disable-reason]').fill('Out of credit until the plan renews');
            await page.locator('[data-disable-until]').selectOption('week');
          }
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
          if (vp === '390') {
            const small = await page.evaluate(() =>
              [...document.querySelectorAll<HTMLElement>('[data-disable-toggle]')]
                .filter(element => element.getClientRects().length > 0)
                .map(element => ({ element, box: element.getBoundingClientRect() }))
                .filter(({ box }) => box.height < 43.5)
                .map(
                  ({ element, box }) =>
                    `${element.getAttribute('aria-label')} ${Math.round(box.width)}x${Math.round(box.height)}`,
                ),
            );
            if (small.length > 0) fail(`${where} has switches under 44px: ${small.join('; ')}`);
          }
          const file = join(outDir, `disable-login-${surface.name}-${vp}-${theme}.png`);
          await page.locator('main').screenshot({ path: file });
          process.stdout.write(`📸 ${file}\n`);
          await page.close();
        }
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write('✅ no surface scrolls sideways; every phone switch is at least 44px\n');
} finally {
  await browser.close();
  server.stop();
}
