/**
 * Screenshots of an Inbox item open with its History: the ferret's questions and answers and the owner's replies as
 * the chat's own message bubbles, then words quoted out of a bubble into the composer under the item. Phone 390 and
 * desktop 1440, light and dark. Review evidence; the checks fail on a missing bubble or a quote that never lands.
 *
 *   bun harness/inbox-item-history-screenshot.ts [outDir]   # writes <outDir>/inbox-item-<history|quoted>-<phone|desktop>-<theme>.png
 *
 * It bundles `inbox-page.tsx` (the real `AgendaInboxPage` and `Composer`, invented data) and serves it on loopback;
 * every non-loopback request is aborted.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'inbox-item-history-build');
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
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 900 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;
const QUOTED = 'the ledger is read in full once a day';

try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2,
        timezoneId: 'UTC',
        locale: 'en-US',
        colorScheme: scheme,
        reducedMotion: 'reduce',
      });
      try {
        await context.route('**/*', route =>
          route.request().url().startsWith(server.url.origin) ? route.continue() : route.abort(),
        );
        const page = await context.newPage();
        page.on('pageerror', error => fail(`page error in ${scheme} ${viewport.name}: ${error.message}`));
        await page.clock.setFixedTime(new Date('2026-10-29T09:00:00.000Z'));
        await page.goto(`${server.url}?theme=studio-${scheme}&view=open`);
        await page.locator('[data-fixture]').waitFor({ state: 'visible' });
        const bubbles = page.locator('.fy-attn-deck__top .fy-item-history__chat');
        await bubbles.first().waitFor({ state: 'visible' });
        const count = await bubbles.count();
        if (count !== 3) fail(`${scheme} ${viewport.name}: ${count} History bubbles, not 3`);
        const owner = await bubbles.filter({ hasText: 'Is Postgres overkill' }).count();
        if (owner !== 1) fail(`${scheme} ${viewport.name}: the owner's reply is not in History`);
        const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (wide > 0) fail(`${scheme} ${viewport.name} scrolls sideways by ${wide}px`);
        await bubbles.last().scrollIntoViewIfNeeded();
        await page.waitForTimeout(150);
        const historyShot = join(outDir, `inbox-item-history-${viewport.name}-${scheme}.png`);
        await page.screenshot({ path: historyShot });
        process.stdout.write(`📸 ${historyShot}\n`);

        const point = await page.evaluate(text => {
          const root = document.querySelector('.fy-attn-deck__top .fy-item-history__chat:last-of-type') as Node;
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            const at = (node.textContent ?? '').indexOf(text);
            if (at < 0) continue;
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + text.length);
            window.getSelection()?.removeAllRanges();
            window.getSelection()?.addRange(range);
            const rect = range.getBoundingClientRect();
            return { x: rect.x + Math.min(rect.width / 2, 120), y: rect.bottom - 2 };
          }
          return null;
        }, QUOTED);
        if (point === null) fail(`${scheme} ${viewport.name}: the words to quote were not found`);
        const at = point as { x: number; y: number };
        await page.evaluate(({ x, y }) => {
          const target = document.elementFromPoint(x, y) as HTMLElement;
          target.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', clientX: x, clientY: y }),
          );
          target.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }),
          );
        }, at);
        await page.getByRole('menuitem', { name: 'Quote in composer' }).click();
        const value = await page.locator('[data-inbox-composer] [data-live-editor]').innerText();
        if (!value.includes(QUOTED)) fail(`${scheme} ${viewport.name}: the composer holds ${JSON.stringify(value)}`);
        await page.evaluate(() => {
          const body = document.querySelector<HTMLElement>('.fy-attn-deck__top [data-agenda-body]');
          body?.scrollTo(0, body.scrollHeight);
        });
        await page.waitForTimeout(150);
        const quotedShot = join(outDir, `inbox-item-quoted-${viewport.name}-${scheme}.png`);
        await page.screenshot({ path: quotedShot });
        process.stdout.write(`📸 ${quotedShot}\n`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  server.stop();
}
process.stdout.write('✅ History bubbles and the quote checked\n');
