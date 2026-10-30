/**
 * Screenshots of the Board's card detail at a 390px phone and a 1440px desktop, light and dark, plus a
 * 🧪 To test card and a card with a blocking ask:
 *
 *   bun harness/board-detail-screenshot.ts [outDir]    # default /tmp/claude-1000, files board-detail-v2-*.png
 *
 * It bundles `board-detail.tsx` (the real page with a card open, invented cards), serves it on an ephemeral
 * loopback port, aborts anything that leaves it, and fails when a page scrolls sideways.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'board-detail');
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/board-detail.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'board-detail.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
const DESKTOP = { viewport: { width: 1_440, height: 1_500 } } as const;

const open = async (context: BrowserContext, theme: string, view: string): Promise<Page> => {
  const page = await context.newPage();
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.goto(`${server.url}?theme=${theme}&view=${view}`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page.locator('.fy-board-detail').waitFor({ state: 'visible' });
  await page.locator('.fy-board-detail h2, .fy-board-detail h1').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 0) fail(`${view} scrolls sideways by ${wide}px`);
  return page;
};

/** A one-pixel PNG, as a picked file. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const shot = async (page: Page, name: string): Promise<void> => {
  const path = join(shotsDir, `board-detail-v2-${name}.png`);
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
        const page = await open(context, theme, 'card');
        await shot(page, `${scheme}-${label}`);
        if (label === 'phone') {
          await page.locator('.fy-board-detail__content').evaluate(node => node.scrollTo(0, node.scrollHeight));
          await page.waitForTimeout(100);
          await shot(page, `${scheme}-phone-end`);
        }
        await page.close();
      }
      if (scheme === 'light') {
        const bare = await open(desktop, theme, 'empty');
        await shot(bare, 'empty-desktop');
        await bare.close();
        for (const view of ['tested', 'ask'] as const) {
          const page = await open(desktop, theme, view);
          await shot(page, `${view}-desktop`);
          await page.close();
          const small = await open(phone, theme, view);
          await shot(small, `${view}-phone`);
          await small.close();
        }
      }
      // The verdict on a card to try: Not good opens the composer (words and a picture); Close spins in place.
      for (const [label, context] of [
        ['phone', phone],
        ['desktop', desktop],
      ] as const) {
        const page = await open(context, theme, 'tested');
        const detail = page.locator('.fy-board-detail');
        await detail.locator('[data-verdict="not-good"]').click();
        const composer = page.locator('[data-board-send-back]');
        await composer.locator('.fy-board-sendback__attach:not([disabled])').waitFor({ state: 'visible' });
        await composer.locator('[aria-label="Reason"]').fill('Pairing worked, but the QR is cut off on a small phone.');
        await composer.locator('[data-send-back-picker]').setInputFiles([
          { name: 'qr-cut-off.png', mimeType: 'image/png', buffer: PIXEL },
          { name: 'settings.png', mimeType: 'image/png', buffer: PIXEL },
        ]);
        await composer.locator('[aria-label="Attached files"] li').nth(1).waitFor({ state: 'visible' });
        await shot(page, `not-good-${scheme}-${label}`);
        await composer.locator('button', { hasText: 'Cancel' }).click();
        const works = detail.locator('[data-verdict="works"]');
        const before = await works.boundingBox();
        await works.click();
        await detail.locator('[data-verdict="works"][data-pending] [data-spinner]').waitFor({ state: 'visible' });
        const after = await works.boundingBox();
        if (before === null || after === null || Math.abs(before.width - after.width) > 0.5)
          fail('Close changed width while it spins');
        if (!(await detail.locator('[data-verdict="not-good"]').isDisabled()))
          fail('Not good is pressable while Close is on its way');
        await shot(page, `in-flight-${scheme}-${label}`);
        await page.close();
      }
    } finally {
      await phone.close();
      await desktop.close();
    }
  }
  process.stdout.write('✅ the card detail captured; nothing scrolls sideways\n');
} finally {
  await browser.close();
  server.stop();
}
