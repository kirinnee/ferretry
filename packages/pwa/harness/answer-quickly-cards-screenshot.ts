/**
 * Screenshots and checks for "Answer quickly" with the cards waiting for the owner's try in the run: the Inbox's
 * button with its count (agenda items plus those cards), the run on a card to test (title, release, How to test,
 * Done / Not good, where it is in the run), that card held mid-swipe, and the Not good reason box. Phone 390 taps the
 * real button and steps to the card; desktop 1440 (no button there) opens the run on the card. Studio light and dark.
 *
 *   bun harness/answer-quickly-cards-screenshot.ts [outDir] [series]   # writes <outDir>/<series>-<name>-<phone|desktop>-<theme>.png
 *
 * It bundles `inbox-page.tsx` (the real `AgendaInboxPage`, invented data), serves it on an ephemeral loopback port,
 * drives it with REAL touch input, and FAILS (after writing every picture) when: a page scrolls sideways; the count
 * does not match the run's length; the card lacks its title, release or How to test steps; the held drag does not read
 * as the answer it would send; a swipe past the threshold does not send Done; or the Not good reason box does not open.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type CDPSession, chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'answer-quickly-cards-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/answer-quickly-cards');
const series = process.argv[3] ?? 'answer-quickly';

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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/inbox-page.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'inbox-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
const NOW = new Date('2026-10-29T09:00:00.000Z');
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
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.clock.setFixedTime(NOW);
  await page.goto(`${server.url}?theme=${theme}&view=${view}`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page
    .locator(view === 'to-test' ? '[data-agenda-quick]' : '[data-to-test]')
    .first()
    .waitFor({ state: 'visible' });
  await page.waitForTimeout(250);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 0, `${view}: scrolls sideways by ${wide}px`);
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

const rowOf = (page: Page) => page.locator('[data-to-test]').first();

/** A finger on the row's meta line, dragged by `dx`, `dy`; the caller lets go or cancels. */
const hold = async (page: Page, client: CDPSession, dx: number, dy = 0): Promise<{ x: number; y: number }> => {
  await rowOf(page).scrollIntoViewIfNeeded();
  const grip = await rowOf(page).locator('.fy-totest__meta').boundingBox();
  if (grip === null) return fail('to-test: the row has no place to grab');
  const x = grip.x + 20;
  const y = grip.y + grip.height / 2;
  await touch(client, 'touchStart', x, y);
  await touch(client, 'touchMove', x + Math.sign(dx) * 14, y + Math.sign(dy) * 14);
  for (let step = 1; step <= 6; step += 1) await touch(client, 'touchMove', x + (dx * step) / 6, y + (dy * step) / 6);
  await page.waitForTimeout(120);
  return { x: x + dx, y: y + dy };
};

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

    const page = await open(context, theme, form === 'phone' ? 'to-test' : 'quick-to-test');
    if (form === 'phone') {
      // The Inbox with its button: the count is the agenda items and the cards to test together.
      const button = page.locator('[data-agenda-quick]');
      const total = Number((await button.locator('.fy-inbox-quick__count').textContent()) ?? '0');
      await button.scrollIntoViewIfNeeded();
      await shot(page, 'count', form, theme);
      await button.click();
      await page.locator('[data-agenda-where]').last().waitFor({ state: 'visible' });
      check(
        ((await page.locator('[data-agenda-where]').last().textContent()) ?? '').endsWith(`of ${total}`),
        `${form} ${theme}: the run is not ${total} long`,
      );
      for (let guard = 0; guard < total; guard += 1) {
        if ((await page.locator('[data-inbox-open-to-test]').count()) > 0) break;
        await page.getByRole('button', { name: /^Next/u }).last().click();
        await page.waitForTimeout(350);
      }
    }
    const step = page.locator('[data-inbox-open-to-test]');
    check((await step.count()) === 1, `${form} ${theme}: the run never reached a card to test`);
    const where = (await page.locator('[data-agenda-where]').last().textContent()) ?? '';
    check(/^\d+ of \d+$/u.test(where), `${form} ${theme}: no place in the run ("${where}")`);
    const row = rowOf(page);
    check(
      (await row.locator('[data-to-test-title]').textContent())?.includes('Pairing a second phone') === true,
      `${form} ${theme}: the card lacks its title`,
    );
    check(
      (await row.locator('[data-to-test-release]').textContent()) === 'Shipped in v5.4.0',
      `${form} ${theme}: the card does not say which release shipped it`,
    );
    check(
      ((await row.locator('[data-to-test-how]').textContent()) ?? '').includes('Scan the code'),
      `${form} ${theme}: the card lacks its How to test steps`,
    );
    await shot(page, 'run', form, theme);

    // Mid-swipe all three ways: what letting go would do is on the row as data.
    const client = await context.newCDPSession(page);
    for (const [name, dx, aim, direction] of [
      ['swipe-left', -150, 'Done', 'left'],
      ['swipe-right', 150, 'Not good', 'right'],
      ['swipe-down', 0, 'Skip', 'down'],
    ] as const) {
      await hold(page, client, dx, direction === 'down' ? 150 : 0);
      check(
        (await row.getAttribute('data-swipe-direction')) === direction &&
          (await row.getAttribute('data-swipe-answer')) === aim,
        `${form} ${theme} ${name}: the drag does not read as ${aim}`,
      );
      await shot(page, name, form, theme);
      await touch(client, 'touchCancel');
      await page.waitForTimeout(150);
    }

    // A swipe past the threshold, right: the reason box opens and nothing is sent yet.
    const away = await hold(page, client, 300);
    await touch(client, 'touchEnd', away.x, away.y);
    await page.waitForTimeout(300);
    check(
      (await page.locator('[role="dialog"]').count()) === 1,
      `${form} ${theme}: a right swipe did not open the reason box`,
    );
    check(
      (await page.evaluate(() => (window as unknown as { __moves?: unknown[] }).__moves?.length ?? 0)) === 0,
      `${form} ${theme}: a right swipe sent a move before the reason`,
    );
    await shot(page, 'reason', form, theme);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // A swipe past the threshold, left: Done is sent at once to the Done lane.
    const end = await hold(page, client, -300);
    await touch(client, 'touchEnd', end.x, end.y);
    await page.waitForTimeout(250);
    const moves = await page.evaluate(() => (window as unknown as { __moves?: { to: string }[] }).__moves ?? []);
    check(
      moves.length === 1 && moves[0]?.to === 'closed',
      `${form} ${theme}: a left swipe sent ${JSON.stringify(moves)}`,
    );
    await context.close();
  }
}

await browser.close();
server.stop();
if (violations.length > 0) fail(`${violations.length} of ${checks} checks failed`);
process.stdout.write(`✅ ${checks} checks passed\n`);
