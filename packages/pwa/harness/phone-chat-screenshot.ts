/**
 * THE OWNER'S BROKEN PHONE (2026-10-30), measured in a real browser at 390×844 on the REAL chat page
 * (`phone-chat-page.tsx`): a long conversation, the ferret's card chip in the header and an agenda item.
 *
 *   bun harness/phone-chat-screenshot.ts [outDir] [--tag before|after]
 *       # writes <outDir>/pwa-broken-<tag>-<name>-<light|dark>.png
 *
 * It FAILS (after writing every picture) when:
 *   - the conversation cannot be scrolled by a wheel/finger over it, with no item open or after one is closed;
 *   - an open item's view is not the message list's own box (the bug: squeezed to 0px while the inert
 *     conversation took the whole cell and swallowed every touch);
 *   - Jump to latest cannot be tapped, or does not land on the newest line;
 *   - the "N need you" pill does not open the agenda drawer where a finger can reach it, or a drawer row does not
 *     open its item;
 *   - at 360, 390 and 430 px the header draws anything but ☰, the name, one status dot, the theme icon, ⓘ and ▾,
 *     any two of those overlap or leave the row, or ▾ does not hold what moved out of the bar (Interrupt, and
 *     Restart CLI marked Outdated);
 *   - the theme picker (the bar's icon, on a phone and on a desktop) does not show a visible ✕ on screen, or does
 *     not close from the ✕, Done, Escape, a tap outside it, or the platform Back (owner, 2026-10-30: "make sure
 *     i can close it!").
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'phone-chat-build');
const args = process.argv.slice(2);
const tagAt = args.indexOf('--tag');
const tag = tagAt >= 0 ? (args[tagAt + 1] ?? 'after') : 'after';
const outDir = resolve(args.find((arg, index) => !arg.startsWith('--') && index !== tagAt + 1) ?? '/tmp/claude-1000');

const failures: string[] = [];
const check = (ok: boolean, message: string): void => {
  if (ok) process.stdout.write(`✅ ${message}\n`);
  else {
    failures.push(message);
    process.stderr.write(`❌ ${message}\n`);
  }
};

const run = (command: string, commandArgs: readonly string[]): void => {
  const result = spawnSync(command, commandArgs, { cwd: packageDir, stdio: 'inherit' });
  if (result.status !== 0) {
    process.stderr.write(`❌ ${command} exited ${result.status}\n`);
    process.exit(1);
  }
};

const html = (theme: string) => `<!doctype html>
<html lang="en" data-theme="${theme}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/phone-chat-page.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'phone-chat-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
      return new Response(html(url.searchParams.get('theme') ?? 'studio-light'), {
        headers: { 'content-type': 'text/html' },
      });
    const built = Bun.file(join(buildDir, url.pathname));
    if (await built.exists()) return new Response(built);
    const shipped = Bun.file(join(packageDir, 'public', url.pathname));
    return (await shipped.exists()) ? new Response(shipped) : new Response(null, { status: 404 });
  },
});

const executablePath = Bun.which('google-chrome') ?? Bun.which('chromium') ?? Bun.which('chromium-browser');
if (executablePath === null) {
  process.stderr.write('❌ no Chrome or Chromium\n');
  process.exit(1);
}
const browser = await chromium.launch({ executablePath, headless: true });

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
const box = async (page: Page, selector: string): Promise<Box | null> =>
  await page.locator(selector).first().boundingBox();
const centre = (b: Box): { x: number; y: number } => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** What a finger at the centre of `selector` would land on, as the closest matching ancestor. */
const hitInside = async (page: Page, selector: string, within: string): Promise<boolean> => {
  const target = await box(page, selector);
  if (target === null) return false;
  const point = centre(target);
  return await page.evaluate(({ x, y, within: scope }) => document.elementFromPoint(x, y)?.closest(scope) !== null, {
    ...point,
    within,
  });
};

