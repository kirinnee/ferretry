/**
 * Screenshots of the lane editor at a 390px phone and a 1440px desktop, light and dark:
 *
 * - `board-u15-*.png`: its "Proposed by <ferret>, not confirmed" banner;
 * - `lane-proposal-pending-*.png`: a ferret's change waiting for the owner, with what accepting it would do;
 * - `lane-proposal-confirm-*.png`: the second tap that Accept asks for, since the change moves cards;
 * - `lane-proposal-accepted-*.png`: the same page once the owner accepted it;
 * - `lane-proposal-rewired-*.png`: a change that would make Plan/Design's "OK to build" close the card (probe P8).
 *
 *   bun harness/lane-editor-screenshot.ts [outDir]    # default /tmp/claude-1000
 *
 * It bundles `lane-editor-page.tsx` (the real page over a fake daemon), serves it on an ephemeral loopback
 * port, aborts anything that leaves it, and fails when the page scrolls sideways.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'lane-editor');
const shotsDir = resolve(process.argv[2] ?? '/tmp/claude-1000');

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/lane-editor-page.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'lane-editor-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    // The theme's fonts live with the source, as the app bundles them; without them a shot shows fallbacks.
    if (url.pathname.startsWith('/assets/fonts/')) return new Response(Bun.file(join(packageDir, 'src', url.pathname)));
    const built = Bun.file(join(buildDir, url.pathname));
    return new Response((await built.exists()) ? built : Bun.file(join(packageDir, 'public', url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? fail('no system Chrome or Chromium found');
const browser = await chromium.launch({ executablePath, headless: true });

const PHONE = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  userAgent:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
} as const;
const DESKTOP = { viewport: { width: 1_440, height: 900 } } as const;

/** Every part of the page that scrolls on its own (a Kanban row does) is allowed; the document is not. */
const settle = async (page: Page, view: string): Promise<void> => {
  await page.waitForTimeout(200);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 0) fail(`${view} scrolls sideways by ${wide}px`);
};

const open = async (
  context: BrowserContext,
  theme: string,
  fixture: 'unconfirmed' | 'pending' | 'rewired',
): Promise<Page> => {
  const page = await context.newPage();
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.goto(`${server.url}?theme=${theme}&fixture=${fixture}`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page
    .locator(`[data-lane-banner="${fixture === 'unconfirmed' ? 'unconfirmed' : 'pending'}"]`)
    .waitFor({ state: 'visible' });
  await settle(page, fixture);
  return page;
};

const shot = async (page: Page, name: string): Promise<void> => {
  const path = join(shotsDir, `${name}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

try {
  for (const scheme of ['light', 'dark'] as const) {
    const theme = `studio-${scheme}`;
    const phone = await browser.newContext({ ...PHONE, colorScheme: scheme });
    const desktop = await browser.newContext({ ...DESKTOP, colorScheme: scheme });
    try {
      for (const [label, context] of [
        ['phone', phone],
        ['desktop', desktop],
      ] as const) {
        const page = await open(context, theme, 'unconfirmed');
        await shot(page, `board-u15-${scheme}-${label}`);
        await page.close();
        const waiting = await open(context, theme, 'pending');
        await waiting.locator('[data-lane-warnings]').waitFor({ state: 'visible' });
        await shot(waiting, `lane-proposal-pending-${scheme}-${label}`);
        await waiting.getByRole('button', { name: 'Accept', exact: true }).click();
        await waiting.locator('[data-lane-confirm]').waitFor({ state: 'visible' });
        await settle(waiting, 'confirm');
        await shot(waiting, `lane-proposal-confirm-${scheme}-${label}`);
        await waiting.getByRole('button', { name: 'Accept these changes' }).click();
        await waiting.locator('[data-lane-banner="pending"]').waitFor({ state: 'detached' });
        await waiting.getByText('Version 4 · confirmed').waitFor({ state: 'visible' });
        await settle(waiting, 'accepted');
        await shot(waiting, `lane-proposal-accepted-${scheme}-${label}`);
        await waiting.close();
        const rewired = await open(context, theme, 'rewired');
        await rewired.locator('[data-lane-warnings]').waitFor({ state: 'visible' });
        await shot(rewired, `lane-proposal-rewired-${scheme}-${label}`);
        await rewired.close();
      }
    } finally {
      await phone.close();
      await desktop.close();
    }
  }
  process.stdout.write('✅ the lane editor captured; nothing scrolls sideways\n');
} finally {
  await browser.close();
  server.stop();
}
