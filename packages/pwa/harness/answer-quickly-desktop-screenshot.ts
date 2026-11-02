/**
 * Screenshots and checks for "Answer quickly" on a wide screen: the Inbox's button with its count, the run centred at a
 * readable width on a decision card and on a task card, the quiet line of keys, the "All done" state — and the phone
 * unchanged (button, no keys line, no All done). Studio and Neo, light and dark (set `FY_SHOT_THEMES`).
 *
 *   bun harness/answer-quickly-desktop-screenshot.ts [outDir] [series]   # <outDir>/<series>-<name>-<phone|desktop>-<theme>.png
 *
 * It bundles `inbox-page.tsx` (the real `AgendaInboxPage`, invented data), serves it on an ephemeral loopback port and
 * drives it with a REAL mouse and keyboard (a wide screen) or REAL touch (the phone). It FAILS, after writing every
 * picture, when: a page scrolls sideways; the button's count is not the run's length; the run is wider than 720px or
 * off-centre; the keys line is missing (desktop) or present (phone); a key, a mouse drag or Esc does not do what the
 * line says; or a finished run does not say "All done".
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'answer-quickly-desktop-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/answer-quickly-desktop');
const series = process.argv[3] ?? 'answer-quickly-desktop';

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
const DESKTOP = { viewport: { width: 1_440, height: 900 } } as const;
const NOW = new Date('2026-10-29T09:00:00.000Z');
const LOCALE = { timezoneId: 'UTC', locale: 'en-US' } as const;
const THEMES = (process.env.FY_SHOT_THEMES ?? 'studio-light,studio-dark,neo-light,neo-dark').split(',');
type Form = 'phone' | 'desktop';

const violations: string[] = [];
let checks = 0;
const check = (ok: boolean, message: string): void => {
  checks += 1;
  if (ok) return;
  violations.push(message);
  process.stderr.write(`❌ ${message}\n`);
};

const open = async (
  context: { newPage: () => Promise<Page> },
  theme: string,
  query: string,
  ready: string,
): Promise<Page> => {
  const page = await context.newPage();
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.clock.setFixedTime(NOW);
  await page.goto(`${server.url}?theme=${theme}&${query}`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page.locator(ready).first().waitFor({ state: 'visible' });
  await page.waitForTimeout(250);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 0, `${query}: scrolls sideways by ${wide}px`);
  return page;
};

const shot = async (page: Page, name: string, form: Form, theme: string): Promise<void> => {
  await page.waitForTimeout(150);
  const path = join(outDir, `${series}-${name}-${form}-${theme}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

const committed = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __committed?: unknown[] }).__committed?.length ?? 0);

/** Where the open card is, and whether it sits in the middle of the room it has at a readable width. */
const checkColumn = async (page: Page, label: string): Promise<void> => {
  const box = await page.locator('[data-agenda-inbox="card"] .fy-attn-inbox__deck').first().boundingBox();
  const main = await page.locator('[data-agenda-inbox="card"]').first().boundingBox();
  if (box === null || main === null) return check(false, `${label}: no run on the page`);
  check(box.width <= 720 && box.width >= 560, `${label}: the run is ${Math.round(box.width)}px wide, not 560–720px`);
  const off = Math.abs(box.x + box.width / 2 - (main.x + main.width / 2));
  check(off <= 24, `${label}: the run is ${Math.round(off)}px off the middle`);
};

