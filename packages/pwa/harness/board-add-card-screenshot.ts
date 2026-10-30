/**
 * Add card on the Board: a floating button on a phone (390x844, above the tab bar), a header button beside
 * Lanes on a desktop. Run:
 *
 *   bun harness/board-add-card-screenshot.ts [outDir]    # default /tmp/claude-1000
 *
 * It bundles `board-page.tsx`, serves it on an ephemeral loopback port, aborts anything that leaves it, and
 * fails when the button is cut off, overlaps another control, sits in the chip row, or does not open the
 * form and create a card.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'board-add-card');
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

const open = async (context: BrowserContext, theme: string, phone: boolean): Promise<Page> => {
  const page = await context.newPage();
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  page.on('pageerror', error => process.stderr.write(`page error: ${error.message}\n`));
  await page.goto(`${server.url}?theme=${theme}&shell=1`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page.locator('.fy-board-card').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 0) fail(`the ${phone ? 'phone' : 'desktop'} board scrolls sideways by ${wide}px`);
  return page;
};

const shot = async (page: Page, name: string): Promise<void> => {
  const path = join(shotsDir, `${name}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
const boxOf = async (page: Page, selector: string): Promise<Box> => {
  const box = await page.locator(selector).first().boundingBox();
  return box ?? fail(`no ${selector} on the page`);
};
const meets = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The button is whole on screen, clear of every other control, and a tap on it opens the form. */
const checkPhone = async (page: Page, view: { readonly width: number; readonly height: number }): Promise<void> => {
  const add = '[data-board-add="fab"]';
  if ((await page.locator('[data-board-add]').count()) !== 1) fail('the phone board must carry exactly one Add card');
  if ((await page.locator('.fy-board__phone-bar [data-board-add]').count()) !== 0)
    fail('Add card is still inside the scrolling chip row');
  const check = async (when: string): Promise<Box> => {
    const fab = await boxOf(page, add);
    if (fab.x < 0 || fab.y < 0 || fab.x + fab.width > view.width || fab.y + fab.height > view.height)
      fail(`Add card is not whole on screen ${when}: ${JSON.stringify(fab)}`);
    if (fab.width < 44 || fab.height < 44) fail(`Add card is under 44px ${when}: ${fab.width}x${fab.height}`);
    if (fab.x + fab.width < view.width - 40) fail(`Add card is not at the right edge ${when}`);
    const bar = await boxOf(page, '.kt-tabbar');
    if (fab.y + fab.height > bar.y) fail(`Add card reaches into the tab bar ${when}`);
    const controls = page.locator('.kt-tabbar a, .kt-tabbar button, .fy-board__phone-bar > *, .fy-board__head button');
    for (let i = 0; i < (await controls.count()); i += 1) {
      const box = await controls.nth(i).boundingBox();
      if (box !== null && meets(fab, box)) fail(`Add card overlaps control #${i} ${when}`);
    }
    return fab;
  };
  const resting = await check('at rest');
  await page.locator('.fy-board').evaluate(element => element.scrollTo(0, element.scrollHeight));
  await page.waitForTimeout(150);
  const scrolled = await check('scrolled to the end');
  if (Math.abs(scrolled.x - resting.x) > 1) fail('Add card slid sideways while the board scrolled');
  await page.locator('.fy-board').evaluate(element => element.scrollTo(0, 0));
  await page.waitForTimeout(150);
};

const checkDesktop = async (page: Page): Promise<void> => {
  if ((await page.locator('[data-board-add]').count()) !== 1) fail('the desktop board must carry exactly one Add card');
  const add = await boxOf(page, '[data-board-add="header"]');
  const lanes = await boxOf(page, '[data-board-lanes="header"]');
  if (Math.abs(add.y + add.height / 2 - (lanes.y + lanes.height / 2)) > 8) fail('Add card is not on the Lanes row');
  if (meets(add, lanes)) fail('Add card overlaps Lanes');
  if (add.x + add.width > lanes.x) fail('Add card should sit before Lanes in the header');
  if (lanes.x - (add.x + add.width) > 48) fail('Add card is not beside Lanes');
};

const writeCard = async (page: Page): Promise<void> => {
  const form = page.locator('form[role="dialog"]');
  await form.waitFor({ state: 'visible' });
  const heading = await form.locator('.fy-board-reason__heading').textContent();
  if (heading !== 'New card on laptop') fail(`the form opened as "${heading}"`);
  await form.locator('label', { hasText: 'Title' }).locator('input').fill('Fresh card');
  await form.locator('label', { hasText: 'What you want done' }).locator('textarea').fill('Make it');
  await form.locator('label', { hasText: 'Start a ferret' }).locator('input').check();
  await form.locator('button[type="submit"]').click();
  await form.waitFor({ state: 'detached' });
  const made = await page.evaluate(() => (window as unknown as { __created: unknown[] }).__created.length);
  if (made !== 1) fail(`creating a card sent ${made} create requests`);
};

try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const [label, options] of [
      ['phone', PHONE],
      ['desktop', DESKTOP],
    ] as const) {
      const context = await browser.newContext({ ...options, colorScheme: scheme });
      try {
        const page = await open(context, `studio-${scheme}`, label === 'phone');
        if (label === 'phone') await checkPhone(page, options.viewport);
        else await checkDesktop(page);
        await shot(page, `board-add-card-${scheme}-${label}`);
        if (scheme === 'light') {
          await page.locator('[data-board-add]').click();
          await writeCard(page);
        }
        await page.close();
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write('✅ Add card is whole, clear of every control, and opens the form on phone and desktop\n');
} finally {
  await browser.close();
  server.stop();
}
