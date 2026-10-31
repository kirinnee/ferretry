/**
 * Screenshots of the Board's verdict rows: one Done per card, on the merged Released · to test lane and on an older
 * board with Released and To test apart, as a Kanban and as the Info › Tasks panel, at a 390px phone and a 1440px
 * desktop, light and dark:
 *
 *   bun harness/board-one-done-screenshot.ts [outDir]    # default /tmp/claude-1000, files board-one-done-*.png
 *
 * It bundles `board-one-done-page.tsx`, serves it on an ephemeral loopback port, aborts anything that leaves it, and
 * fails when a card draws two Done buttons, a verify card lacks Done + Not good, or the document scrolls sideways.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'board-one-done');
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/board-one-done-page.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'board-one-done-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
const DESKTOP = { viewport: { width: 1_440, height: 700 } } as const;

const open = async (
  context: Awaited<ReturnType<typeof browser.newContext>>,
  theme: string,
  query: string,
): Promise<Page> => {
  const page = await context.newPage();
  page.on('pageerror', error => console.error('pageerror', error.message));
  page.on('console', m => m.type() === 'error' && console.error('console', m.text()));
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.goto(`${server.url}?theme=${theme}&${query}`);
  await page.locator('[data-fixture] .fy-board-card').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(200);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 0) fail(`${query} scrolls sideways by ${wide}px`);
  const bad = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.fy-board-card')].flatMap(node => {
      const dones = node.querySelectorAll('[data-verdict="works"], .fy-board-done[data-done="done"]').length;
      return dones > 1 ? [`${node.dataset.task ?? '?'}: ${dones} Done buttons`] : [];
    }),
  );
  if (bad.length > 0) fail(`${query}: ${bad.join('; ')}`);
  const verify = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.fy-board-card[data-category="verify"]')].map(node => ({
      dones: node.querySelectorAll('[data-verdict="works"], .fy-board-done[data-done="done"]').length,
      notGood: node.querySelectorAll('[data-verdict="not-good"]').length,
    })),
  );
  if (verify.length === 0) fail(`${query}: no card in a verify lane`);
  if (verify.some(entry => entry.dones !== 1 || entry.notGood !== 1))
    fail(`${query}: a verify card is not Done + Not good`);
  return page;
};

const shot = async (page: Page, name: string): Promise<void> => {
  const path = join(shotsDir, `board-one-done-${name}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

try {
  for (const scheme of ['light', 'dark'] as const) {
    const theme = `studio-${scheme}`;
    for (const [label, device, flag] of [
      ['desktop', DESKTOP, ''],
      ['phone', PHONE, '&phone=1'],
    ] as const) {
      const context = await browser.newContext({ ...device, colorScheme: scheme });
      try {
        for (const surface of ['kanban', 'panel']) {
          const page = await open(context, theme, `lanes=merged&surface=${surface}${flag}`);
          if (surface === 'kanban' && label === 'desktop')
            await page.locator('.fy-board-lane', { hasText: 'Released' }).first().scrollIntoViewIfNeeded();
          await shot(page, `${surface === 'kanban' ? '' : 'panel-'}${scheme}-${label}`.replace(/^-/, ''));
          await page.close();
        }
        if (scheme === 'light') {
          const older = await open(context, theme, `lanes=older&surface=kanban${flag}`);
          await shot(older, `older-${label}`);
          await older.close();
        }
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop(true);
}
