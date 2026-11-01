/**
 * Screenshots and checks for the chat task panel's Cards view: it opens on the Cards (the card waiting for a try first),
 * that card held mid-swipe RIGHT (Done) and LEFT (Not good) with the answer named in the area it uncovers, the next card
 * (waiting on the owner), and the three tabs (Cards, Kanban, List). Phone 390 and desktop 1440, Studio light and dark.
 *
 *   bun harness/task-panel-cards-screenshot.ts [outDir] [series]   # writes <outDir>/<series>-<name>-<phone|desktop>-<theme>.png
 *
 * It bundles `board-chat-page.tsx` (the real `ChatTasks` over a fake daemon, \`?view=cards&totest=1`), serves it on an
 * ephemeral loopback port, drives it with REAL touch input (the swipe is touch only), and FAILS (after writing every
 * picture) when: a page scrolls sideways; the panel does not open on the Cards or the card to test is not first; the
 * held drag does not read as the answer it would send, or the uncovered area does not name it; a swipe past the threshold
 * does not send Done; a right swipe does not open the reason box; or a tab does not switch the view. A held drag is
 * cancelled, so nothing is sent by it.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type CDPSession, chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'task-panel-cards-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/task-panel-cards');
const series = process.argv[3] ?? 'task-panel-cards';

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
mkdirSync(outDir, { recursive: true });
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
// A touch laptop: the swipe is touch only, so the desktop picture of it needs a touch screen to be held.
const DESKTOP = { viewport: { width: 1_440, height: 900 }, hasTouch: true } as const;
const LOCALE = { timezoneId: 'UTC', locale: 'en-US' } as const;
const THEMES = (process.env.FY_SHOT_THEMES ?? 'studio-light,studio-dark').split(',');
type Form = 'phone' | 'desktop';

const violations: string[] = [];
let checks = 0;
const check = (ok: boolean, message: string): void => {
  checks += 1;
  if (ok) return;
  violations.push(message);
  process.stderr.write(`❌ ${message}\n`);
};

const open = async (context: { newPage: () => Promise<Page> }, theme: string, view: string): Promise<Page> => {
  const page = await context.newPage();
  page.on('pageerror', error => process.stderr.write(`pageerror ${error.message}\n`));
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.goto(`${server.url}?theme=${theme}&state=card&tab=tasks&view=${view}&cards=few&agents=1&totest=1`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page.locator('[data-board-side]').waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 0, `${view}: scrolls sideways by ${wide}px`);
  if (view === 'cards') {
    check(
      (await page.locator('[data-board-side] input[data-filter="agents"]').count()) === 0,
      `${view}: the Cards view has an "Agent tasks" toggle`,
    );
  }
  return page;
};

const backgroundLightness = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const paint = (element: Element): string => getComputedStyle(element).backgroundColor;
    const colour = [document.body, document.documentElement]
      .map(paint)
      .find(value => !/rgba\(0, 0, 0, 0\)|transparent/u.test(value));
    const [r = 255, g = 255, b = 255] = (colour ?? 'rgb(255,255,255)').match(/\d+(\.\d+)?/gu)?.map(Number) ?? [];
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  });

const shot = async (page: Page, name: string, form: Form, theme: string): Promise<void> => {
  await page.waitForTimeout(120);
  const light = await backgroundLightness(page);
  check(
    theme.endsWith('-dark') ? light < 0.35 : light > 0.65,
    `${name} ${form} ${theme}: the page is not ${theme.endsWith('-dark') ? 'dark' : 'light'} (lightness ${light.toFixed(2)})`,
  );
  const path = join(outDir, `${series}-${name}-${form}-${theme}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

const touch = (
  client: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel',
  x?: number,
  y?: number,
) =>
  client.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: x === undefined || y === undefined ? [] : [{ x, y }],
  });

const rowOf = (page: Page) => page.locator('[data-board-cards] [data-to-test]').first();

/** A finger on the row's meta line, dragged by `dx`, `dy`; the caller lets go or cancels. */
const hold = async (page: Page, client: CDPSession, dx: number, dy = 0): Promise<{ x: number; y: number }> => {
  await rowOf(page).scrollIntoViewIfNeeded();
  const grip = await rowOf(page).locator('.fy-totest__meta').boundingBox();
  if (grip === null) return fail('the card to test has no place to grab');
  const x = grip.x + 20;
  const y = grip.y + grip.height / 2;
  await touch(client, 'touchStart', x, y);
  await touch(client, 'touchMove', x + Math.sign(dx) * 14, y + Math.sign(dy) * 14);
  for (let step = 1; step <= 6; step += 1) await touch(client, 'touchMove', x + (dx * step) / 6, y + (dy * step) / 6);
  await page.waitForTimeout(120);
  return { x: x + dx, y: y + dy };
};

const pressed = (page: Page): Promise<string | null> =>
  page.locator('.fy-board-side__view[aria-pressed="true"]').first().getAttribute('data-view');

