/**
 * The Board opened from a chat: default (that ferret's cards, filters folded), the Filters panel, and the
 * one-tap "All cards" view, at a 390px phone and a 1440px desktop, light and dark.
 *
 *   bun harness/board-scope-screenshot.ts [outDir]    # default /tmp/claude-1000, files declutter-board-*.png
 *
 * It reuses the Board harness bundle (`board-screenshot.ts` builds it) and aborts anything off the loopback.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'board-scope');
const shotsDir = resolve(process.argv[2] ?? '/tmp/claude-1000');
const FERRET = 'mvuc7tsf-0c3d50df';

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

const VIEWPORTS = {
  phone: {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  },
  desktop: { viewport: { width: 1_440, height: 900 } },
} as const;

const ready = async (page: Page, theme: string, from: boolean): Promise<void> => {
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.goto(`${server.url}?theme=${theme}&view=kanban${from ? `&from=${FERRET}` : ''}`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page.locator('.fy-board-card, .fy-board__empty').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(250);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 0) fail(`scrolls sideways by ${wide}px`);
};

const shot = async (page: Page, name: string): Promise<void> => {
  const path = join(shotsDir, `declutter-board-${name}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const [label, options] of Object.entries(VIEWPORTS)) {
      const context = await browser.newContext({ ...options, colorScheme: scheme });
      try {
        const theme = `studio-${scheme}`;
        const page = await context.newPage();
        await ready(page, theme, true);
        const state = await page.locator('[data-board-scope]').getAttribute('data-board-scope');
        if (state !== 'ferret') fail(`opened from a chat but the scope is ${state}`);
        await shot(page, `${label}-${scheme}-mine`);

        await page.locator('.fy-board-filters__toggle').first().click();
        await page.waitForTimeout(450);
        await shot(page, `${label}-${scheme}-filters`);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(250);

        await page.locator('[data-scope="all"]').click();
        await page.waitForTimeout(300);
        await shot(page, `${label}-${scheme}-all-cards`);
        await page.close();
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write('✅ the scoped board captured; nothing scrolls sideways\n');
} finally {
  await browser.close();
  server.stop();
}
