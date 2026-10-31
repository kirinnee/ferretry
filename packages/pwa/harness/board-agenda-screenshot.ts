/**
 * THE OWNER'S "EXPANDED BOARD UNDER THE AGENDA" (2026-10-31, #B86), measured in a real browser on the REAL chat page
 * (`phone-chat-page.tsx`, the same fake daemon the phone-chat harness uses): an agenda item or the agenda drawer is
 * open over the chat, the Tasks tab is expanded to the whole chat, and the board must be what is on screen.
 *
 *   bun harness/board-agenda-screenshot.ts [outDir] [--tag before|after]
 *       # writes <outDir>/board-agenda-<tag>-<scenario>-<desktop|phone>-<light|dark>.png
 *
 * THE RULE it holds: the board and the agenda never share the chat column. Expanding the board closes the agenda's
 * item and drawer; the board is the visible, topmost thing in the chat column; and nothing of the agenda is left
 * over it to be unable to close. It FAILS (after writing every picture) when, once the board is expanded:
 *   - the board's own centre is not what a pointer lands on (something is painted over it);
 *   - an agenda item view, drawer or scrim is still in the document.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'board-agenda-build');
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

const FORMS = {
  desktop: { viewport: { width: 1_440, height: 900 }, hasTouch: false, isMobile: false },
  phone: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
} as const;

const open = async (form: keyof typeof FORMS, scheme: 'light' | 'dark', query: string): Promise<Page> => {
  const context = await browser.newContext({ ...FORMS[form], deviceScaleFactor: 2, colorScheme: scheme });
  const page = await context.newPage();
  page.on('pageerror', error => process.stderr.write(`⚠️ page error: ${error.message}\n`));
  await page.goto(`${server.url}?theme=studio-${scheme}${query}`);
  await page.locator('.fy-transcript').waitFor();
  await page.waitForTimeout(600);
  return page;
};

const shot = async (page: Page, scenario: string, form: string, scheme: string): Promise<void> => {
  const path = join(outDir, `board-agenda-${tag}-${scenario}-${form}-${scheme}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

/** Is the topmost thing at the centre of `selector` inside it? Painted-over (or inert behind a layer) is no. */
const onTop = async (page: Page, selector: string): Promise<boolean> =>
  await page.evaluate(scope => {
    const node = document.querySelector(scope);
    if (node === null) return false;
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + Math.min(box.height / 2, 200));
    return hit !== null && node.contains(hit);
  }, selector);

const expandFromTasks = async (page: Page, form: string): Promise<void> => {
  const expand = page.locator('[data-board-side-expand="expand"]').first();
  await expand.waitFor({ state: 'visible', timeout: 5_000 });
  if (form === 'phone') await expand.tap();
  else await expand.click();
  await page.waitForTimeout(500);
};

try {
  for (const scheme of ['light', 'dark'] as const) {
    for (const form of ['desktop', 'phone'] as const) {
      const label = `${scheme} ${form}`;

      // SCENARIO 1: an agenda item is open over the chat (a `!A55` link), then the board is expanded.
      const withItem = await open(form, scheme, '&agenda=A55&info=tasks');
      check(
        (await withItem.locator('[data-agenda-view]').count()) === 1,
        `${label}: the item is open before expanding`,
      );
      await shot(withItem, 'item-before-expand', form, scheme);
      await expandFromTasks(withItem, form);
      await shot(withItem, 'item', form, scheme);
      check((await withItem.locator('[data-board-full]').count()) === 1, `${label}/item: the board is expanded`);
      check(await onTop(withItem, '[data-board-full]'), `${label}/item: the board is what a pointer lands on`);
      check(
        (await withItem.locator('[data-agenda-view]').count()) === 0,
        `${label}/item: no agenda item is left over the board`,
      );
      await withItem.context().close();

      // SCENARIO 2: the agenda drawer (and its scrim) is open over the chat, then the board is expanded.
      const withDrawer = await open(form, scheme, '&info=tasks');
      if (form === 'desktop') {
        await withDrawer.locator('[data-agenda-line-toggle]').first().click();
        await withDrawer.waitForTimeout(300);
        check(
          (await withDrawer.locator('[data-agenda-drawer]').count()) === 1,
          `${label}: the drawer is open before expanding`,
        );
        await expandFromTasks(withDrawer, form);
        await shot(withDrawer, 'drawer', form, scheme);
        check(await onTop(withDrawer, '[data-board-full]'), `${label}/drawer: the board is what a pointer lands on`);
        check(
          (await withDrawer.locator('[data-agenda-drawer], [data-agenda-scrim]').count()) === 0,
          `${label}/drawer: no drawer or scrim is left over the board`,
        );
      }
      await withDrawer.context().close();
    }
  }
} finally {
  await browser.close();
  server.stop(true);
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} check(s) failed:\n${failures.map(f => `  - ${f}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('\nall checks passed\n');
