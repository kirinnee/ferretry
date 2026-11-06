/**
 * Screenshots of the Queue page over a long history, at a 390px phone and a 1440px desktop, light and dark:
 * the first page the machine answers (the newest messages and the two still waiting from long ago), and the
 * page after "Show older messages" was pressed twice.
 *
 *   bun harness/queue-page-screenshot.ts [outDir]    # default /tmp/claude-1000, files queue-page-*.png
 *
 * It bundles `tests/integration/fixtures/queue-page-scene.tsx` (the real `QueuePageView` over invented
 * messages and a fake machine), serves it on an ephemeral loopback port, aborts anything that leaves it, and
 * fails when a page scrolls sideways.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'queue-page');
const shotsDir = resolve(process.argv.slice(2).find(argument => !argument.startsWith('--')) ?? '/tmp/claude-1000');

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
    <style>html, body, #root { height: 100%; margin: 0; }</style>
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/queue-page-scene.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });
run('bun', [
  'build',
  join(packageDir, 'tests/integration/fixtures/queue-page-scene.tsx'),
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
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-light'), {
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

const open = async (context: BrowserContext, theme: string): Promise<Page> => {
  const page = await context.newPage();
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  page.on('pageerror', error => process.stderr.write(`page error: ${error.message}\n`));
  await page.goto(`${server.url}?theme=${theme}`);
  await page.locator('[data-queue-row]').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(200);
  return page;
};

const noSidewaysScroll = async (page: Page, label: string): Promise<void> => {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 0) fail(`${label} scrolls sideways by ${wide}px`);
};

const shot = async (page: Page, name: string): Promise<void> => {
  const path = join(shotsDir, `queue-page-${name}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

try {
  for (const scheme of ['light', 'dark'] as const)
    for (const [label, device] of [
      ['phone', PHONE],
      ['desktop', DESKTOP],
    ] as const) {
      const context = await browser.newContext({ ...device, colorScheme: scheme });
      try {
        const page = await open(context, `studio-${scheme}`);
        const name = `${label}-${scheme}`;
        process.stdout.write(`${name}: ${await page.locator('[data-queue-row]').count()} rows on the first page\n`);
        await noSidewaysScroll(page, `${name} first page`);
        await shot(page, `${name}-first-page`);
        await page.locator('[data-queue-older]').click();
        await page.locator('[data-queue-older]').click();
        await page.waitForTimeout(200);
        process.stdout.write(`${name}: ${await page.locator('[data-queue-row]').count()} rows after two older pages\n`);
        await noSidewaysScroll(page, `${name} after older`);
        await page.locator('[data-queue-older]').scrollIntoViewIfNeeded();
        await shot(page, `${name}-after-older`);
      } finally {
        await context.close();
      }
    }
  process.stdout.write('✅ the queue page captured\n');
} finally {
  await browser.close();
  server.stop(true);
}
