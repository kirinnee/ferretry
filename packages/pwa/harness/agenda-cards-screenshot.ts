/**
 * Screenshots of the v2 agenda card — one per kind, plus the deck mid-swipe-up — at a 390px phone
 * and a 1440px desktop, light and dark:
 *
 *   task / choice / yesno / permission / review / info / reply   <state>-<phone|desktop>.png
 *   lane-change / -grouped / -hidden                             a ferret's lane proposal; the last has no Accept
 *   swipe-up                                                     the to-do dragged up toward its Skip
 *
 *   bun scripts/build-fy-render-libs.ts           # once: the Mermaid sandbox some cards render
 *   bun harness/agenda-cards-screenshot.ts     # writes harness/out/agenda-cards/<scheme>/*.png
 *
 * It bundles `agenda-cards-page.tsx` (real components, invented data), serves it on an ephemeral
 * loopback port, aborts anything that leaves it, and fails when a page scrolls sideways.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out', 'agenda-cards');

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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/agenda-cards-page.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'agenda-cards-page.tsx'), '--outdir', outDir, '--target', 'browser']);
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

const KINDS = [
  'task',
  'choice',
  'yesno',
  'permission',
  'review',
  'info',
  'reply',
  'lane-change',
  'lane-change-grouped',
  'lane-change-hidden',
] as const;
// The Discuss states: the in-discussion card, and the replies notice counting down and held for a turn.
const DISCUSS_VIEWS = ['in-discussion', 'replies-countdown', 'replies-held'] as const;

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
        for (const kind of [...KINDS, ...DISCUSS_VIEWS]) {
          const page = await open(context, theme, kind);
          await shot(page, scheme, `${kind}-${label}`);
          if (kind.startsWith('lane-change')) {
            // Its answers sit below a long list of warnings: scrolled to them, they are Edit and Later, never Accept.
            await page.evaluate(() => {
              for (const node of document.querySelectorAll<HTMLElement>('*')) {
                if (node.scrollHeight > node.clientHeight) node.scrollTop = node.scrollHeight;
              }
            });
            await page.waitForTimeout(100);
            await shot(page, scheme, `${kind}-end-${label}`);
          }
          await page.close();
        }
        // Dragged down from the title (a link would start a native drag), held short of the threshold: the stamp says Discuss.
        const down = await open(context, theme, 'discuss-swipe');
        const downBox = await down.locator('.fy-attn-deck__top').boundingBox();
        if (downBox === null) fail('no deck card to swipe down');
        else {
          const x = downBox.x + downBox.width / 2;
          const y = downBox.y + 72;
          await down.mouse.move(x, y);
          await down.mouse.down();
          await down.mouse.move(x, y + 50, { steps: 4 });
          await down.mouse.move(x, y + 100, { steps: 4 });
          await down.waitForTimeout(250);
          await shot(down, scheme, `discuss-swipe-down-${label}`);
          await down.mouse.up();
        }
        await down.close();
        // Dragged up, held short of the threshold: the stamp names the third answer and the card follows.
        const page = await open(context, theme, 'task-swipe');
        const box = await page.locator('.fy-attn-deck__top').boundingBox();
        if (box === null) fail('no deck card to swipe');
        else {
          const x = box.x + box.width / 2;
          const y = box.y + box.height - 14;
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(x, y - 50, { steps: 4 });
          await page.mouse.move(x, y - 100, { steps: 4 });
          await page.waitForTimeout(250);
          await shot(page, scheme, `swipe-up-${label}`);
          await page.mouse.up();
        }
        await page.close();
      }
    } finally {
      await phone.close();
      await desktop.close();
    }
  }
  process.stdout.write('✅ every agenda card captured; nothing scrolls sideways\n');
} finally {
  await browser.close();
  server.stop();
}
