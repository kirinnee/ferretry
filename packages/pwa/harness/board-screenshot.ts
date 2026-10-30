/**
 * Screenshots of the Board page at a 390px phone and a 1440px desktop, light and dark, plus the Archive and
 * List views on the desktop:
 *
 *   bun harness/board-screenshot.ts [outDir]    # default /tmp/claude-1000, files board-u11-*.png
 *   bun harness/board-screenshot.ts --scroll-only [outDir]   # the long board in the shell's frame: board-b62-*.png
 *
 * It bundles `board-page.tsx` (the real page, invented cards), serves it on an ephemeral loopback port,
 * aborts anything that leaves it, and fails when a page scrolls sideways.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright-core';
import {
  pullDown,
  readBoardDensity,
  readBoardReadable,
  readBoardScroll,
  scrollBoardTo,
} from '../tests/integration/support/board-scroll.ts';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'board');
const scrollOnly = process.argv.includes('--scroll-only');
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
run('bun', [
  'build',
  join(packageDir, 'tests/integration/fixtures/board-scroll-scene.tsx'),
  '--outdir',
  buildDir,
  '--target',
  'browser',
]);
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

const openScene = async (
  context: BrowserContext,
  theme: string,
  scene: 'phone' | 'desktop',
  extra = '',
): Promise<Page> => {
  const page = await context.newPage();
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  page.on('pageerror', error => process.stderr.write(`page error: ${error.message}\n`));
  await page.goto(`${server.url}scroll?theme=${theme}&scene=${scene}${extra}`);
  await page.locator('.fy-board-card').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 0) fail(`the ${scene} board scrolls sideways by ${wide}px`);
  return page;
};

/** B62: the long board inside the shell's frame, at the top and scrolled mid-list, and the desktop beside it. */
const scrollShots = async (): Promise<void> => {
  for (const scheme of ['light', 'dark'] as const) {
    const phone = await browser.newContext({ ...PHONE, colorScheme: scheme });
    try {
      const page = await openScene(phone, `studio-${scheme}`, 'phone');
      await shot(page, `${scheme}-phone-top`, 'board-b62');
      process.stdout.write(`top: ${JSON.stringify(await readBoardScroll(page))}\n`);
      process.stdout.write(`pull from the top opened the finder ${await pullDown(page, 400, 160)}x\n`);
      await scrollBoardTo(page, 1_100);
      process.stdout.write(`pull from mid-list opened the finder ${await pullDown(page, 400, 160)}x\n`);
      await scrollBoardTo(page, 1_100);
      await shot(page, `${scheme}-phone-scrolled`, 'board-b62');
      await shot(page, `${scheme}-phone-dense`, 'board-b62');
      process.stdout.write(`density: ${JSON.stringify(await readBoardDensity(page))}\n`);
      process.stdout.write(`scrolled: ${JSON.stringify(await readBoardScroll(page))}\n`);
      await page.close();
    } finally {
      await phone.close();
    }
  }
  for (const scheme of ['light', 'dark'] as const) {
    const phone = await browser.newContext({ ...PHONE, colorScheme: scheme });
    const desktop = await browser.newContext({ ...DESKTOP, colorScheme: scheme, deviceScaleFactor: 2 });
    try {
      const small = await openScene(phone, `studio-${scheme}`, 'phone');
      await shot(small, `${scheme}-phone`, 'board-readable');
      process.stdout.write(`readable phone: ${JSON.stringify(await readBoardReadable(small))}\n`);
      const wide = await openScene(desktop, `studio-${scheme}`, 'desktop', '&cols=200');
      await shot(wide, `${scheme}-desktop`, 'board-readable');
      process.stdout.write(`readable desktop: ${JSON.stringify(await readBoardReadable(wide))}\n`);
    } finally {
      await phone.close();
      await desktop.close();
    }
  }
  const desktop = await browser.newContext({ ...DESKTOP, colorScheme: 'light' });
  try {
    const page = await openScene(desktop, 'studio-light', 'desktop');
    await shot(page, 'light-desktop', 'board-b62');
    await page.close();
  } finally {
    await desktop.close();
  }
};

try {
  if (scrollOnly) {
    await scrollShots();
    process.stdout.write('✅ the long board captured\n');
    process.exit(0);
  }
  for (const scheme of ['light', 'dark'] as const) {
    const theme = `studio-${scheme}`;
    const phone = await browser.newContext({ ...PHONE, colorScheme: scheme });
    const desktop = await browser.newContext({ ...DESKTOP, colorScheme: scheme });
    try {
      for (const [label, context] of [
        ['phone', phone],
        ['desktop', desktop],
      ] as const) {
        const page = await open(context, theme, 'kanban');
        await shot(page, `${scheme}-${label}`);
        await page.close();
      }
      // U13: the phone's lane strip, a To test row, the filter sheet and the bottom bar.
      const strip = await open(phone, theme, 'kanban', '&bar=1');
      await shot(strip, `${scheme}-phone`, 'board-u13');
      await strip.close();
      const toTest = await open(phone, theme, 'kanban', '&at=tested&bar=1');
      await shot(toTest, `${scheme}-phone-to-test`, 'board-u13');
      await toTest.close();
      const sheet = await open(phone, theme, 'kanban');
      await sheet.locator('.fy-board-filters__toggle').click();
      await sheet.locator('[data-bottom-sheet="board-filter-sheet"] [role="dialog"]').waitFor({ state: 'visible' });
      await sheet.waitForTimeout(400);
      await shot(sheet, `${scheme}-phone-filters`, 'board-u13');
      await sheet.close();
      if (scheme === 'light') {
        for (const view of ['archive', 'list', 'tree', 'dependencies'] as const) {
          const page = await open(desktop, theme, view);
          await shot(page, `${view}-desktop`);
          await page.close();
        }
      }
    } finally {
      await phone.close();
      await desktop.close();
    }
  }
  process.stdout.write('✅ the board captured; nothing scrolls sideways\n');
} finally {
  await browser.close();
  server.stop();
}
