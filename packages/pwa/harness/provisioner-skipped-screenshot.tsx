/**
 * Screenshots of the Runtimes tab's quiet "N items skipped" line (what the fleet provisioner refused to touch),
 * at a 390px phone and a 1440px desktop, in the light and dark studio themes: nothing skipped, a few skipped,
 * and the list open. Review evidence; nothing compares the PNGs.
 *
 *   bun harness/provisioner-skipped-screenshot.tsx [out-dir]   # writes provisioner-skipped-{none,few,open}-*.png
 *
 * It renders the REAL `RuntimesTab` against scripted routes and walks the real Add runtime journey, so the
 * line appears from the apply result the daemon would send. Fake fixtures only: the folder path is a made-up
 * one and it must never show up on screen (the harness fails if it does).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out');
const outDir = resolve(process.argv[2] ?? buildDir);

const FOLDER = '/home/harness/.ferretry/fleet/homes/claude-default';
const ONE = '00000000-0000-4000-8000-0000000000a1';

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
import { FleetRuntimeCatalogSchema } from '@ferretry/protocol';
import { RuntimesTab } from '../../src/features/fleet/runtimes/runtimes-tab.tsx';
import {
  CHANGE_ID,
  DATA,
  machine,
  READS,
  RUNTIMES,
  runtime,
  STUDIO,
  scripted,
  stagedFrom,
} from '../../tests/unit/features/fleet/account-support.ts';

const state = new URLSearchParams(location.search).get('state') ?? 'none';
const FOLDER = ${JSON.stringify(FOLDER)};
const ONE = ${JSON.stringify(ONE)};
const REASON = 'not moving or removing ' + FOLDER + '/skills/review on this platform';

const skipped =
  state === 'none'
    ? []
    : [
        { path: FOLDER + '/skills/review', reason: REASON, runtime: ONE, within: 'skills/review' },
        { path: FOLDER + '/commands/ship.md', reason: REASON, runtime: ONE, within: 'commands/ship.md' },
        { path: FOLDER + '/hooks/pre-commit/format-staged-files-before-every-single-commit.sh', reason: REASON, runtime: ONE, within: 'hooks/pre-commit/format-staged-files-before-every-single-commit.sh' },
      ];

const runtimes = [runtime({ name: 'claude-default', id: ONE }), ...RUNTIMES.runtimes.slice(1)];
const catalog = FleetRuntimeCatalogSchema.parse({ ...RUNTIMES, runtimes });
const client = scripted({
  ...READS({ ...DATA, runtimes: catalog }),
  'POST /v1/fleet/proposals': call => stagedFrom(call),
  ['POST /v1/fleet/proposals/' + CHANGE_ID + '/apply']: {
    outcome: 'applied',
    apply: {
      outcome: 'committed',
      result: {
        accountCount: 1,
        operationCount: 2,
        manifestPath: FOLDER + '/manifest.json',
        prunedWrappers: [],
        sharedHistory: [],
        ...(skipped.length === 0 ? {} : { skipped }),
      },
    },
  },
});

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <main className="kt-shell" data-fixture="" style={{ margin: '0 auto', maxWidth: 960, padding: '12px 16px' }}>
    <RuntimesTab
      connection={STUDIO}
      machineName="studio-mac"
      machine={machine()}
      online
      checking={false}
      onRetry={() => undefined}
      createClient={async () => client}
      pollMs={60000}
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
    <style>html, body, #root { min-height: 100%; margin: 0; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/provisioner-skipped-entry.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
await Bun.write(join(buildDir, 'provisioner-skipped-entry.jsx'), PAGE_ENTRY);
run('bun', ['build', join(buildDir, 'provisioner-skipped-entry.jsx'), '--outdir', buildDir, '--target', 'browser']);
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
  { name: 'phone', width: 390, height: 844, touch: true },
  { name: 'desktop', width: 1_440, height: 900, touch: false },
] as const;

const STATES = ['none', 'few', 'open'] as const;

/** The real journey: Add runtime, pick a login and a profile, apply, back to the list. */
const addRuntime = async (page: Page): Promise<void> => {
  await page.locator('[data-add-runtime]').click();
  await page.locator('[data-add-runtime-credential="claude-personal"] input').click({ force: true });
  await page.locator('[data-add-runtime-profile="Claude hooks"] input').click({ force: true });
  await page.locator('[data-change-submit]').evaluate(button => (button as HTMLElement).click());
  await page.locator('[data-add-runtime-finish="list"]').evaluate(button => (button as HTMLElement).click());
};

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
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
          const where = `${state} at ${viewport.name}/${scheme}`;
          await page.goto(`${server.url}?theme=studio-${scheme}&state=${state}`);
          await page.locator('[data-runtimes-tab]').waitFor({ state: 'visible' });
          await addRuntime(page);
          const line = page.locator('[data-runtime-skipped="claude-default"]');
          if (state === 'none') {
            await page.locator('[data-runtime-row="claude-default"]').waitFor({ state: 'visible' });
            if ((await line.count()) !== 0) fail(`${where}: a skipped line shows although nothing was skipped`);
          } else {
            await line.waitFor({ state: 'visible' });
            if (state === 'open') await line.locator('button').click();
            const shown = (await line.textContent()) ?? '';
            if (!shown.includes('3 items skipped')) fail(`${where}: the line says "${shown}"`);
          }
          const body = (await page.locator('body').textContent()) ?? '';
          if (body.includes('/home/harness')) fail(`${where}: the runtime folder's place on disk is on screen`);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) fail(`${where} scrolls sideways by ${overflow}px`);
          if (viewport.touch && state !== 'none') {
            const height = await line.locator('button').evaluate(button => button.getBoundingClientRect().height);
            if (height < 44) fail(`${where}: the toggle is ${height}px tall, under the 44px floor`);
          }
          const target = join(outDir, `provisioner-skipped-${state}-${viewport.name}-${scheme}.png`);
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
