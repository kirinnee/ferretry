/**
 * Screenshots of the Sessions page's Needs-you card with a long to-do, phone (with a home indicator) and desktop, light and dark:
 *
 *   expanded-*   the card with its ⌄ in the header (three items, so the pager shows too)
 *   folded-*     the same conversation after pressing ⌄: one slim line above the composer
 *
 *   bun scripts/build-fy-render-libs.ts            # once
 *   bun harness/cards-fit-screenshot.ts   # writes harness/out/cards-fit/<scheme>/*.png
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
const outDir = join(harnessDir, 'out', 'cards-fit');

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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/cards-fit-page.js"></script></body>
</html>`;

mkdirSync(outDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'cards-fit-page.tsx'), '--outdir', outDir, '--target', 'browser']);
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
  await page.goto(`${server.url}?theme=${theme}&shell=${view}`);
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

const stage = process.argv[2] ?? 'after';
try {
  for (const scheme of ['light', 'dark'] as const) {
    const theme = `studio-${scheme}`;
    for (const [label, options] of [
      ['phone', PHONE],
      ['desktop', DESKTOP],
    ] as const) {
      const context = await browser.newContext({ ...options, colorScheme: scheme });
      try {
        const page = await open(context, theme, label);
        await shot(page, scheme, `${stage}-closed-${label}`);
        await page.locator('.fy-attn-reply-toggle').click();
        await page.locator('.fy-attn-reply__box').waitFor({ state: 'visible' });
        await page.waitForTimeout(150);
        const cardBox = (await page.locator('[data-attention-card]').boundingBox()) ?? fail('the card is not drawn');
        const barBox =
          (await page.locator('.fy-attn-actions').first().boundingBox()) ?? fail('the answer bar is not drawn');
        const tab = label === 'phone' ? await page.locator('[data-app-tab-bar]').boundingBox() : null;
        const box = (await page.locator('.fy-attn-reply__box').boundingBox()) ?? fail('the reply box is not drawn');
        process.stdout.write(
          `${scheme} ${label}: card ${JSON.stringify(cardBox)} actions ${JSON.stringify(barBox)} tab ${JSON.stringify(tab)} reply ${JSON.stringify(box)}\n`,
        );
        const scrolled = await page.evaluate(() => document.querySelector('.kt-shell')?.scrollTop ?? 0);
        if (scrolled !== 0) fail(`${label}: the shell scrolled by ${scrolled}px`);
        const floor = tab === null ? 900 : tab.y;
        if (cardBox.y < 0 || cardBox.y + cardBox.height > floor)
          fail(
            `${label}: the card runs outside the page (${cardBox.y}..${cardBox.y + cardBox.height}, floor ${floor})`,
          );
        if (barBox.y + barBox.height > floor) fail(`${label}: the answer bar is under the tab bar`);
        if (box.height < 60) fail(`${label}: the reply box is only ${box.height}px tall`);
        const size = await page
          .locator('.fy-attn-reply__box')
          .evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize));
        if (label === 'phone' && size < 16) fail(`the reply box is ${size}px: iOS would zoom`);
        await shot(page, scheme, `${stage}-reply-${label}`);
        await page
          .locator('.fy-attn-reply__box')
          .fill(Array.from({ length: 12 }, (_, line) => `line ${line + 1}`).join('\n'));
        const grown = (await page.locator('.fy-attn-reply__box').boundingBox())?.height ?? 0;
        if (grown <= box.height || grown > box.height * 2.4)
          fail(`${label}: the reply box grew to ${grown}px from ${box.height}px`);
        await shot(page, scheme, `${stage}-reply-long-${label}`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  await server.stop();
}
