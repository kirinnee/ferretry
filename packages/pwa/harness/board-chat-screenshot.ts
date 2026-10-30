/**
 * Screenshots of one ferret's chat — the slim header and the Info side pane on its Tasks tab, as a Kanban and
 * as a List over 70 cards, and a card's drawer over the chat — at a 390px phone and a 1440px desktop, light
 * and dark, plus a ferret with no card:
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

const open = async (
  context: BrowserContext,
  theme: string,
  state: 'card' | 'none',
  tab = 'tasks',
  view: 'kanban' | 'list' = 'kanban',
  extra = '',
): Promise<Page> => {
  const page = await context.newPage();
  page.on('pageerror', error => console.error('pageerror', error.message));
  page.on('console', m => m.type() === 'error' && console.error('console', m.text()));
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.goto(`${server.url}?theme=${theme}&state=${state}&tab=${tab}&view=${view}${extra}`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page.locator('[data-session-bar]').first().waitFor({ state: 'visible' });
  if (state === 'card' && tab === 'tasks') await page.locator('.fy-board-card').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(200);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 0) fail(`${state} scrolls sideways by ${wide}px`);
  const cut = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.fy-board-card, .fy-board-verdict, .fy-board-done')]
      .filter(node => node.scrollWidth > node.clientWidth + 1)
      .map(node => node.textContent?.slice(0, 40) ?? ''),
  );
  if (cut.length > 0) fail(`${cut.length} card parts overflow their box: ${cut.slice(0, 3).join(' | ')}`);
  return page;
};

const shot = async (page: Page, name: string, prefix = 'board-c'): Promise<void> => {
  const path = join(shotsDir, `${prefix}-${name}.png`);
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
        for (const view of ['kanban', 'list'] as const) {
          const page = await open(context, theme, 'card', 'tasks', view);
          await shot(page, `${view}-${scheme}-${label}`);
          if (view === 'kanban') {
            const toTest = page.locator('.fy-board-lane', { hasText: 'To test' }).first();
            await toTest.scrollIntoViewIfNeeded();
            await toTest.evaluate(lane => lane.scrollIntoView({ inline: 'start', block: 'nearest' }));
            await page.waitForTimeout(250);
            if ((await page.locator('.fy-board-done').count()) === 0) fail('no Done button on a To test card');
            await shot(page, `tested-${scheme}-${label}`);
            await page.evaluate(() => document.querySelector('.fy-board-side__kanban')?.scrollTo({ left: 0 }));
            await page.locator('.fy-board-card__title').first().click();
            await page.locator('.fy-board-detail').waitFor({ state: 'visible' });
            await page.waitForTimeout(200);
            if (page.url().includes('/board/')) fail('opening a card left the chat');
            await shot(page, `drawer-${scheme}-${label}`);
          }
          await page.close();
        }
      }
      for (const [label, context] of [
        ['phone', phone],
        ['desktop', desktop],
      ] as const) {
        const panel = await open(context, theme, 'card', 'tasks', 'kanban');
        if ((await panel.locator('[data-filter="agents"]').count()) === 0) fail('no Show agent tasks toggle');
        await shot(panel, `panel-${scheme}-${label}`, 'board-v3e');
        await panel.locator('[data-board-side-expand="expand"]').click();
        await panel.locator('[data-board-full] .fy-board-card').first().waitFor({ state: 'visible' });
        await panel.waitForTimeout(200);
        await shot(panel, `expanded-${scheme}-${label}`, 'board-v3e');
        await panel.locator('[data-board-full] .fy-board-card__title').first().click();
        await panel.locator('.fy-board-detail').waitFor({ state: 'visible' });
        await panel.close();
        if (scheme === 'light' && label === 'desktop') {
          const agents = await open(context, theme, 'card', 'tasks', 'kanban', '&agents=1');
          await shot(agents, 'agents-on-desktop', 'board-v3e');
          await agents.close();
        }
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
