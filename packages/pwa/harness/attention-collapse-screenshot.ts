/**
 * Screenshots of the pinned Attention card folding, at a 390px phone and a 1440px desktop, light and dark:
 *
 *   expanded-*   the card with its ⌄ in the header (three items, so the pager shows too)
 *   folded-*     the same conversation after pressing ⌄: one slim line above the composer
 *
 *   bun scripts/build-fy-render-libs.ts            # once
 *   bun harness/attention-collapse-screenshot.ts   # writes harness/out/attention-collapse/<scheme>/*.png
 *
 * It also checks what a picture cannot: the folded line is ONE line, the page never scrolls sideways,
 * pressing the line unfolds the card, and Enter on the focused ⌄ folds it.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out', 'attention-collapse');

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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/attention-collapse-page.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'attention-collapse-page.tsx'), '--outdir', outDir, '--target', 'browser']);
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
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    const built = Bun.file(join(outDir, url.pathname));
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
        let page = await open(context, theme, 'several');
        const fold = page.locator('[data-attention-collapse]');
        if ((await fold.getAttribute('aria-expanded')) !== 'true') fail('the fold button is not expanded');
        await shot(page, scheme, `expanded-${label}`);

        // Keyboard: focus the ⌄ and press Enter.
        await fold.focus();
        await page.keyboard.press('Enter');
        const line = page.locator('[data-attention-collapsed]');
        await line.waitFor({ state: 'visible' });
        if ((await line.getAttribute('aria-expanded')) !== 'false') fail('the folded line is not collapsed');
        const box = await line.boundingBox();
        if (box === null || box.height > 48) fail(`the folded line is not one slim line (${box?.height}px tall)`);
        if ((await page.locator('[data-attention-card]').count()) > 0) fail('a folded card still drew the card');
        await shot(page, scheme, `folded-${label}`);

        // Reload: the fold is remembered on this device.
        await page.reload();
        await page.locator('[data-attention-collapsed]').waitFor({ state: 'visible' });
        await page.locator('[data-attention-collapsed]').click();
        await page.locator('[data-attention-card]').waitFor({ state: 'visible' });
        await page.close();

        page = await open(context, theme, 'one');
        await page.locator('[data-attention-collapse]').click();
        await shot(page, scheme, `folded-one-${label}`);
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
