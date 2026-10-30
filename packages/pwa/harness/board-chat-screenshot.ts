/**
 * Screenshots of one ferret's chat — the slim header and the Info side pane on its Tasks tab — at a 390px
 * phone and a 1440px desktop, light and dark, plus a ferret with no card:
 *
 *   bun harness/board-chat-screenshot.ts [outDir]    # default /tmp/claude-1000, files board-u14-*.png
 *
 * It bundles `board-chat-page.tsx`, serves it on an ephemeral loopback port, aborts anything that leaves it,
 * and fails when the document scrolls sideways.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'board-chat');
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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/board-chat-page.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'board-chat-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
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

const open = async (context: BrowserContext, theme: string, state: 'card' | 'none', tab = 'tasks'): Promise<Page> => {
  const page = await context.newPage();
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.goto(`${server.url}?theme=${theme}&state=${state}&tab=${tab}`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page.locator('[data-session-bar]').first().waitFor({ state: 'visible' });
  if (state === 'card' && tab === 'tasks') await page.locator('.fy-board-card').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(200);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 0) fail(`${state} scrolls sideways by ${wide}px`);
  return page;
};

const shot = async (page: Page, name: string): Promise<void> => {
  const path = join(shotsDir, `board-u14-${name}.png`);
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
        await page.close();
      }
      if (scheme === 'light') {
        const last = await open(phone, theme, 'card', 'surfaces');
        const strip = await last.evaluate(() => {
          const row = document.querySelector('.fy-info__tabs');
          const tab = row?.querySelector<HTMLElement>('[aria-selected="true"]');
          if (!row || !tab) return null;
          const box = tab.getBoundingClientRect();
          const bounds = row.getBoundingClientRect();
          return {
            scrolls: row.scrollWidth > row.clientWidth,
            inView: box.left >= bounds.left - 1 && box.right <= bounds.right + 1,
          };
        });
        if (strip === null || !strip.scrolls || !strip.inView)
          fail(`the Info tab row does not keep the shown tab in view: ${JSON.stringify(strip)}`);
        await shot(last, 'light-phone-last-tab');
        await last.close();
        const page = await open(desktop, theme, 'none');
        await shot(page, 'no-card-desktop');
        await page.close();
      }
    } finally {
      await phone.close();
      await desktop.close();
    }
  }
  process.stdout.write('✅ the chat captured; nothing scrolls sideways\n');
} finally {
  await browser.close();
  server.stop();
}
