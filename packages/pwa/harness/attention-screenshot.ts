/**
 * Screenshots of every Attention surface, at a 390px phone and a 1440px desktop, light and dark:
 *
 *   inbox-phone / inbox-desktop   the list; on desktop beside the selected item chat
 *   panel-phone / panel-desktop   the pinned item above the composer
 *   details-phone / -desktop      the same, Details open
 *   task-*                       a step-by-step to-do: ticked partly / fully, waiting on the ferret, the
 *                                 phone deck mid-swipe right (Done) and left (Need more info), the desktop inbox
 *   sidebar / rail / drawer       unread rows, the Needs-you group, the Attention entry, the rail badges
 *
 *   bun scripts/build-fy-render-libs.ts      # once: the Mermaid sandbox the task scenes render
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
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/')
      return new Response(html(url.searchParams.get('theme') ?? 'studio-dark'), {
        headers: { 'content-type': 'text/html' },
      });
    const built = Bun.file(join(outDir, url.pathname));
    // The fy-render sandbox shell and its libraries (`bun scripts/build-fy-render-libs.ts`) live in public/.
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

const shot = async (page: Page, scheme: string, name: string, fullPage = false): Promise<void> => {
  const dir = join(outDir, scheme);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.png`);
  await page.screenshot({ path, fullPage });
  process.stdout.write(`📸 ${path}\n`);
};

try {
  for (const scheme of ['light', 'dark'] as const) {
    const theme = `studio-${scheme}`;
    const phone = await browser.newContext({ ...PHONE, colorScheme: scheme });
    const desktop = await browser.newContext({ ...DESKTOP, colorScheme: scheme });
    try {
      let page = await open(phone, theme, 'inbox-phone');
      await shot(page, scheme, 'inbox-phone');
      await page.close();
      page = await open(desktop, theme, 'inbox-desktop');
      await shot(page, scheme, 'inbox-desktop', true);
      await page.close();
      for (const [label, context] of [
        ['phone', phone],
        ['desktop', desktop],
      ] as const) {
        page = await open(context, theme, 'panel');
        await shot(page, scheme, `panel-${label}`);
        await page.close();
        page = await open(context, theme, 'long');
        await page.locator('[data-attention-details]').first().click();
        await page.waitForTimeout(200);
        await shot(page, scheme, `details-${label}`);
        await page.close();
        page = await open(context, theme, 'board');
        await shot(page, scheme, `board-${label}`);
        await page.close();
      }

      for (const [label, context] of [
        ['phone', phone],
        ['desktop', desktop],
      ] as const) {
        for (const view of ['task-partial', 'task-full', 'task-waiting']) {
          page = await open(context, theme, view);
          // Scroll only the card's own middle, never the panel: the header and actions stay on screen.
          await page
            .locator('[data-attention-scroll]')
            .first()
            .evaluate((el, waiting) => {
              el.scrollTop = waiting
                ? el.scrollHeight
                : ((el.querySelector('[data-attention-step="2"]') as HTMLElement | null)?.offsetTop ?? 0);
            }, view === 'task-waiting');
          await page.waitForTimeout(150);
          await shot(page, scheme, `${view}-${label}`);
          await page.close();
        }
      }
      page = await open(desktop, theme, 'task-inbox-desktop');
      await shot(page, scheme, 'task-inbox-desktop', true);
      await page.close();
      for (const [direction, sign] of [
        ['right', 1],
        ['left', -1],
      ] as const) {
        page = await open(phone, theme, 'task-inbox-phone');
        const box = await page.locator('.fy-attn-deck__top').boundingBox();
        if (box === null) fail('no deck card to swipe');
        else {
          const y = box.y + box.height - 14;
          await page.mouse.move(box.x + box.width / 2, y);
          await page.mouse.down();
          await page.mouse.move(box.x + box.width / 2 + sign * 60, y, { steps: 4 });
          await page.mouse.move(box.x + box.width / 2 + sign * 110, y, { steps: 4 });
          await page.waitForTimeout(250);
          await shot(page, scheme, `task-swipe-${direction}-phone`);
          await page.mouse.up();
        }
        await page.close();
      }

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