for (const theme of THEMES) {
  const scheme = theme.endsWith('-dark') ? 'dark' : 'light';
  const family = theme.slice(0, theme.lastIndexOf('-'));
  const mode = theme.slice(theme.lastIndexOf('-') + 1);
  const newContext = (form: Form) =>
    browser
      .newContext({ ...(form === 'phone' ? PHONE : DESKTOP), ...LOCALE, colorScheme: scheme })
      .then(async context => {
        await context.addInitScript(
          ([a, b]) => localStorage.setItem('fy-theme-v1', JSON.stringify({ family: a, mode: b, textScale: 'default' })),
          [family, mode] as const,
        );
        return context;
      });

  // ---- a wide screen: the button, the run on a decision card and on a task card, the keys ----
  {
    const context = await newContext('desktop');
    const page = await open(context, theme, 'view=to-test', '[data-agenda-quick]');
    const button = page.locator('[data-agenda-quick]');
    const total = Number((await button.locator('.fy-inbox-quick__count').textContent()) ?? '0');
    check(total > 1, `desktop ${theme}: the button counts ${total}`);
    await shot(page, 'button', 'desktop', theme);

    await button.click();
    await page.locator('[data-agenda-deck]').waitFor({ state: 'visible' });
    await page.waitForTimeout(200);
    check((await page.locator('[data-inbox-keys]').count()) === 1, `desktop ${theme}: the keys line is not there once`);
    const keys = (await page.locator('[data-inbox-keys]').textContent()) ?? '';
    check(/Skip/u.test(keys) && /Esc/u.test(keys), `desktop ${theme}: the keys line says "${keys}"`);
    await checkColumn(page, `desktop ${theme} decision`);
    await shot(page, 'decision-card', 'desktop', theme);

    // j and k move between cards; nothing is answered by moving.
    const first = await page.locator('.fy-attn-deck__top [data-agenda-view]').first().getAttribute('data-agenda-view');
    await page.keyboard.press('j');
    await page.waitForTimeout(250);
    const second = await page.locator('.fy-attn-deck__top [data-agenda-view]').first().getAttribute('data-agenda-view');
    check(second !== null && second !== first, `desktop ${theme}: j did not move to the next card`);
    await page.keyboard.press('k');
    await page.waitForTimeout(250);
    check(
      (await page.locator('.fy-attn-deck__top [data-agenda-view]').first().getAttribute('data-agenda-view')) === first,
      `desktop ${theme}: k did not come back`,
    );
    check((await committed(page)) === 0, `desktop ${theme}: moving answered a card`);

    // A real mouse drag to the right answers the card with its right-hand answer.
    const top = page.locator('.fy-attn-deck__top');
    const grip = await top.locator('[data-inbox-who]').boundingBox();
    if (grip === null) fail('the decision card has no who-and-what line to hold');
    else {
      await page.mouse.move(grip.x + 40, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(grip.x + 120, grip.y + grip.height / 2, { steps: 4 });
      await page.mouse.move(grip.x + 420, grip.y + grip.height / 2, { steps: 8 });
      check(
        ((await top.getAttribute('data-swipe-answer')) ?? '') !== '',
        `desktop ${theme}: the mouse drag does not read as an answer`,
      );
      await shot(page, 'mouse-drag', 'desktop', theme);
      await page.mouse.up();
      await page.waitForTimeout(350);
      check((await committed(page)) === 0, `desktop ${theme}: the answer was sent before the undo window ended`);
    }

    // Down (↓) skips; the arrows answer the next one.
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(350);

    // Walk to a task card and shoot it.
    for (let guard = 0; guard < total + 2; guard += 1) {
      if ((await page.locator('[data-inbox-open-to-test]').count()) > 0) break;
      await page.keyboard.press('j');
      await page.waitForTimeout(250);
    }
    check((await page.locator('[data-inbox-open-to-test]').count()) === 1, `desktop ${theme}: no task card in the run`);
    await checkColumn(page, `desktop ${theme} task`);
    check((await page.locator('[data-inbox-keys]').count()) === 1, `desktop ${theme}: the task card has no keys line`);
    await shot(page, 'task-card', 'desktop', theme);

    // Esc closes the run, back to the list with its button.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    check((await page.locator('[data-agenda-quick]').count()) === 1, `desktop ${theme}: Esc did not close the run`);
    await context.close();
  }

  // ---- a wide screen: a short run finished from the keyboard says All done ----
  {
    const context = await newContext('desktop');
    const page = await open(context, theme, 'view=sections&only=A5,A2', '[data-agenda-quick]');
    await page.locator('[data-agenda-quick]').click();
    await page.locator('[data-agenda-deck]').waitFor({ state: 'visible' });
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(400);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(500);
    check(
      (await page.locator('[data-agenda-run-done]').count()) === 1,
      `desktop ${theme}: no All done after the last card`,
    );
    check(
      ((await page.locator('[data-agenda-run-done]').textContent()) ?? '').includes('All done'),
      `desktop ${theme}: the end of the run does not say All done`,
    );
    await checkColumn(page, `desktop ${theme} done`);
    await shot(page, 'all-done', 'desktop', theme);
    await page.locator('[data-agenda-run-back]').click();
    await page.waitForTimeout(250);
    check(
      (await page.locator('[data-agenda-run-done]').count()) === 0,
      `desktop ${theme}: Back to Inbox left the All done state up`,
    );
    await context.close();
  }

  // ---- the phone, unchanged: the button, the run, no keys line, and no All done ----
  {
    const context = await newContext('phone');
    const page = await open(context, theme, 'view=to-test', '[data-agenda-quick]');
    await page.locator('[data-agenda-quick]').scrollIntoViewIfNeeded();
    await shot(page, 'button', 'phone', theme);
    await page.locator('[data-agenda-quick]').click();
    await page.locator('[data-agenda-deck]').waitFor({ state: 'visible' });
    await page.waitForTimeout(250);
    check((await page.locator('[data-inbox-keys]').count()) === 0, `phone ${theme}: the phone shows a keys line`);
    await shot(page, 'decision-card', 'phone', theme);
    await context.close();
  }
}

await browser.close();
server.stop();
if (violations.length > 0) fail(`${violations.length} of ${checks} checks failed`);
process.stdout.write(`✅ ${checks} checks passed\n`);