const scrollTop = async (page: Page): Promise<number> =>
  await page.locator('.fy-transcript').evaluate(element => element.scrollTop);

/** Scrolls the way a wheel or a finger would: at a point, so a covered or inert scroller is not reached. */
const wheelOver = async (page: Page, deltaY: number): Promise<void> => {
  const scroller = await box(page, '.fy-transcript');
  if (scroller === null) return;
  const point = centre(scroller);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, deltaY);
  await page.waitForTimeout(250);
};

const open = async (theme: string, width: number, query = ''): Promise<Page> => {
  const context = await browser.newContext({
    viewport: { width, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    colorScheme: theme.endsWith('dark') ? 'dark' : 'light',
  });
  const page = await context.newPage();
  page.on('pageerror', error => process.stderr.write(`⚠️ page error: ${error.message}\n`));
  await page.goto(`${server.url}?theme=${theme}${query}`);
  await page.locator('.fy-transcript').waitFor();
  await page.waitForTimeout(600);
  return page;
};

const shot = async (page: Page, name: string, scheme: string): Promise<void> => {
  const path = join(outDir, `pwa-broken-${tag}-${name}-${scheme}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

/** Every visible box drawn directly in the header's row, named; a phone's must be exactly the five it allows. */
const headerParts = async (page: Page): Promise<{ name: string; box: Box }[]> =>
  await page.evaluate(() => {
    const header = document.querySelector('[data-session-bar]');
    if (header === null) return [];
    const named: [string, string][] = [
      ['sessions', '[data-session-bar-sessions]'],
      ['name', '.fy-session-bar__name'],
      ['agenda badge', '.fy-session-bar__agenda'],
      ['outdated', '[data-outdated-mark]'],
      ['status dot', '.fy-session-bar__status'],
      ['actions', '[data-session-actions]'],
      ['theme', '[data-theme-trigger]'],
      ['info', '[data-session-info-toggle]'],
      ['menu', '[data-session-actions-trigger]'],
    ];
    return named.flatMap(([name, selector]) => {
      const element = header.querySelector(selector);
      const rect = element?.getBoundingClientRect();
      return rect === undefined || rect.width === 0 || rect.height === 0
        ? []
        : [{ name, box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }];
    });
  });

/** Info › Overview › About this ferret: sub-ferrets, the card and Open board, capabilities, restart, the agenda. */
const expectAbout = async (page: Page, label: string): Promise<void> => {
  const about = page.locator('[data-info-about]');
  check((await about.count()) === 1, `${label}: Info shows "About this ferret"`);
  check((await about.locator('[data-sub-ferret-pack] li').count()) >= 6, `${label}: it lists the sub-ferrets`);
  check((await about.locator('[data-info-card="F11"]').count()) === 1, `${label}: it holds the card, &F11`);
  check((await about.locator('[data-info-open-board]').count()) === 1, `${label}: it has Open board`);
  check((await about.locator('[data-info-restart]').count()) === 1, `${label}: it has Restart`);
  check((await about.locator('[data-info-agenda] [data-agenda-row]').count()) >= 1, `${label}: it lists the agenda`);
  const sheet = page.locator('[data-info-about]').first();
  const inView = await sheet.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.right <= window.innerWidth + 1 && rect.left >= -1;
  });
  check(inView, `${label}: the block sits inside the screen`);
};

const PHONE_BAR = ['sessions', 'name', 'status dot', 'theme', 'info', 'menu'];

const THEME_PANEL = '[role="dialog"][aria-label="Theme"]';

/** A point beside the open theme picker (on whichever side has room) at height `y`, i.e. outside it. */
const freeSide = async (page: Page, y: number): Promise<{ x: number; y: number }> => {
  const width = page.viewportSize()?.width ?? 0;
  const panel = await page.locator('[role="dialog"][aria-label="Theme"]').boundingBox();
  const left = panel === null ? 0 : panel.x;
  const right = panel === null ? 0 : width - (panel.x + panel.width);
  return { x: left >= right ? Math.max(1, left / 2) : width - Math.max(1, right / 2), y };
};

/** Opens the theme picker from the bar and proves every way out of it, each from a freshly opened picker. */
const themePickerPaths = async (page: Page, label: string, touch: boolean, scheme: string, name: string) => {
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  const trigger = page.locator('[data-theme-trigger]');
  const press = async (selector: string): Promise<void> => {
    const target = page.locator(selector).first();
    if (touch) await target.tap();
    else await target.click();
  };
  const openPicker = async (): Promise<void> => {
    await press('[data-theme-trigger]');
    await page.locator(THEME_PANEL).waitFor({ state: 'visible', timeout: 3_000 });
    await page.waitForTimeout(150);
  };
  const gone = async (): Promise<boolean> =>
    await page
      .locator(THEME_PANEL)
      .waitFor({ state: 'hidden', timeout: 3_000 })
      .then(
        () => true,
        () => false,
      );
  check((await trigger.count()) === 1, `${label}: the bar carries the theme button`);

  await openPicker();
  await shot(page, name, scheme);
  const panel = await box(page, THEME_PANEL);
  const closeBox = await box(page, '[data-theme-close]');
  check(
    panel !== null && panel.x >= 0 && panel.x + panel.width <= viewport.width,
    `${label}: the picker sits inside the screen sideways (${JSON.stringify(panel)})`,
  );
  check(
    closeBox !== null &&
      closeBox.x >= 0 &&
      closeBox.y >= 0 &&
      closeBox.x + closeBox.width <= viewport.width &&
      closeBox.y + closeBox.height <= viewport.height,
    `${label}: the ✕ is on screen (${JSON.stringify(closeBox)})`,
  );
  check(await hitInside(page, '[data-theme-close]', '[data-theme-close]'), `${label}: nothing covers the ✕`);
  check((await page.locator('[data-theme-done]').count()) === 1, `${label}: the picker has Done`);

  // Choosing a theme is not a way out: it stays open (Done ends the choice).
  await page.locator('input[data-mode="dark"]').first().check({ force: true });
  check((await page.locator(THEME_PANEL).count()) === 1, `${label}: choosing a mode leaves it open for Done`);
  await page.locator('input[data-mode="system"]').first().check({ force: true });
  await page.locator('[data-theme-close]').first().click();
  check(await gone(), `${label}: the ✕ closes it`);

  const outside = { x: 0, y: Math.min(viewport.height - 8, 600) };
  const paths: readonly [string, () => Promise<void>][] = [
    ['Done', () => press('[data-theme-done]')],
    ['Escape', () => page.keyboard.press('Escape')],
    [
      'a tap outside it',
      async () => {
        const at = await freeSide(page, outside.y);
        if (touch) await page.touchscreen.tap(at.x, at.y);
        else await page.mouse.click(at.x, at.y);
      },
    ],
    ['the platform Back', () => page.evaluate(() => history.back())],
  ];
  for (const [path, act] of paths) {
    await openPicker();
    await act();
    const closed = await gone();
    check(closed, `${label}: ${path} closes it`);
    check(
      new URL(page.url()).pathname === '/',
      `${label}: ${path} leaves the page it was opened over (${new URL(page.url()).pathname})`,
    );
  }
};
const GONE_FROM_BAR = [
  '[data-card-chip]',
  '[data-outdated-mark]',
  '[data-sub-ferret-indicator]',
  '.fy-session-bar__agenda',
  '[data-agenda-dock]',
  '[data-switch-marks]',
];

try {
  for (const theme of ['studio-light', 'studio-dark']) {
    const scheme = theme.endsWith('dark') ? 'dark' : 'light';

    // 1. A long conversation, nothing open: a finger over it scrolls it.
    {
      const page = await open(theme, 390);
      await shot(page, 'chat', scheme);
      const before = await scrollTop(page);
      await wheelOver(page, -900);
      const after = await scrollTop(page);
      check(after < before - 100, `${scheme}: the conversation scrolls under a finger (${before} → ${after})`);

      // Jump to latest: appears once the reader is away from the bottom, and lands on the newest line.
      const jump = page.locator('.fy-jump-latest, [data-jump-latest], button:has-text("Jump to latest")').first();
      const shown = await jump.isVisible().catch(() => false);
      check(shown, `${scheme}: Jump to latest appears after scrolling up`);
      if (shown) {
        await shot(page, 'jump-shown', scheme);
        await jump.tap({ timeout: 3_000 }).catch(() => undefined);
        await page.waitForTimeout(700);
        const gap = await page
          .locator('.fy-transcript')
          .evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
        check(gap < 4, `${scheme}: Jump to latest lands at the bottom (${Math.round(gap)}px left)`);
      }

      // The "1 need you" pill opens the drawer, where a finger can reach it, and a row opens the item.
      const pill = page.locator('[data-agenda-line-toggle]').first();
      await pill.tap({ timeout: 3_000 }).catch(() => undefined);
      await page.waitForTimeout(400);
      const drawer = await box(page, '[data-agenda-drawer]');
      check(
        drawer !== null && drawer.height > 60 && drawer.y >= 0,
        `${scheme}: the "need you" pill opens the agenda drawer (${JSON.stringify(drawer)})`,
      );
      if (drawer !== null) {
        check(await hitInside(page, '[data-agenda-drawer]', '[data-agenda-drawer]'), `${scheme}: the drawer is on top`);
        await shot(page, 'drawer', scheme);
        await page.locator('[data-agenda-drawer] [data-agenda-row]').first().tap();
        await page.waitForTimeout(400);
        const view = await box(page, '.fy-item-view');
        check(view !== null && view.height > 300, `${scheme}: a drawer row opens its item (${JSON.stringify(view)})`);
      }
      await page.context().close();
    }

    // 2. An item opened from a link: its view IS the message list's box, and the conversation is back after ✕.
    {
      const page = await open(theme, 390, '&agenda=A55');
      await shot(page, 'item-open', scheme);
      const log = await box(page, '.fy-chat-log');
      const view = await box(page, '.fy-item-view');
      check(
        log !== null &&
          view !== null &&
          Math.abs(log.y - view.y) < 1 &&
          Math.abs(log.height - view.height) < 1 &&
          view.height > 300,
        `${scheme}: the open item covers the message list exactly (log ${JSON.stringify(log)}, view ${JSON.stringify(view)})`,
      );
      check(
        await hitInside(page, '.fy-chat-log', '.fy-item-view'),
        `${scheme}: a finger on the list lands on the item`,
      );
      const close = page.locator('.fy-item-view [aria-label="Back to the chat"]').first();
      await close.tap({ timeout: 3_000 }).catch(() => undefined);
      await page.waitForTimeout(400);
      check((await page.locator('.fy-item-view').count()) === 0, `${scheme}: ✕ closes the item`);
      const before = await scrollTop(page);
      await wheelOver(page, -900);
      check((await scrollTop(page)) < before - 100, `${scheme}: the conversation scrolls again after the item closes`);
      await page.context().close();
    }

    // 3. The header at a phone's widths: ☰ · name · card reference · one status dot · ▾, apart and on the row.
    for (const width of [360, 390, 430]) {
      const page = await open(theme, width);
      const header = await box(page, '[data-session-bar]');
      const parts = await headerParts(page);
      if (width === 390 && header !== null)
        await page.screenshot({ path: join(outDir, `pwa-broken-${tag}-header-${scheme}.png`), clip: header });
      const names = parts.map(part => part.name);
      check(
        JSON.stringify(names) === JSON.stringify(PHONE_BAR),
        `${scheme} ${width}px: the bar is ☰ · name · card · dot · ▾ (${names.join(' · ')})`,
      );
      const clashes = parts.flatMap((a, index) =>
        parts.slice(index + 1).flatMap(b => (overlaps(a.box, b.box) ? [`${a.name} × ${b.name}`] : [])),
      );
      check(clashes.length === 0, `${scheme} ${width}px: nothing in the bar overlaps (${clashes.join(', ')})`);
      const outside = parts.filter(
        part =>
          header === null ||
          part.box.x < header.x - 0.5 ||
          part.box.x + part.box.width > header.x + header.width + 0.5 ||
          part.box.y < header.y - 0.5 ||
          part.box.y + part.box.height > header.y + header.height + 0.5,
      );
      check(
        outside.length === 0,
        `${scheme} ${width}px: all of it sits on the row (${outside.map(part => part.name).join(', ')})`,
      );
      const stillThere = await page.evaluate(
        gone => gone.filter(selector => document.querySelector(`[data-session-bar] ${selector}`) !== null),
        GONE_FROM_BAR,
      );
      check(
        stillThere.length === 0,
        `${scheme} ${width}px: the bar carries none of the moved-out info (${stillThere.join(', ')})`,
      );

      if (width === 390) {
        await page.locator('[data-session-actions-trigger]').tap();
        await page.waitForTimeout(400);
        const items = await page
          .locator('[data-session-action-item]')
          .evaluateAll(rows =>
            rows.map(row => `${row.getAttribute('data-session-action-item')}:${row.textContent ?? ''}`),
          );
        await shot(page, 'menu', scheme);
        // Info is offered only by a host with Info (`context`), which this page leaves out; the unit tests cover it.
        check(
          items.some(item => item.startsWith('interrupt:')),
          `${scheme}: ▾ holds interrupt`,
        );
        check(
          !items.some(item => item.startsWith('theme:')),
          `${scheme}: ▾ no longer holds a Theme… form (the bar's icon is the picker)`,
        );
        check(
          items.some(item => item.startsWith('restart:') && item.includes('Outdated')),
          `${scheme}: ▾ says the ferret is outdated, on its remedy`,
        );
      }
      await page.context().close();
    }

    // 3b. The theme picker from the header's own icon, on a phone: visible ✕, and every way out works.
    {
      const page = await open(theme, 390);
      await themePickerPaths(page, `${scheme} phone chat`, true, scheme, 'theme-open');
      await page.context().close();
    }

    // 4. ⓘ opens Info, and "About this ferret" holds everything the bar gave up.
    {
      const page = await open(theme, 390);
      await page.locator('[data-session-info-toggle]').tap();
      await page.waitForTimeout(600);
      await shot(page, 'info', scheme);
      await expectAbout(page, `${scheme} phone`);
      await page.context().close();
    }

    // 5. The desktop: the same facts beside the chat, in the right-hand Info panel.
    {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        colorScheme: theme.endsWith('dark') ? 'dark' : 'light',
      });
      const page = await context.newPage();
      page.on('pageerror', error => process.stderr.write(`⚠️ page error: ${error.message}\n`));
      await page.goto(`${server.url}?theme=${theme}`);
      await page.locator('.fy-transcript').waitFor();
      await page.waitForTimeout(600);
      await shot(page, 'desktop', scheme);
      await themePickerPaths(page, `${scheme} desktop chat`, false, scheme, 'desktop-theme-open');
      const stillThere = await page.evaluate(
        gone => gone.filter(selector => document.querySelector(`[data-session-bar] ${selector}`) !== null),
        GONE_FROM_BAR,
      );
      check(
        stillThere.length === 0,
        `${scheme} desktop: the bar carries none of the moved-out info (${stillThere.join(', ')})`,
      );
      await page.locator('[data-session-info-toggle]').click();
      await page.waitForTimeout(600);
      await shot(page, 'desktop-info', scheme);
      await expectAbout(page, `${scheme} desktop`);
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.stop();
}

if (failures.length > 0) {
  process.stderr.write(`\n❌ ${failures.length} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\n✅ every phone check passed\n');
