/**
 * Screenshots of the Attention PAGE as the owner meets it — ten open items in two conversations on two
 * machines — at a 1440px and a 1280px desktop and a 390px phone, light and dark:
 *
 *   page-desktop-1440 / -1280    the grouped list beside the selected item's card, full pane height
 *   page-desktop-recent-1440     the same card with "Last messages from <ferret>" open
 *   page-desktop-next-1440       right after answering the selected item: the next one is selected
 *   page-desktop-folded-1440     one conversation folded, Find narrowing the other
 *   page-phone-list              the phone's list
 *   page-phone-card              a tapped row's card, full screen above the tab bar
 *   page-phone-card-recent       the same with "Last messages" open
 *
 *   bun harness/attention-page-screenshot.ts      # writes harness/out/attention-page/<scheme>/*.png
 *
 * It bundles `attention-page.tsx` (real components, invented data), serves it on an ephemeral loopback
 * port, aborts anything that leaves it, and FAILS when a page scrolls sideways, when the card's answer
 * bar is off screen or under the tab bar, when a row is headed by its conversation's name, or when ↓ /
 * answering does not move the selection.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const outDir = join(harnessDir, 'out', 'attention-page');

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
const desktop = (width: number) => ({ viewport: { width, height: 900 } }) as const;

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

/** The row of item `id` (the keys are JSON, so match on the title cell's row by its item id). */
const row = (page: Page, id: string) => page.locator(`[data-attention-row*='"${id}"]']`);

const selectedId = async (page: Page): Promise<string | null> =>
  await page
    .locator('[data-attention-pane] [data-attention-card]')
    .first()
    .getAttribute('data-attention-card')
    .catch(() => null);

/** The card's answer bar is whole on screen, above `floor` (the viewport bottom, or the tab bar's top). */
const answerBarFits = async (page: Page, label: string, floor?: number): Promise<void> => {
  const bar = await page.locator('[data-attention-answer]').first().boundingBox();
  if (bar === null) fail(`${label}: no answer bar`);
  const limit = floor ?? page.viewportSize()?.height ?? 0;
  if (bar !== null && bar.y + bar.height > limit + 0.5)
    fail(`${label}: the answer bar ends at ${Math.round(bar.y + bar.height)}px, below ${Math.round(limit)}px`);
};

/** No row is headed by its conversation's name. */
const rowsHeadedByItems = async (page: Page, label: string): Promise<void> => {
  const titles = await page.locator('[data-attention-row-title]').allTextContents();
  if (titles.length === 0) fail(`${label}: no rows`);
  if (titles.some(title => title === 'diene-migrate' || title === 'Relay advertisement'))
    fail(`${label}: a row is headed by its conversation's name`);
  if (new Set(titles).size !== titles.length) fail(`${label}: two rows share a title`);
};

try {
  for (const scheme of ['light', 'dark'] as const) {
    const theme = `studio-${scheme}`;
    const phone = await browser.newContext({ ...PHONE, colorScheme: scheme });
    try {
      for (const width of [1_440, 1_280]) {
        const context = await browser.newContext({ ...desktop(width), colorScheme: scheme });
        try {
          let page = await open(context, theme, 'page');
          await rowsHeadedByItems(page, `desktop ${width}`);
          if ((await page.locator('[data-attention-group]').count()) !== 2) fail('expected two groups');
          await row(page, 'A10').click();
          await page.waitForTimeout(150);
          if ((await selectedId(page)) !== 'A10') fail('clicking a row did not select it');
          await answerBarFits(page, `desktop ${width}`);
          await shot(page, scheme, `page-desktop-${width}`);
          if (width === 1_440) {
            // ↓ twice (the second as j) walks the list.
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('j');
            await page.waitForTimeout(100);
            if ((await selectedId(page)) !== 'A8') fail(`↓ j from A10 selected ${await selectedId(page)}, not A8`);
            await page.keyboard.press('k');
            await page.waitForTimeout(100);
            if ((await selectedId(page)) !== 'A9') fail('k did not step back');
            // Answering selects the next item, not the top of the list.
            await page.locator('[data-attention-pane] [data-attention-answer="right"]').click();
            await page.waitForTimeout(200);
            if ((await selectedId(page)) !== 'A8') fail(`answering A9 selected ${await selectedId(page)}, not A8`);
            await shot(page, scheme, `page-desktop-next-${width}`);
            await page.close();

            page = await open(context, theme, 'page-recent');
            await row(page, 'A10').click();
            await page.locator('[data-attention-recent-list]').waitFor({ state: 'visible' });
            await page
              .locator('[data-attention-pane] [data-attention-scroll]')
              .evaluate(element => element.scrollTo({ top: element.scrollHeight }));
            await page.waitForTimeout(150);
            await answerBarFits(page, 'desktop recent');
            await shot(page, scheme, `page-desktop-recent-${width}`);
            await page.close();

            page = await open(context, theme, 'page');
            await page.locator('[data-attention-group-toggle]').first().click();
            await page.locator('[data-attention-find]').fill('token');
            await page.waitForTimeout(150);
            if ((await page.locator('[data-attention-row]').count()) !== 1) fail('Find "token" kept other rows');
            await shot(page, scheme, `page-desktop-folded-${width}`);
          }
          await page.close();
        } finally {
          await context.close();
        }
      }

      let page = await open(phone, theme, 'page');
      await rowsHeadedByItems(page, 'phone');
      await shot(page, scheme, 'page-phone-list');
      await row(page, 'A10').click();
      await page.locator('[data-attention-inbox="card"]').waitFor({ state: 'visible' });
      await page.close();
      for (const view of ['page-card', 'page-card-recent']) {
        page = await open(phone, theme, view);
        if (view === 'page-card-recent') {
          await page.locator('.fy-attn-deck__top [data-attention-recent-list]').waitFor({ state: 'visible' });
          await page
            .locator('.fy-attn-deck__top [data-attention-scroll]')
            .evaluate(element => element.scrollTo({ top: element.scrollHeight }));
          await page.waitForTimeout(150);
        }
        const tabs = await page.locator('[data-app-tab-bar]').boundingBox();
        await answerBarFits(page, view, tabs?.y);
        await shot(page, scheme, `page-phone-${view.replace('page-', '')}`);
        await page.close();
      }
    } finally {
      await phone.close();
    }
  }
  process.stdout.write('✅ the Attention page captured; rows are items, the card fits, selection moves\n');
} finally {
  await browser.close();
  server.stop();
}
