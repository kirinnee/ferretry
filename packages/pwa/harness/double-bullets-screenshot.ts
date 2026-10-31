/** Shots of a board card whose stored premise/context carry a marker inside each point, drawn with ONE bullet each:
 *   bun harness/double-bullets-screenshot.ts [outDir]    # default /tmp/claude-1000/shots/double-bullets
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'double-bullets');
const shotsDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/double-bullets');

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const PAGES = { detail: 'board-detail' } as const;
type PageName = keyof typeof PAGES;

const html = (theme: string, page: PageName) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/${PAGES[page]}.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });
if (!existsSync(join(packageDir, 'public', 'fy-render-mermaid.js'))) run('bun', ['scripts/build-fy-render-libs.ts']);
for (const entry of Object.values(PAGES)) {
  run('bun', ['build', join(harnessDir, `${entry}.tsx`), '--outdir', buildDir, '--target', 'browser']);
}
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
    if (url.pathname === '/') {
      const page = 'detail';
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark', page), {
        headers: { 'content-type': 'text/html' },
      });
    }
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

const open = async (context: BrowserContext, theme: string, page: PageName, query: string): Promise<Page> => {
  const tab = await context.newPage();
  await tab.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await tab.goto(`${server.url}?theme=${theme}&page=${page}&${query}`);
  await tab.locator('[data-fixture]').waitFor({ state: 'visible' });
  await tab.waitForTimeout(300);
  const wide = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 0) fail(`${page} scrolls sideways by ${wide}px`);
  return tab;
};

const shot = async (page: Page, name: string, fullPage = true): Promise<void> => {
  const path = join(shotsDir, `${name}.png`);
  await page.screenshot({ path, fullPage });
  process.stdout.write(`📸 ${path}\n`);
};

/** The desktop drawer scrolls: grow it to its content so one picture shows the whole card. */
const unscroll = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent =
      '.fy-board-detail, .fy-board-detail__content { position: static !important; max-height: none !important; height: auto !important; overflow: visible !important; }';
    document.head.append(style);
  });
  await page.waitForTimeout(150);
};

const checkDetail = async (page: Page): Promise<void> => {
  const nested = await page
    .locator('[data-section="premise"] li li, [data-section="context"] li li, .fy-attn-points li ul')
    .count();
  if (nested > 0) fail('a point still draws a second bullet');
  const text = await page.locator('.fy-attn-points').first().innerText();
  if (/^\s*[-•]/mu.test(text)) fail('a literal marker is drawn: ' + text);
};

try {
  for (const scheme of ['light', 'dark'] as const) {
    const theme = `studio-${scheme}`;
    for (const [label, device] of [
      ['phone', PHONE],
      ['desktop', DESKTOP],
    ] as const) {
      const context = await browser.newContext({ ...device, colorScheme: scheme });
      try {
        const detail = await open(context, theme, 'detail', 'view=tested&nested=1');
        await checkDetail(detail);
        if (label === 'desktop') {
          await unscroll(detail);
          await shot(detail, `detail-${scheme}-${label}`);
        } else {
          // A phone page scrolls under its pinned comment box: the top, then How to test with the verdict, then
          // the brief's diagram, each as the owner would see it.
          const content = detail.locator('.fy-board-detail__content');
          await content.evaluate(node => node.scrollTo(0, 0));
          await shot(detail, `detail-${scheme}-phone`, false);
        }
        await detail.close();
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop(true);
}
