/**
 * Screenshots of the Board with the Internal filter off and on, at a 390px phone (its filter sheet open) and a
 * 1440px desktop, light and dark:
 *
 *   bun harness/board-internal-screenshot.ts [outDir]    # default /tmp/claude-1000, files board-internal-*.png
 *
 * It bundles `board-page.tsx` (the real page, invented cards, every fourth big-board card made by a ferret),
 * serves it on an ephemeral loopback port, aborts anything that leaves it, and fails when a page scrolls sideways
 * or when turning Internal on adds no cards.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'board-internal');
const shotsDir = resolve(process.argv.slice(2).find(argument => !argument.startsWith('--')) ?? '/tmp/claude-1000');

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const html = (theme: string, script = '/board-page.js') => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="${script}"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'board-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
    if (url.pathname === '/scroll')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-light', '/board-scroll-scene.js'), {
        headers: { 'content-type': 'text/html' },
      });
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
const DESKTOP = { viewport: { width: 1_440, height: 900 } } as const;

/** Every part of the page that scrolls on its own (a Kanban row does) is allowed; the document is not. */
const open = async (context: BrowserContext, theme: string, view: string, extra = ''): Promise<Page> => {
  const page = await context.newPage();
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.goto(`${server.url}?theme=${theme}&view=${view}${extra}`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page.locator('.fy-board-card, .fy-board__empty').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(200);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 0) fail(`${view} scrolls sideways by ${wide}px`);
  return page;
};

const shot = async (page: Page, name: string, prefix = 'board-u11'): Promise<void> => {
  const path = join(shotsDir, `${prefix}-${name}.png`);
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
        const counts: Record<string, number> = {};
        for (const [state, extra] of [
          ['off', '&big=1'],
          ['on', '&big=1&agents=1'],
        ] as const) {
          const page = await open(context, theme, 'kanban', extra);
          counts[state] = await page.locator('.fy-board-card').count();
          if (label === 'phone') {
            await page.locator('.fy-board-filters__toggle').click();
            await page
              .locator('[data-bottom-sheet="board-filter-sheet"] [role="dialog"]')
              .waitFor({ state: 'visible' });
            await page.waitForTimeout(400);
          }
          await shot(page, `${scheme}-${label}-internal-${state}`, 'board-internal');
          await page.close();
        }
        if ((counts.on ?? 0) <= (counts.off ?? 0))
          fail(`${scheme} ${label}: turning Internal on did not add cards (${counts.off} → ${counts.on})`);
      }
    } finally {
      await phone.close();
      await desktop.close();
    }
  }
  process.stdout.write('✅ the board captured with Internal off and on; nothing scrolls sideways\n');
} finally {
  await browser.close();
  server.stop();
}