for (const form of ['phone', 'desktop'] as const) {
  for (const theme of THEMES) {
    const context = await browser.newContext({
      ...(form === 'phone' ? PHONE : DESKTOP),
      ...LOCALE,
      colorScheme: theme.endsWith('-dark') ? 'dark' : 'light',
    });
    // The desktop shell publishes the stored theme, so the pack under test is stored too.
    await context.addInitScript(
      ([family, mode]) => localStorage.setItem('fy-theme-v1', JSON.stringify({ family, mode, textScale: 'default' })),
      [theme.slice(0, theme.lastIndexOf('-')), theme.slice(theme.lastIndexOf('-') + 1)] as const,
    );

    // The default: the panel opens on the Cards, the card waiting for a try first.
    const page = await open(context, theme, 'cards');
    const row = rowOf(page);
    check((await pressed(page)) === 'cards', `${form} ${theme}: the panel did not open on the Cards`);
    check(
      ((await page.locator('[data-board-cards-rank]').textContent()) ?? '') === 'To test',
      `${form} ${theme}: the card to test is not first`,
    );
    check(
      (await page.locator('.fy-item-view__where').textContent())?.includes(' of ') === true,
      `${form} ${theme}: no "n of N" in the pager`,
    );
    check(
      ((await row.locator('[data-to-test-how]').textContent()) ?? '').includes('Scan the code'),
      `${form} ${theme}: the card lacks its How to test steps`,
    );
    check(
      (await page.locator('[data-board-cards] .fy-board-card, [data-board-cards] [data-to-test]').count()) === 1,
      `${form} ${theme}: more than one card is on show`,
    );
    await shot(page, 'cards', form, theme);

    // Mid-swipe all three ways.
    const client = await context.newCDPSession(page);
    for (const [name, dx, aim, direction] of [
      ['swipe-left', -150, 'Not good', 'left'],
      ['swipe-right', 150, 'Done', 'right'],
      ['swipe-down', 0, 'Skip', 'down'],
    ] as const) {
      await hold(page, client, dx, direction === 'down' ? 150 : 0);
      check(
        (await row.getAttribute('data-swipe-direction')) === direction &&
          (await row.getAttribute('data-swipe-answer')) === aim,
        `${form} ${theme} ${name}: the drag does not read as ${aim}`,
      );
      const reveal = row.locator(`[data-to-test-reveal="${direction}"]`);
      check(
        (await reveal.isVisible()) && (await reveal.textContent())?.trim() === aim,
        `${form} ${theme} ${name}: the uncovered area does not name ${aim}`,
      );
      await shot(page, name, form, theme);
      await touch(client, 'touchCancel');
      await page.waitForTimeout(150);
      check(
        (await row.getAttribute('data-swipe-direction')) === null,
        `${form} ${theme} ${name}: the row did not settle`,
      );
    }

    // Past the threshold: right is Done at once, left opens the reason box.
    const end = await hold(page, client, 300);
    await touch(client, 'touchEnd', end.x, end.y);
    await page.waitForTimeout(300);
    const moves = await page.evaluate(() => (window as unknown as { __moves: { to: string }[] }).__moves);
    check(
      moves.length === 1 && moves[0]?.to === 'closed',
      `${form} ${theme}: a right swipe sent ${JSON.stringify(moves)}`,
    );
    const away = await hold(page, client, -300);
    await touch(client, 'touchEnd', away.x, away.y);
    await page.waitForTimeout(300);
    check(
      (await page.locator('[role="dialog"]').count()) === 1,
      `${form} ${theme}: a left swipe did not open the reason box`,
    );
    await shot(page, 'reason', form, theme);
    await page.keyboard.press('Escape');

    // Step on to the next card: the ordinary card, no swipe row.
    await page.locator('[data-board-cards] button[aria-label="Next card"]').click();
    await page.locator('[data-board-cards] button[aria-label="Next card"]').click();
    await page.waitForTimeout(150);
    check(
      (await page.locator('[data-board-cards-rank]').textContent()) === 'To approve',
      `${form} ${theme}: the third card is not the one to approve`,
    );
    // Only cards waiting on the owner are in the stack: the 2 to test and the 2 to approve, never the 60+ other cards.
    check(
      ((await page.locator('[data-board-cards]').textContent()) ?? '').includes('3 of 4'),
      `${form} ${theme}: the stack holds other than the 4 cards waiting on the owner`,
    );
    await shot(page, 'cards-waiting', form, theme);

    // The tabs: Kanban and List are still there and switch the view.
    await page.locator('button[data-view="kanban"]').click();
    await page.waitForTimeout(200);
    check(
      (await pressed(page)) === 'kanban' && (await page.locator('[data-board-side-kanban]').count()) === 1,
      `${form} ${theme}: the Kanban tab did not switch the view`,
    );
    await shot(page, 'tabs-kanban', form, theme);
    await page.locator('button[data-view="list"]').click();
    await page.waitForTimeout(200);
    check((await pressed(page)) === 'list', `${form} ${theme}: the List tab did not switch the view`);
    await shot(page, 'tabs-list', form, theme);
    await context.close();
  }
}

await browser.close();
server.stop();
if (violations.length > 0) fail(`${violations.length} of ${checks} checks failed`);
process.stdout.write(`✅ ${checks} checks passed\n`);
