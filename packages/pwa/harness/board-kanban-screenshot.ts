/**
 * Screenshots of the Board's Kanban with the owner's Done on a To test card and a Released card, and the ⋯ menu
 * with Done first:
 *
 *   bun harness/board-kanban-screenshot.ts [outDir]    # default /tmp/claude-1000
 *
 * It bundles `board-page.tsx`, serves it on an ephemeral loopback port, aborts anything that leaves it, and
 * fails when a page scrolls sideways or a To test / Released card has no Done (a Merged card has none).
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'board-kanban');
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/board-page.js"></script></body>
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

const open = async (context: BrowserContext, theme: string, extra = ''): Promise<Page> => {
  const page = await context.newPage();
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  page.on('pageerror', error => process.stderr.write(`page error: ${error.message}\n`));
  await page.goto(`${server.url}?theme=${theme}${extra}`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page.locator('.fy-board-card').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 0) fail(`the Kanban scrolls sideways by ${wide}px`);
  return page;
};

const shot = async (page: Page, name: string): Promise<void> => {
  const path = join(shotsDir, `${name}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

const doneCount = async (page: Page, lane: string): Promise<readonly [number, number]> => {
  const cards = page.locator(`.fy-board-lane[aria-label^="${lane},"] .fy-board-card`);
  return [await cards.count(), await cards.locator('.fy-board-done').count()];
};

const checkDone = async (page: Page): Promise<void> => {
  for (const lane of ['To test', 'Released']) {
    const [cards, withDone] = await doneCount(page, lane);
    if (cards === 0 || withDone !== cards) fail(`${withDone} of ${cards} ${lane} cards have a Done`);
  }
  const [merged, mergedDone] = await doneCount(page, 'Merged');
  if (merged === 0 || mergedDone !== 0) fail(`${mergedDone} of ${merged} Merged cards show a Done row`);
};

try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const [label, options] of [
      ['desktop', DESKTOP],
      ['phone', PHONE],
    ] as const) {
      const context = await browser.newContext({ ...options, colorScheme: scheme });
      try {
        const page = await open(context, `studio-${scheme}`);
        if (label === 'desktop') {
          await checkDone(page);
          await shot(page, `board-kanban-done-${scheme}-desktop`);
          await page.locator('.fy-board-card__more').first().click();
          await page.waitForTimeout(150);
          await shot(page, `board-kanban-menu-${scheme}-desktop`);
        } else {
          await page.locator('[role="tab"]', { hasText: 'To test' }).click();
          await page.waitForTimeout(200);
          await shot(page, `board-kanban-done-${scheme}-phone`);
        }
        await page.close();
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write('✅ the Kanban captured; Done on every To test and Released card, none on Merged\n');
} finally {
  await browser.close();
  server.stop();
}
