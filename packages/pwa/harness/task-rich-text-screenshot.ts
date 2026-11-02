/**
 * Screenshots of a task's rich text (docs/reference-standard.md § one renderer), at a 390px phone and a 1440px
 * desktop, light and dark:
 *
 *   bun harness/task-rich-text-screenshot.ts [outDir]    # default /tmp/claude-1000/shots/task-rich-text
 *
 * - `detail-*`: a card in To test with a long How to test — a sub-heading, a label straight above a list that
 *   starts at 4, `code`, **bold** and → — drawn as numbered steps under their section labels.
 * - `inbox-*`: the Inbox "Try it" card with the same sections and its tick boxes.
 * - `panel-*`: the chat's side-panel Cards view of the same card.
 *
 * It fails when a page scrolls sideways, a section label is missing, or the steps lose the number they were written
 * with (1 2 3, then 4 5 6, then 7 8).
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'task-rich-text');
const shotsDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/task-rich-text');

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
};

const run = (command: string, args: readonly string[]): void => {
  const result = spawnSync(command, args, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} exited ${result.status}`);
};

const PAGES = { detail: 'board-detail', inbox: 'inbox-page', panel: 'board-chat-page' } as const;
type PageName = keyof typeof PAGES;
const QUERY: Record<PageName, string> = {
  detail: 'view=tested&rich=1',
  inbox: 'view=quick-to-test&rich=1',
  panel: 'state=card&tab=tasks&view=cards&cards=few&agents=1&totest=1&rich=1',
};

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
      const page = (url.searchParams.get('page') ?? 'detail') as PageName;
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

const open = async (context: BrowserContext, theme: string, name: PageName): Promise<Page> => {
  const tab = await context.newPage();
  await tab.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await tab.goto(`${server.url}?theme=${theme}&page=${name}&${QUERY[name]}`);
  await tab.locator('[data-fixture]').waitFor({ state: 'visible' });
  await tab.locator('[data-section="how-to-test"], [data-to-test], [data-test-steps]').first().waitFor();
  await tab.waitForTimeout(300);
  const wide = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (wide > 0) fail(`${name} scrolls sideways by ${wide}px`);
  return tab;
};

const shot = async (page: Page, name: string, fullPage = true): Promise<void> => {
  const path = join(shotsDir, `${name}.png`);
  await page.screenshot({ path, fullPage });
  process.stdout.write(`📸 ${path}\n`);
};

const unscroll = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent =
      '.fy-board-detail, .fy-board-detail__content { position: static !important; max-height: none !important; height: auto !important; overflow: visible !important; }';
    document.head.append(style);
  });
  await page.waitForTimeout(150);
};

const checkSteps = async (page: Page, name: string): Promise<void> => {
  const numbers = (await page.locator('.fy-board-test__n').allTextContents()).slice(0, 8);
  if (numbers.join(' ') !== '1 2 3 4 5 6 7 8')
    fail(`${name}: the steps read ${numbers.join(' ')}, not 1 2 3 4 5 6 7 8`);
  const labels = (await page.locator('.fy-board-test__section').allTextContents()).map(label => label.trim());
  if (!labels.includes('2FA codes'))
    fail(`${name}: the "2FA codes" label is not its own section (${labels.join(' | ')})`);
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
        const detail = await open(context, theme, 'detail');
        await checkSteps(detail, 'detail');
        if (label === 'desktop') {
          await unscroll(detail);
          await shot(detail, `detail-${scheme}-${label}`);
        } else {
          await detail
            .locator('[data-section="how-to-test"]')
            .evaluate(node => node.scrollIntoView({ block: 'start' }));
          await detail.waitForTimeout(150);
          await shot(detail, `detail-${scheme}-${label}`, false);
        }
        await detail.close();

        const inbox = await open(context, theme, 'inbox');
        await checkSteps(inbox, 'inbox');
        await shot(inbox, `inbox-${scheme}-${label}`);
        await inbox.close();

        const panel = await open(context, theme, 'panel');
        await checkSteps(panel, 'panel');
        await shot(panel, `panel-${scheme}-${label}`);
        await panel.close();
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  await server.stop(true);
}
