/**
 * Screenshots of the Board's Kanban, which is READ-ONLY: a card draws no owner control — no Done, no Not good, no
 * Reopen, no ⋯ lane menu, no drag, and the page has no Add card button or Lanes link. The Board only says where
 * the work stands; the owner answers in the agenda.
 *
 *   bun harness/board-kanban-screenshot.ts [outDir]    # default /tmp/claude-1000
 *
 * It bundles `board-page.tsx` (sixty-odd cards, `?big=1`), serves it on an ephemeral loopback port, aborts
 * anything that leaves it, and fails when a page scrolls sideways or any hand control is drawn, at several
 * widths from a wide desktop down to the narrowest phone, in every theme.
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

/** The widths the page is checked at: desktop columns from roomy to their narrowest, then phones. */
const DESKTOP_WIDTHS = [1_440, 1_180, 1_024, 820] as const;
const PHONE_WIDTHS = [390, 360, 320] as const;

/** Every theme: each sets its own font and text sizes, and a wider face is where a label used to spill. */
const THEMES = [
  'studio-light',
  'studio-dark',
  'light',
  'dark',
  'blueprint-light',
  'blueprint-dark',
  'broadsheet-light',
  'broadsheet-dark',
  'contrast-light',
  'contrast-dark',
  'geist-light',
  'geist-dark',
  'ledger-dark',
  'ma-dark',
  'mission-light',
  'mission-dark',
  'neo-light',
  'neo-dark',
  'phosphor-light',
  'phosphor-dark',
  'wayfinding-dark',
  'x',
] as const;

/** The whole page is read-only: no button on any card, nothing draggable, no menu, no Add card, no Lanes link. */
const checkReadOnly = async (page: Page, where: string): Promise<void> => {
  const found = await page.evaluate(() => {
    const problems: string[] = [];
    const count = (selector: string): number => document.querySelectorAll(selector).length;
    const buttons = count('.fy-board-card button, .fy-board-table__row button');
    if (buttons > 0) problems.push(`${buttons} buttons on cards`);
    for (const [name, selector] of [
      ['draggable cards', '[draggable="true"]'],
      ['lane menus', '.fy-board-card__more, [role="menu"]'],
      ['drop targets', '[data-drop], [data-variant="target"]'],
      ['Add card', '[data-board-add], .fy-board__fab, [aria-label="Add card"]'],
      ['Lanes links', '[data-board-lanes], .fy-board__lanes, .fy-board-project__lanes'],
    ] as const) {
      const n = count(selector);
      if (n > 0) problems.push(`${n} ${name}`);
    }
    return { problems, cards: count('.fy-board-card') };
  });
  if (found.problems.length > 0) fail(`at ${where}: ${found.problems.join('; ')}`);
  process.stdout.write(`✓ read-only (${found.cards} cards, no hand control) at ${where}\n`);
};

const open = async (context: BrowserContext, theme: string, extra = ''): Promise<Page> => {
  const page = await context.newPage();
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  page.on('pageerror', error => process.stderr.write(`page error: ${error.message}\n`));
  await page.goto(`${server.url}?theme=${theme}&big=1${extra}`);
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

/** No card draws an owner button: no Done, no Not good, no Reopen. */
const checkNoOwnerButtons = async (page: Page): Promise<void> => {
  const found = await page.evaluate(
    () =>
      document.querySelectorAll('.fy-board-done, .fy-board-verdict, [data-verdict], .fy-board-card__verdict').length,
  );
  if (found > 0) fail(`${found} owner buttons on the cards`);
};

try {
  for (const theme of THEMES) {
    const context = await browser.newContext({ ...DESKTOP, colorScheme: theme.endsWith('light') ? 'light' : 'dark' });
    const page = await open(context, theme);
    for (const width of DESKTOP_WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(100);
      await checkReadOnly(page, `${theme} Kanban ${width}px`);
    }
    await context.close();
    for (const width of PHONE_WIDTHS) {
      const phone = await browser.newContext({ ...PHONE, viewport: { width, height: 844 } });
      const lane = await open(phone, theme, '&at=tested');
      await checkReadOnly(lane, `${theme} phone ${width}px, To test`);
      await phone.close();
    }
  }

  for (const scheme of ['light', 'dark'] as const) {
    for (const [label, options] of [
      ['desktop', DESKTOP],
      ['phone', PHONE],
    ] as const) {
      const context = await browser.newContext({ ...options, colorScheme: scheme });
      try {
        const page = await open(context, `studio-${scheme}`);
        if (label === 'desktop') {
          await checkNoOwnerButtons(page);
          await shot(page, `board-kanban-${scheme}-desktop`);
        } else {
          await page.locator('[role="tab"]', { hasText: 'To test' }).click();
          await page.waitForTimeout(200);
          await checkNoOwnerButtons(page);
          await shot(page, `board-kanban-${scheme}-phone`);
        }
        await page.close();
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write('✅ the Kanban captured; read-only at every width and in every theme\n');
} finally {
  await browser.close();
  server.stop();
}
