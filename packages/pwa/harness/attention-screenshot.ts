/**
 * Screenshots of every Attention surface, at a 390px phone and a 1440px desktop, light and dark:
 *
 *   inbox-phone / inbox-desktop   three cards (options, none, long context) + the phone's Attention tab
 *   swipe-mid                     a drag past the slop but short of the threshold, the option showing
 *   undo                          the toast after a committed swipe
 *   panel-phone / panel-desktop   the in-ferret panel over a transcript line with a proved `!A3`
 *   sidebar / rail / drawer       unread rows, the Needs-you group, the Attention entry, the rail badges
 *
 *   bun harness/attention-screenshot.ts      # writes harness/out/attention/<scheme>/*.png
 *
 * It bundles `attention-page.tsx` (real components, invented data), serves it on an ephemeral loopback
 * port, aborts anything that leaves it, and fails when a page scrolls sideways.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out', 'attention');

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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/attention-page.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'attention-page.tsx'), '--outdir', outDir, '--target', 'browser']);
run('./node_modules/.bin/tailwindcss', [
  '--config',
  'tailwind.config.ts',
  '--input',
  'src/styles/index.css',
  '--output',
  join(outDir, 'app.css'),
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
    return new Response(Bun.file(join(outDir, url.pathname)));
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

const open = async (context: BrowserContext, theme: string, view: string): Promise<Page> => {
  const page = await context.newPage();
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.goto(`${server.url}?theme=${theme}&view=${view}`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page.waitForTimeout(150);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 0) fail(`${view} scrolls sideways by ${wide}px`);
  return page;
};

const shot = async (page: Page, scheme: string, name: string, fullPage = false): Promise<void> => {
  const dir = join(outDir, scheme);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.png`);
  await page.screenshot({ path, fullPage });
  process.stdout.write(`📸 ${path}\n`);
};

/** Drags the deck's top card `dx` to the right with a real pointer, optionally letting go. */
const drag = async (page: Page, dx: number, release: boolean): Promise<void> => {
  const top = page.locator('[data-attention-deck] [data-attention-card]').first();
  const box = (await top.boundingBox()) ?? fail('no top card in the deck');
  // Grab the card by its header, away from the buttons and the reply box.
  const x = box.x + box.width / 2;
  const y = box.y + 24;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) await page.mouse.move(x + (dx * step) / 8, y);
  if (release) await page.mouse.up();
  await page.waitForTimeout(250);
};

try {
  for (const scheme of ['light', 'dark'] as const) {
    const theme = `studio-${scheme}`;
    const phone = await browser.newContext({ ...PHONE, colorScheme: scheme });
    const desktop = await browser.newContext({ ...DESKTOP, colorScheme: scheme });
    try {
      let page = await open(phone, theme, 'inbox-phone');
      await shot(page, scheme, 'inbox-phone');
      await drag(page, 90, false);
      await shot(page, scheme, 'swipe-mid-phone');
      await page.mouse.move(390, 200);
      await page.mouse.up();
      await page.waitForTimeout(400);
      await shot(page, scheme, 'undo-phone');
      await page.close();

      page = await open(desktop, theme, 'inbox-desktop');
      await shot(page, scheme, 'inbox-desktop', true);
      await page.locator('[data-attention-option="Rebase now"]').first().click();
      await page.waitForTimeout(250);
      await shot(page, scheme, 'undo-desktop');
      await page.close();

      page = await open(phone, theme, 'panel');
      await shot(page, scheme, 'panel-phone', true);
      await page.close();
      page = await open(desktop, theme, 'panel');
      await shot(page, scheme, 'panel-desktop', true);
      await page.close();

      page = await open(desktop, theme, 'column');
      await shot(page, scheme, 'sidebar-desktop');
      await page.close();
      page = await open(desktop, theme, 'rail');
      await shot(page, scheme, 'rail-desktop');
      await page.close();
      page = await open(phone, theme, 'drawer');
      await shot(page, scheme, 'drawer-phone');
      await page.close();
    } finally {
      await phone.close();
      await desktop.close();
    }
  }
  process.stdout.write('✅ every Attention surface captured; nothing scrolls sideways\n');
} finally {
  await browser.close();
  server.stop();
}
