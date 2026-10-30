/**
 * Screenshots and checks for the Inbox v2: the list (who AND what on every group — callsign, task, card, machine),
 * an item OPEN as the chat's full item view with the ferret's real composer under it, and that item held mid-swipe
 * UP (stamped with its primary answer) and DOWN (stamped "Skip"). Phone 390 and desktop 1440, Studio light and dark.
 *
 *   bun harness/inbox-v2-screenshot.ts [outDir]   # writes <outDir>/inbox-v2-<name>-<phone|desktop>-<theme>.png
 *
 * It bundles `inbox-page.tsx` (the real `AgendaInboxPage` and `Composer`, invented data), serves it on an ephemeral
 * loopback port, drives it with a real pointer, and FAILS (after writing every picture) when: a page scrolls
 * sideways; a group head lacks its task or card; the open item is not the full item view; its who-and-what line or
 * its composer is missing or off screen; a hint line is drawn under the card (the owner removed it); or a held drag is not
 * stamped with what it would do. Nothing is sent: the drag is put back before it is let go.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'inbox-v2-build');
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
const THEMES = ['studio-light', 'studio-dark'] as const;
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
  await page.waitForTimeout(250);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 0, `${view}: scrolls sideways by ${wide}px`);
  return page;
};

const shot = async (page: Page, name: string, form: Form, theme: string): Promise<void> => {
  await page.waitForTimeout(120);
  const path = join(outDir, `inbox-v2-${name}-${form}-${theme}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

/** Holds a drag from the item's head by `dy`, shoots it, then puts it back before letting go: nothing is sent. */
const holdDrag = async (page: Page, dy: number, name: string, form: Form, theme: string, stamp: string) => {
  const head = page.locator('.fy-attn-deck__top [data-agenda-title]').first();
  const box = await head.boundingBox();
  if (box === null) return fail(`${form} ${theme}: the open item's head is not on screen`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 6; step += 1) await page.mouse.move(x, y + (dy * step) / 6);
  await page.waitForTimeout(80);
  const said = (await page.locator('[data-agenda-stamp]').textContent())?.trim() ?? '';
  check(said === stamp, `${form} ${theme} ${name}: the stamp says "${said}", not "${stamp}"`);
  await shot(page, name, form, theme);
  await page.mouse.move(x, y);
  await page.mouse.up();
  await page.waitForTimeout(250);
};

for (const form of ['phone', 'desktop'] as const) {
  for (const theme of THEMES) {
    const context = await browser.newContext({ ...(form === 'phone' ? PHONE : DESKTOP), ...LOCALE });

    // The list: every group says who AND what — callsign, task, card, machine.
    const list = await open(context, theme, 'sections');
    const heads = await list.locator('[data-agenda-group-link]').allTextContents();
    check(heads.length > 0, `${form} ${theme}: no ferret groups`);
    check(
      heads.some(text => text.includes('Ledger storage') && text.includes('&F41')),
      `${form} ${theme}: a group head lacks its task and card: ${JSON.stringify(heads)}`,
    );
    await shot(list, 'list', form, theme);
    await list.close();

    // An item open: who and what, the full item view, the hint, the real composer.
    const item = await open(context, theme, 'open');
    const view = item.locator('.fy-attn-deck__top [data-agenda-view]');
    check((await view.count()) === 1, `${form} ${theme}: the open item is not the full item view`);
    const who = (await item.locator('.fy-attn-deck__top [data-inbox-who]').textContent()) ?? '';
    check(
      ['Ottilie', 'Ledger storage', '&F41', 'studio'].every(part => who.includes(part)),
      `${form} ${theme}: the who-and-what line says "${who}"`,
    );
    check((await item.locator('[data-inbox-swipe-hint]').count()) === 0, `${form} ${theme}: the hint line is back`);
    const composer = item.locator('[data-inbox-composer] textarea, [data-inbox-composer] [contenteditable]').first();
    await composer.waitFor({ state: 'visible' });
    const composerBox = await composer.boundingBox();
    const height = (form === 'phone' ? PHONE : DESKTOP).viewport.height;
    check(
      composerBox !== null && composerBox.y + composerBox.height <= height + 1,
      `${form} ${theme}: the composer is off screen (${JSON.stringify(composerBox)})`,
    );
    await shot(item, 'open', form, theme);
    await holdDrag(item, -150, 'swipe-up', form, theme, 'SQLite');
    await holdDrag(item, 150, 'swipe-down', form, theme, 'Skip');
    await item.close();
    await context.close();
  }
}

await browser.close();
server.stop();
if (violations.length > 0) fail(`${violations.length} of ${checks} checks failed`);
process.stdout.write(`✅ ${checks} checks passed\n`);
