/**
 * Screenshots and layout checks for the agenda in a ferret's chat: the drawer, an agenda item in FULL-HEIGHT FOCUS
 * (the overlay), the action bar with text typed, a long item scrolled mid-way, the thinking line beside the
 * pill, the pill alone and, on a phone, the bar above a faked keyboard. Desktop 1440 and phone 390, in the
 * Studio and Neo-Brutalism themes, light and dark.
 *
 *   bun harness/agenda-v2-screenshot.ts [outDir]   # writes <outDir>/agenda-v2-<name>-<phone|desktop>-<theme>.png
 *
 * It bundles `agenda-page.tsx` (the real `useAttentionAgenda`, invented data), serves it on an ephemeral loopback
 * port, drives it with real clicks, and FAILS (after writing every picture) when: a page scrolls sideways; the
 * overlay's box is not the chat column's box or the composer shows through it; the top or the bar moves when the
 * body scrolls; the chat underneath loses its scroll position; anything but the one body scrolls; a drawer row
 * holds more than the row button; the composer moves with the pill, the drawer or the thinking line; the thinking
 * line and the pill are not on one row; or a phone touch target is under 44px.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Locator, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'agenda-v2-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000');

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
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/agenda-page.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'agenda-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
const THEMES = ['studio-light', 'studio-dark', 'neo-light', 'neo-dark'] as const;
type Form = 'phone' | 'desktop';

const violations: string[] = [];
let checks = 0;
const check = (ok: boolean, message: string): void => {
  checks += 1;
  if (ok) return;
  violations.push(message);
  process.stderr.write(`❌ ${message}\n`);
};

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const boxOf = async (locator: Locator, label: string): Promise<Box> => {
  const found = await locator.first().boundingBox();
  if (found === null) return fail(`${label}: not on screen`);
  return found;
};

const sameBox = (a: Box, b: Box, label: string): void =>
  check(
    (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(a[key] - b[key]) < 1),
    `${label}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`,
  );

const open = async (browserContext: { newPage: () => Promise<Page> }, theme: string, query: string): Promise<Page> => {
  const page = await browserContext.newPage();
  await page.route('**/*', route =>
    route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
  );
  await page.clock.setFixedTime(NOW);
  await page.goto(`${server.url}?theme=${theme}&${query}`);
  await page.locator('[data-fixture]').waitFor({ state: 'visible' });
  await page.waitForTimeout(200);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 0, `${query}: scrolls sideways by ${wide}px`);
  return page;
};

