/**
 * Screenshots of the Accounts screen (&F291 R1-7 + R2-6): the list, an account's tabs, a site row's tabs, the
 * look-alike banner and the older-daemon fallback, at a 390px phone and a 1440px desktop, in the light and dark
 * studio themes. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/accounts-screenshot.tsx [out-dir] [views]   # writes accounts-<view>-<viewport>-<scheme>.png
 *
 * `views` is a comma list when only some are wanted. Fake fixtures only: no real account, no daemon, no password.
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
import { AccountsSurface } from '../../src/features/accounts/accounts-surface.tsx';
import { TwoFactorSeedHost } from '../../src/features/input-request/two-factor-seed-host.tsx';
import { LoginsSurface } from '../../src/features/secrets/logins-surface.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { answer } from '../../tests/support/accounts-fixtures.ts';
import { fakeClient, logins } from '../../tests/support/input-fixtures.ts';

const view = new URLSearchParams(location.search).get('view') ?? 'list';
const connection = daemonConnection({ daemonId: 'workshop', baseUrl: 'https://workshop.example.test', deviceId: 't1' });
const world = {
  groups: view === 'lookalike' ? [['GITHUB', 'GITHUB_WORK']] : [],
  defaults: view === 'site-defaults' ? 'sites:\\n  vercel.com: VERCEL\\n' : undefined,
};
const seed = view.startsWith('seed-');
const stage = 'st_' + 'a'.repeat(24);
const seedItem = {
  twoFactorSeed: { stage, account: 'GITHUB' },
  subject: 'Save automatic codes to GitHub · kirinnee?',
  why: 'Asked by fy on kirin-box at 10:02 UTC. If you didn’t just ask for this, Deny.',
  context: [
    view.includes('mismatch') ? '- The key says it is for Slack · someone@else.test.' : '- The key says it is for GitHub · kirinnee.',
    ...(view.includes('mismatch') ? ['- It does not look like this account’s key; it was staged with “save it here anyway”.'] : []),
    '- Password and code both come from this machine then: together they are one factor.',
  ].join('\\n'),
};
const seedAnswer = (call) =>
  call.path.startsWith('/v1/accounts/' + 'GITHUB' + '/factors/seed/')
    ? { stage, account: 'GITHUB', label: 'Authenticator app', state: view === 'seed-saved' ? 'saved' : 'waiting', expiresAt: '2099-01-01T00:00:00.000Z' }
    : answer(world)(call);
const machine = fakeClient(view === 'fallback' ? () => logins() : seed ? seedAnswer : answer(world));

createRoot(document.getElementById('root')).render(
  <div className="kt-shell flex min-h-full flex-col items-center bg-bg py-2">
    <div className="w-full min-w-0 px-panel" style={{ maxWidth: 640 }} data-harness-surface="">
      {seed ? (
        <article className="fy-card" data-harness-card="">
          <TwoFactorSeedHost connection={connection} createClient={async () => machine.client} addKey={async () => true} item={seedItem} />
        </article>
      ) : view === 'fallback' ? (
        <LoginsSurface connection={connection} createClient={async () => machine.client} />
      ) : (
        <AccountsSurface connection={connection} createClient={async () => machine.client} addKey={async () => true} />
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
  <body><div id="root"></div><script type="module" src="/accounts-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'accounts-entry.tsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'accounts-entry.tsx'), '--outdir', buildDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(buildDir, 'app.css'),
]);

/** How to get to each view from the list: the buttons to press, in order. */
const STEPS: Readonly<Record<string, readonly string[]>> = {
  list: [],
  lookalike: [],
  fallback: [],
  'account-details': ['[data-accounts-row="GITHUB"] button'],
  'account-keys': ['[data-accounts-row="GITHUB"] button', '[data-accounts-tab="keys"]'],
  'account-keys-add': [
    '[data-accounts-row="GITHUB"] button',
    '[data-accounts-tab="keys"]',
    '[data-accounts-key-add-open]',
  ],
  'account-keys-codes': [
    '[data-accounts-row="GITHUB"] button',
    '[data-accounts-tab="keys"]',
    '[data-codes-panel] summary',
  ],
  'account-sites': ['[data-accounts-row="GITHUB"] button', '[data-accounts-tab="sites"]'],
  'site-method': SITE('method'),
  'site-recipe': SITE('recipe'),
  'site-seen': SITE('seen'),
  'site-defaults': SITE('defaults'),
  'seed-card': [],
  'seed-card-ticked': ['[data-seed-warning-tick]'],
  'seed-card-mismatch': ['[data-seed-warning-tick]'],
  'seed-card-mismatch-ticked': ['[data-seed-warning-tick]', '[data-seed-mismatch-tick]'],
  'seed-saved': [],
};

function SITE(tab: string): readonly string[] {
  return [
    '[data-accounts-row="GITHUB"] button',
    '[data-accounts-tab="sites"]',
    '[data-accounts-signin] button',
    `[data-accounts-tab="${tab}"]`,
  ];
}

const wanted = process.argv[3]?.split(',');
const VIEWS = Object.keys(STEPS).filter(each => wanted === undefined || wanted.includes(each));

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
  { name: 'phone', width: 390, height: 844, shot: 1_100, touch: true },
  { name: 'desktop', width: 1_440, height: 900, shot: 900, touch: false },
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
        for (const state of VIEWS) {
          await page.goto(`${server.url}?theme=studio-${scheme}&view=${state}`);
          await page.locator('[data-harness-surface]').waitFor({ state: 'visible' });
          await page
            .locator('[data-accounts-screen], [data-login], [data-seed-card], [aria-label="Accounts unavailable"]')
            .first()
            .waitFor({ state: 'visible' });
          for (const step of STEPS[state] ?? []) await page.locator(step).first().click();
          await page.evaluate(() => document.fonts.ready);
          const where = `${state} at ${viewport.name}/${scheme}`;
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
          if (viewport.touch) {
            for (const height of await page
              .locator('button:visible')
              .evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height)))
              if (height < 44) fail(`${where}: a button is ${height}px tall, under the 44px floor`);
          }
          const target = join(outDir, `accounts-${state}-${viewport.name}-${scheme}.png`);
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
