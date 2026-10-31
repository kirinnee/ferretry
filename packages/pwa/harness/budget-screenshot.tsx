/**
 * Login spend budgets (docs/budgets.md) in Settings → Machines → Credentials: the list with a metered
 * login within budget, one over its trigger and one over its hard limit, the login's own page with its
 * budget and the four-field editor, the editor with a change waiting to be saved, and a LOOSENED
 * budget written and held for the owner's confirmation. At a 375px phone and a 1440px desktop, light
 * and dark. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/budget-screenshot.tsx [out-dir]   # writes budget-<surface>-<vp>-<theme>.png
 *
 * It renders the REAL `CredentialsTab` against the harness catalogue with fake budgets overlaid
 * (harness/budget-overlay.ts). Nothing touches a network (every request off the loopback origin is
 * aborted). It fails if any surface scrolls sideways or the phone's Confirm control is under 44px.
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
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { harnessCatalogAnswer } from '../account-model-catalog.ts';
import { configAnswer, overlay } from '../budget-overlay.ts';

const params = new URLSearchParams(location.search);
const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
location.hash = params.get('hash') ?? '';

const client = {
  request: async (path, schema, init) => {
    const own = configAnswer(path, init);
    if (own !== undefined) return schema.parse(own);
    const answer = harnessCatalogAnswer(path, init);
    if (answer === undefined) throw new Error('no route ' + path);
    return schema.parse(overlay(path, answer));
  },
};
createRoot(root).render(
  <main data-fixture="" className="mx-auto max-w-[960px] p-4">
    <CredentialsTab
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/budget-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'budget-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'budget-entry.jsx'), '--outdir', buildDir, '--target', 'browser']);
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
  '375': { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, userAgent: PHONE_UA },
  '1440': { viewport: { width: 1440, height: 900 } },
} as const;

interface Surface {
  readonly name: string;
  readonly hash: string;
  readonly ready: string;
  /** Fill a budget field, and when `save` is set, walk the save as far as its held state. */
  readonly fill?: readonly [field: string, value: string];
  readonly save?: boolean;
  readonly held?: string;
}

const SURFACES: readonly Surface[] = [
  {
    name: 'login-list',
    hash: '#machines/studio-mac/credentials',
    ready: '[data-credential-row="codex"] [data-credential-budget-badge]',
  },
  {
    name: 'login-page',
    hash: '#machines/studio-mac/credentials/claude-personal',
    ready: '[data-budget-editor="claude-personal"]',
  },
  {
    name: 'editor-open',
    hash: '#machines/studio-mac/credentials/claude-personal',
    ready: '[data-budget-editor="claude-personal"]',
    fill: ['dailyTrigger', '25'],
  },
  {
    name: 'held-confirm',
    hash: '#machines/studio-mac/credentials/claude-personal',
    ready: '[data-budget-editor="claude-personal"]',
    fill: ['dailyHard', '90'],
    save: true,
    held: '[data-budget-save="pending"]',
  },
];

try {
  for (const theme of ['light', 'dark'] as const) {
    for (const [vp, options] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({
        ...options,
        deviceScaleFactor: vp === '375' ? 2 : 1,
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
          const query = new URLSearchParams({ theme: `studio-${theme}`, hash: surface.hash });
          await page.goto(`${server.url}?${query.toString()}`);
          await page.locator(surface.ready).first().waitFor({ state: 'visible' });
          if (surface.fill !== undefined) {
            const [field, value] = surface.fill;
            await page.locator(`[data-budget-input="${field}"]`).fill(value);
            await page.locator('[data-change-submit]').first().waitFor({ state: 'visible' });
          }
          if (surface.save === true) await page.getByRole('button', { name: 'Save budget' }).click();
          if (surface.held !== undefined) await page.locator(surface.held).first().waitFor({ state: 'visible' });
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
          if (vp === '375' && surface.held !== undefined) {
            const small = await page.evaluate(() =>
              [...document.querySelectorAll<HTMLElement>('[data-budget-confirm]')]
                .filter(element => element.getClientRects().length > 0)
                .map(element => element.getBoundingClientRect())
                .filter(box => box.height < 43.5)
                .map(box => `${Math.round(box.width)}x${Math.round(box.height)}`),
            );
            if (small.length > 0) fail(`${where} has a Confirm control under 44px: ${small.join('; ')}`);
          }
          const file = join(outDir, `budget-${surface.name}-${vp}-${theme}.png`);
          await page.locator('main').screenshot({ path: file });
          process.stdout.write(`📸 ${file}\n`);
          await page.close();
        }
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write('✅ no surface scrolls sideways; the phone Confirm control is at least 44px\n');
} finally {
  await browser.close();
  server.stop();
}
