/**
 * Screenshots of the side panel's Agenda tab on each of its four filters, at a 390px phone and a 1440px desktop,
 * light and dark, in the app's own typefaces:
 *
 *   bun harness/agenda-tab-screenshot.ts [outDir]   # default /tmp/claude-1000/shots/f559-pr6, agenda-tab-*.png
 *
 * It bundles `board-chat-page.tsx` (`tab=agenda&filter=…`), serves it on a loopback port, aborts anything that leaves
 * it, and fails when the document scrolls sideways or a chip's count differs from the rows listed under it.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'agenda-tab');
const shotsDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/f559-pr6');

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
    if (url.pathname.startsWith('/assets/fonts/')) return new Response(Bun.file(join(packageDir, 'src', url.pathname)));
    const built = Bun.file(join(buildDir, url.pathname));
    return new Response((await built.exists()) ? built : Bun.file(join(packageDir, 'public', url.pathname)));
  },
});

const executablePath =
  Bun.which('google-chrome') ?? Bun.which('chromium') ?? Bun.which('chromium-browser') ?? fail('no Chrome or Chromium');
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
const FILTERS = ['needs-you', 'resting', 'snoozed', 'resolved'] as const;

const shoot = async (context: BrowserContext, theme: string, filter: string, name: string): Promise<void> => {
  const page = await context.newPage();
  page.on('pageerror', error => console.error('pageerror', error.message));
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.goto(`${server.url}?theme=${theme}&state=card&tab=agenda&filter=${filter}`);
  await page.locator('[data-agenda-tab]').waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 0) fail(`${name} scrolls sideways by ${wide}px`);
  const shown = await page.locator('[data-agenda-tab-row]').count();
  const count = Number(await page.locator(`[data-context-chip="${filter}"] .mono`).textContent());
  if (count !== shown) fail(`${name}: the chip says ${String(count)}, the list has ${String(shown)}`);
  await page.locator(`[data-context-chip="${filter}"]`).evaluate(chip => {
    if (chip.getAttribute('aria-pressed') !== 'true') throw new Error('the filter is not the one shown');
  });
  const path = join(shotsDir, `agenda-tab-${name}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
  await page.close();
};

try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const [label, device] of [
      ['phone', PHONE],
      ['desktop', DESKTOP],
    ] as const) {
      const context = await browser.newContext({ ...device, colorScheme: scheme });
      try {
        for (const filter of FILTERS) await shoot(context, `studio-${scheme}`, filter, `${filter}-${scheme}-${label}`);
      } finally {
        await context.close();
      }
    }
  }
  process.stdout.write('✅ the Agenda tab captured; nothing scrolls sideways; every count is its list\n');
} finally {
  await browser.close();
  server.stop();
}