const shot = async (page: Page, name: string, form: Form, theme: string): Promise<void> => {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(120);
  const path = join(outDir, `agenda-v2-${name}-${form}-${theme}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

const composerBox = (page: Page): Promise<Box> => boxOf(page.locator('[data-agenda-harness-composer]'), 'composer');

const openDrawer = async (page: Page): Promise<void> => {
  await page.locator('[data-agenda-line-toggle]').click();
  await page.locator('[data-agenda-drawer]').waitFor({ state: 'visible' });
  await page.waitForTimeout(150);
};

/** The sizes the overlay's own checks read. */
const overlay = (page: Page) => page.locator('[data-agenda-view]');

const checkOverlay = async (page: Page, form: Form, label: string): Promise<void> => {
  await overlay(page).waitFor({ state: 'visible' });
  const surface = await boxOf(page.locator('.kt-chat-surface'), 'chat column');
  sameBox(await boxOf(overlay(page), 'overlay'), surface, `${label}: the overlay is not the chat column`);
  const covered = await page.evaluate(() => {
    const composer = document.querySelector('[data-agenda-harness-composer]');
    const view = document.querySelector('[data-agenda-view]');
    if (composer === null || view === null) return false;
    const at = composer.getBoundingClientRect();
    const hit = document.elementFromPoint(at.x + at.width / 2, at.y + at.height / 2);
    return hit !== null && view.contains(hit);
  });
  check(covered, `${label}: the composer shows through the overlay`);
  const only = await page.evaluate(() => {
    const view = document.querySelector('[data-agenda-view]');
    if (view === null) return [];
    return [view, ...view.querySelectorAll('*')]
      .filter(node => {
        const style = getComputedStyle(node);
        const scrolls = ['auto', 'scroll'].includes(style.overflowY) || ['auto', 'scroll'].includes(style.overflowX);
        return scrolls && node.scrollHeight > node.clientHeight + 1;
      })
      .filter(node => !node.closest('[data-fy-render], .fy-render'))
      .map(node => (node.getAttribute('data-agenda-body') !== null ? 'body' : node.className.toString()));
  });
  check(
    only.every(name => name === 'body'),
    `${label}: scrolls somewhere other than the body: ${only.join(', ')}`,
  );
  const body = page.locator('[data-agenda-body]');
  const sideways = await body.evaluate(node => node.scrollWidth - node.clientWidth);
  check(sideways <= 1, `${label}: the body scrolls sideways by ${sideways}px`);
  const topBox = await boxOf(page.locator('[data-agenda-top]'), 'top');
  check(topBox.y >= surface.y - 1, `${label}: the top starts above the chat column`);
  if (form === 'phone') {
    for (const button of await page.locator('[data-agenda-bar] button, [data-agenda-top] button').all()) {
      if (!(await button.isVisible())) continue;
      const rect = await button.boundingBox();
      if (rect !== null)
        check(
          rect.height >= 43.5 || rect.width >= 43.5,
          `${label}: a touch target is ${Math.round(rect.width)}x${Math.round(rect.height)}`,
        );
    }
  }
};

const openItem = async (page: Page, id: string): Promise<void> => {
  await openDrawer(page);
  await page.locator(`[data-attention-agenda-row="${id}"]`).click();
  await overlay(page).waitFor({ state: 'visible' });
  await page.waitForTimeout(200);
};

const scenes = async (form: Form, theme: string): Promise<void> => {
  const browserContext = await browser.newContext({ ...(form === 'phone' ? PHONE : DESKTOP), ...LOCALE });
  const phone = form === 'phone';

  // the pill alone, the drawer, and the composer not moving for either
  const plain = await open(browserContext, theme, 'view=board');
  const composerRest = await composerBox(plain);
  await shot(plain, 'pill-alone', form, theme);
  const line = await boxOf(plain.locator('[data-agenda-line-toggle]'), 'the pill');
  await openDrawer(plain);
  sameBox(await composerBox(plain), composerRest, 'the drawer moved the composer');
  const rows = await plain.locator('[data-attention-agenda-row]').all();
  check(rows.length >= 3, `the drawer has ${rows.length} rows`);
  for (const row of rows) {
    const extra = await row.evaluate(node => node.querySelectorAll('button, a, input, [role=button]').length);
    check(extra === 0, 'a drawer row holds more than the row button');
    if (phone) check(((await row.boundingBox())?.height ?? 0) >= 44, 'a drawer row is under 44px');
  }
  // no coloured rail or stripe on the left of anything in the drawer: a left border wider than 1px that the right one does not share
  const rails = await plain.locator('[data-agenda-drawer], [data-agenda-drawer] *').evaluateAll(nodes =>
    nodes
      .map(node => getComputedStyle(node))
      .filter(
        style =>
          Number.parseFloat(style.borderLeftWidth) > 1 &&
          style.borderLeftStyle !== 'none' &&
          style.borderLeftColor !== 'rgba(0, 0, 0, 0)' &&
          (style.borderLeftWidth !== style.borderRightWidth || style.borderLeftColor !== style.borderRightColor),
      )
      .map(style => `${style.borderLeftWidth} ${style.borderLeftColor}`),
  );
  check(rails.length === 0, `the drawer has a left rail: ${rails.join(', ')}`);
  await shot(plain, 'drawer', form, theme);
  await plain.close();

  // the thinking line and the pill: ONE row, thinking left, pill right, the composer where it was
  const thinking = await open(browserContext, theme, 'view=board&live=1');
  sameBox(await composerBox(thinking), composerRest, 'the thinking line moved the composer');
  const live = await boxOf(thinking.locator('[data-agenda-live]'), 'the thinking line');
  const pill = await boxOf(thinking.locator('[data-agenda-line-toggle]'), 'the pill');
  check(
    Math.abs(live.y + live.height / 2 - (pill.y + pill.height / 2)) < 4,
    'the thinking line and the pill are not on one row',
  );
  check(live.x < pill.x, 'the thinking line is not left of the pill');
  check(Math.abs(pill.height - line.height) < 2, 'the row wrapped when the thinking line joined the pill');
  await shot(thinking, 'row-thinking-and-pill', form, theme);
  await thinking.close();

  // a choice item, with history and the terms table
  const choice = await open(browserContext, theme, 'view=board&history=1');
  await openItem(choice, 'A5');
  await checkOverlay(choice, form, 'choice item');
  check((await choice.locator('table[data-attention-terms]').count()) === 1, 'the terms are not a table');
  check((await choice.locator('[data-agenda-history] li').count()) >= 3, 'the history has fewer than 3 rows');
  await shot(choice, 'item-choice', form, theme);
  // the bar with text typed
  await choice.locator('[data-agenda-field]').fill('Leaning SQLite — but keep the nightly export.');
  await shot(choice, 'item-bar-typed', form, theme);
  await choice.close();

  // a permission item
  const permission = await open(browserContext, theme, 'view=board&history=1');
  await openItem(permission, 'A2');
  await checkOverlay(permission, form, 'permission item');
  await shot(permission, 'item-permission', form, theme);
  await permission.close();

  // a permission item that confirms a config change: the change block, no premise
  const change = await open(browserContext, theme, 'view=board&history=1&config=1');
  await openItem(change, 'A2');
  await checkOverlay(change, form, 'config-change item');
  check(
    (await change.locator('[data-attention-confirms="warden.yaml"]').count()) === 1,
    'the config change is not drawn',
  );
  check(
    !((await overlay(change).textContent()) ?? '').includes("What's going on"),
    'the premise is drawn beside the change',
  );
  await shot(change, 'item-config-change', form, theme);
  await change.close();

  // a LONG item scrolled mid-way: top and bar stay put, the chat keeps its scroll, only the body scrolls
  const longPage = await open(browserContext, theme, 'view=board&long=1');
  await longPage.evaluate(() => {
    const log = document.querySelector('.fy-chat-log > div');
    if (log !== null) log.scrollTop = 40;
  });
  const chatBefore = await longPage.evaluate(() => document.querySelector('.fy-chat-log > div')?.scrollTop ?? -1);
  await openItem(longPage, 'A5');
  await checkOverlay(longPage, form, 'long item');
  const topBefore = await boxOf(longPage.locator('[data-agenda-top]'), 'top');
  const barBefore = await boxOf(longPage.locator('[data-agenda-bar]'), 'bar');
  const body = longPage.locator('[data-agenda-body]');
  const room = await body.evaluate(node => node.scrollHeight - node.clientHeight);
  check(room > 200, `the long item barely scrolls (${room}px)`);
  await body.evaluate(node => {
    node.scrollTop = (node.scrollHeight - node.clientHeight) / 2;
  });
  await longPage.waitForTimeout(150);
  check((await body.evaluate(node => node.scrollTop)) > 100, 'the body did not scroll');
  sameBox(await boxOf(longPage.locator('[data-agenda-top]'), 'top'), topBefore, 'the top moved when the body scrolled');
  sameBox(await boxOf(longPage.locator('[data-agenda-bar]'), 'bar'), barBefore, 'the bar moved when the body scrolled');
  const chatAfter = await longPage.evaluate(() => document.querySelector('.fy-chat-log > div')?.scrollTop ?? -1);
  check(chatAfter === chatBefore, `the chat lost its scroll position: ${chatBefore} -> ${chatAfter}`);
  await shot(longPage, 'item-long-scrolled', form, theme);
  await longPage.close();

  // a phone with a keyboard: the bar rides above it
  if (phone) {
    const keyboard = await open(browserContext, theme, 'view=board&attention=A5&history=1&kb=1');
    await overlay(keyboard).waitFor({ state: 'visible' });
    const bar = await boxOf(keyboard.locator('[data-agenda-bar]'), 'bar');
    const fixture = await boxOf(keyboard.locator('[data-fixture]'), 'fixture');
    check(bar.y + bar.height <= fixture.y + fixture.height + 1, 'the bar sits below the keyboard line');
    await shot(keyboard, 'item-keyboard', form, theme);
    await keyboard.close();
  }

  // a deep link opens the item with no drawer
  const deep = await open(browserContext, theme, 'view=board&agenda=A3');
  await overlay(deep).waitFor({ state: 'visible' });
  check((await overlay(deep).getAttribute('data-agenda-view')) === 'A3', '?agenda=A3 did not open A3');
  await deep.close();
  const old = await open(browserContext, theme, 'view=board&attention=A3');
  await overlay(old).waitFor({ state: 'visible' });
  check((await overlay(old).getAttribute('data-agenda-view')) === 'A3', '?attention=A3 did not open A3');
  await old.close();
  await browserContext.close();
};

for (const theme of THEMES) for (const form of ['desktop', 'phone'] as const) await scenes(form, theme);

await browser.close();
server.stop(true);
process.stdout.write(`${checks} checks, ${violations.length} violations\n`);
if (violations.length > 0) process.exit(1);
