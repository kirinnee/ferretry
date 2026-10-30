/**
 * Screenshots of the Board's Table view on a long board (about seventy cards, long titles, imported cards,
 * every lane), plus the owner's Done on a To test card and Reopen in the Archive:
 *
 *   bun harness/board-table-screenshot.ts [outDir]    # default /tmp/claude-1000
 *
 * It bundles `board-page.tsx` with `?big=1`, serves it on an ephemeral loopback port, aborts anything that
 * leaves it, and fails when a page scrolls sideways, or when — at any of several widths — a row's Done (or Reopen)
 * leaves its row or cuts its label. It also captures Done in flight (its spinner) and a refused Done on a row.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'board-table');
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

const open = async (context: BrowserContext, theme: string, view: string, extra = ''): Promise<Page> => {
  const page = await context.newPage();
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  page.on('pageerror', error => process.stderr.write(`page error: ${error.message}\n`));
  await page.goto(`${server.url}?theme=${theme}&view=${view}&big=1${extra}`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page.locator('.fy-board-summary__row, .fy-board-table__row').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 0) fail(`${view} scrolls sideways by ${wide}px`);
  return page;
};

const shot = async (page: Page, name: string): Promise<void> => {
  const path = join(shotsDir, `${name}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

/** Every row's Done / Reopen sits inside its row and shows its whole label. */
const checkDoneFits = async (page: Page, where: string): Promise<void> => {
  const found = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.fy-board-table__row, .fy-board-summary__row')].flatMap(row => {
      const box = row.getBoundingClientRect();
      return [...row.querySelectorAll<HTMLButtonElement>('.fy-board-done')].flatMap(button => {
        const own = button.getBoundingClientRect();
        const name = `&${row.dataset['task'] ?? '?'} "${button.textContent?.trim()}"`;
        return [
          ...(own.left < box.left - 0.5 || own.right > box.right + 0.5 ? [`${name} leaves its row`] : []),
          ...(button.scrollWidth > button.clientWidth + 1 ? [`${name} cuts its label`] : []),
        ];
      });
    }),
  );
  if (found.length > 0) fail(`at ${where}: ${found.slice(0, 6).join('; ')}`);
  process.stdout.write(`✓ every Done fits its row at ${where}\n`);
};

/** Centres the first To test row, so the shot shows the owner's Done on it. */
const showDone = async (page: Page): Promise<void> => {
  const row = page.locator('[data-section="to-test"]').first();
  await row.evaluate(node => node.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(150);
};

try {
  for (const scheme of ['light', 'dark'] as const) {
    const theme = `studio-${scheme}`;
    for (const [label, options] of [
      ['phone', PHONE],
      ['desktop', DESKTOP],
    ] as const) {
      const context = await browser.newContext({ ...options, colorScheme: scheme });
      try {
        const page = await open(context, theme, 'list');
        await shot(page, `board-table-${scheme}-${label}`);
        if (scheme === 'light') {
          await showDone(page);
          await shot(page, `board-done-${label}`);
        }
        await page.close();
        const agents = await open(context, theme, 'list', '&agents=1');
        await shot(agents, `board-table-agents-${scheme}-${label}`);
        await agents
          .locator('[data-section="merged"]')
          .first()
          .evaluate(node => node.scrollIntoView({ block: 'start' }));
        await agents.waitForTimeout(150);
        await shot(agents, `board-table-info-${scheme}-${label}`);
        await agents.close();
        if (scheme === 'light') {
          const today = await open(context, theme, 'list', '&window=today');
          await shot(today, `board-table-today-${label}`);
          await today.close();
        }
        if (scheme === 'light' && label === 'desktop') {
          const archive = await open(context, theme, 'archive');
          await shot(archive, 'board-table-archive-desktop');
          await archive.close();
        }
      } finally {
        await context.close();
      }
    }
  }
  for (const [view, extra] of [
    ['list', ''],
    ['archive', ''],
  ] as const) {
    for (const width of [1_920, 1_180, 900, 721, 720, 390, 320]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'light' });
      const page = await open(context, 'studio-light', view, extra);
      await checkDoneFits(page, `${view} ${width}px`);
      await context.close();
    }
  }
  for (const [label, options] of [
    ['desktop', DESKTOP],
    ['phone', PHONE],
  ] as const) {
    for (const scheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({ ...options, colorScheme: scheme });
      const page = await open(context, `studio-${scheme}`, 'list');
      await showDone(page);
      const row = page.locator('.fy-board-summary__row[data-section="to-test"]').first();
      await row.locator('.fy-board-done').click();
      await row.locator('.fy-board-done[data-pending] [data-spinner]').waitFor({ state: 'visible' });
      await shot(page, `board-table-in-flight-${scheme}-${label}`);
      const refusing = await open(context, `studio-${scheme}`, 'list', '&refuse=1');
      await showDone(refusing);
      const refused = refusing.locator('.fy-board-summary__row[data-section="to-test"]').first();
      await refused.locator('.fy-board-done').click();
      await refused.locator('[data-answer-error]').waitFor({ state: 'visible' });
      await checkDoneFits(refusing, `list ${label} ${scheme}, refused`);
      await shot(refusing, `board-table-refused-${scheme}-${label}`);
      await context.close();
    }
  }
  for (const width of [1_440, 1_920]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'light' });
    try {
      const page = await open(context, 'studio-light', 'list');
      const gap = await page.evaluate(() => {
        const table = document.querySelector('.fy-board-table')?.getBoundingClientRect();
        return table === undefined ? 0 : window.innerWidth - table.right;
      });
      if (gap > 40) fail(`the table leaves a ${Math.round(gap)}px band on the right at ${width}px`);
      await shot(page, `board-table-light-desktop-wide-${width}`);
      await page.close();
    } finally {
      await context.close();
    }
  }
  process.stdout.write('✅ the table captured; nothing scrolls sideways\n');
} finally {
  await browser.close();
  server.stop();
}
