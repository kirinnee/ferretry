/**
 * Screenshots and checks for the ITEM VIEW'S LAYOUT v2 (docs/agenda.md § The item view; F909): the head with its
 * description, premise and context, the folded detailed context, terms and references, a short "where we are now",
 * "What I need from you" marked out, the body as "The full picture", then the log — the conversation and the folded
 * activity — at the bottom.
 *
 *   bun harness/agenda-layout-screenshot.ts [outDir]   # writes <outDir>/layout-<scene>-<view>-<phone|desktop>-<theme>.png
 *
 * Each scene (`agenda-layout-page.tsx`) is shot at the top of the view (`top`, the real viewport, the dock at its foot)
 * and whole (`full`, the viewport stretched to the column). It FAILS (after writing every picture) when: a page scrolls
 * sideways; the card is drawn in a fallback font; the parts are out of the new order; the description is missing or
 * not first in the head; the body is not titled "The full picture" or is folded; "What I need from you" is not marked
 * out on an item that needs the owner; the chart or the board block in the question's body is not drawn; or a card
 * ask's buttons are docked.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const harnessDir = import.meta.dir;
const packageDir = resolve(harnessDir, '..');
const buildDir = join(harnessDir, 'out', 'agenda-layout-build');
const outDir = resolve(process.argv[2] ?? '/tmp/claude-1000/shots/f909');

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
  <body class="bg-bg text-fg" style="margin:0"><div id="root"></div><script type="module" src="/agenda-layout-page.js"></script></body>
</html>`;

mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
run('bun', ['build', join(harnessDir, 'agenda-layout-page.tsx'), '--outdir', buildDir, '--target', 'browser']);
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
    // The stylesheet names its fonts relative to src/styles: serve them, so the pictures use the app's own typefaces.
    if (url.pathname.startsWith('/assets/fonts/')) return new Response(Bun.file(join(packageDir, 'src', url.pathname)));
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
const THEMES = ['studio-light', 'studio-dark'] as const;
const SCENES = ['question', 'explainer', 'test', 'long-title'] as const;
const ORDER = ['head', 'premise', 'detail', 'references', 'where', 'needs', 'body', 'conversation', 'activity'];
type Form = 'phone' | 'desktop';

const violations: string[] = [];
let checks = 0;
const check = (ok: boolean, message: string): void => {
  checks += 1;
  if (ok) return;
  violations.push(message);
  process.stderr.write(`❌ ${message}\n`);
};

const shot = async (page: Page, name: string): Promise<void> => {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(250);
  const path = join(outDir, `layout-${name}.png`);
  await page.screenshot({ path });
  process.stdout.write(`📸 ${path}\n`);
};

const inspect = async (page: Page, label: string, scene: string): Promise<void> => {
  const found = await page.evaluate(() => {
    const card = document.querySelector('.fy-card');
    const head = card?.querySelector('[data-agenda-part="head"]');
    const needs = card?.querySelector('[data-agenda-part="needs"]');
    const body = card?.querySelector('[data-agenda-part="body"]');
    const loaded = [...document.fonts].filter(face => face.status === 'loaded').map(face => face.family);
    return {
      sideways: document.documentElement.scrollWidth > window.innerWidth + 1,
      fonts: loaded,
      parts: [...(card?.querySelectorAll('[data-agenda-part]') ?? [])].map(each =>
        each.getAttribute('data-agenda-part'),
      ),
      descriptionFirst: head?.firstElementChild?.hasAttribute('data-agenda-description') ?? false,
      bodyTitle: body?.querySelector('h4')?.textContent ?? null,
      bodyFolded: body?.querySelector('[data-agenda-fold]') !== null && body !== null && body !== undefined,
      needsMarked: needs?.hasAttribute('data-agenda-needs-you') ?? false,
      board: (body?.querySelectorAll('[data-fy-card-embed-board] [data-category]').length ?? 0) > 0,
      dockedCardAsk: document.querySelector('.fy-item-view__dock [data-agenda-card-ask]') !== null,
    };
  });
  check(!found.sideways, `${label}: the page scrolls sideways`);
  check(found.fonts.length > 0, `${label}: no web font loaded (a fallback face)`);
  const order = ORDER.filter(part => found.parts.includes(part));
  check(
    JSON.stringify(order) === JSON.stringify(found.parts),
    `${label}: parts out of order (${found.parts.join(', ')})`,
  );
  check(found.descriptionFirst, `${label}: the description is not the head's first line`);
  check(found.bodyTitle === 'The full picture', `${label}: the body is titled "${String(found.bodyTitle)}"`);
  check(!found.bodyFolded, `${label}: the body is folded`);
  check(found.needsMarked, `${label}: "What I need from you" is not marked out`);
  check(!found.dockedCardAsk, `${label}: a card ask is docked`);
  if (scene === 'question') {
    check(found.board, `${label}: the board block in the body is not drawn`);
  }
};

for (const theme of THEMES)
  for (const [form, options] of [
    ['phone', PHONE],
    ['desktop', DESKTOP],
  ] as const satisfies readonly (readonly [Form, object])[]) {
    const context = await browser.newContext({
      ...options,
      colorScheme: theme.endsWith('-dark') ? 'dark' : 'light',
      timezoneId: 'UTC',
      locale: 'en-US',
    });
    for (const scene of SCENES) {
      const page = await context.newPage();
      await page.goto(`${server.url}?theme=${theme}&scene=${scene}`);
      await page.waitForSelector('.fy-card');
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(800);
      const label = `${scene} ${form} ${theme}`;
      await inspect(page, label, scene);
      await shot(page, `${scene}-top-${form}-${theme}`);
      // Whole: the viewport grows to the column, so every part is in one picture (the head stays at the top).
      const tall = await page.evaluate(
        () => document.querySelector('.fy-item-view__body')?.scrollHeight ?? window.innerHeight,
      );
      await page.setViewportSize({ width: options.viewport.width, height: Math.min(tall + 120, 16_000) });
      await page.waitForTimeout(400);
      // A chart mounts only once it is in view, so it is looked for with the whole column on screen.
      if (scene === 'question') {
        const chart = await page.evaluate(() => document.querySelector('[data-agenda-part="body"] canvas') !== null);
        check(chart, `${label}: the chart in the body is not drawn`);
      }
      await shot(page, `${scene}-full-${form}-${theme}`);
      await page.close();
    }
    await context.close();
  }

await browser.close();
server.stop();
if (violations.length > 0) fail(`${violations.length} of ${checks} checks failed`);
process.stdout.write(`✅ ${checks} checks passed\n`);
