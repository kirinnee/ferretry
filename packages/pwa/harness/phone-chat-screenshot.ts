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
 *     open its item.
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
