/**
 * Screenshots of where an answer stands, at a 390px phone and a 1440px desktop, light and dark:
 *
 *   sending-*      the card with "Sending…" under its header
 *   undelivered-*  the card with "Your answer didn't reach <ferret>" and Retry
 *   discussing-*   the chat panel: an item "In discussion" as one slim line, an answered item "Sending…"
 *
 *   bun scripts/build-fy-render-libs.ts               # once
 *   bun harness/attention-delivery-screenshot.ts      # writes <repo>/assets/attention-delivery/<scheme>/*.png
 *
 * The PNGs are NOT committed on the feature branch (screenshots live on an `assets/*` branch). It also
 * checks what a picture cannot: the strips carry their roles, Retry is a real enabled button, the
 * discussion line is ONE slim line, and the page never scrolls sideways.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'attention-delivery');
const outDir = resolve(packageDir, '..', '..', 'assets', 'attention-delivery');

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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/attention-delivery-page.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'attention-delivery-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
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

const shot = async (page: Page, scheme: string, name: string): Promise<void> => {
  const dir = join(outDir, scheme);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
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
        let page = await open(context, theme, 'sending');
        const sending = page.locator('[data-attention-card] [data-attention-delivery="sending"]');
        await sending.waitFor({ state: 'visible' });
        if ((await sending.getAttribute('role')) !== 'status') fail('"Sending…" is not a status');
        await shot(page, scheme, `sending-${label}`);
        await page.close();

        page = await open(context, theme, 'undelivered');
        const retry = page.locator('[data-attention-delivery="undelivered"] button[data-attention-retry]');
        await retry.waitFor({ state: 'visible' });
        if (!(await retry.isEnabled())) fail('Retry is disabled');
        if ((await page.locator('[data-attention-delivery="undelivered"]').getAttribute('role')) !== 'alert')
          fail('the undelivered strip is not an alert');
        await shot(page, scheme, `undelivered-${label}`);
        await page.close();

        page = await open(context, theme, 'discussing');
        const line = page.locator('[data-attention-discussing]');
        await line.waitFor({ state: 'visible' });
        const box = await line.boundingBox();
        if (box === null || box.height > 48) fail(`the discussion line is not one slim line (${box?.height}px tall)`);
        if ((await page.locator('[data-attention-card]').count()) > 0) fail('a discussing item drew a card');
        if ((await page.locator('[data-attention-sending-line]').count()) !== 1)
          fail('no "Sending…" line for the answered item');
        await shot(page, scheme, `discussing-${label}`);
        await page.close();
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  await server.stop();
}
