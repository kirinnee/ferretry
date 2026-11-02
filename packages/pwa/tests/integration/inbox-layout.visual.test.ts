/**
 * THE INBOX LIST LINES UP, in a real browser, on a phone (390, 320) and a desktop (1440, 1100), in light and dark,
 * in the studio and neo themes.
 *
 * The owner (2026-11-02, &B136): "all the search bar, buttons everything should align properly. EVEN (especially) on
 * mobile".
 *
 *  - ONE ROW: the toolbar's controls share one top, one bottom and one height (±1px) — the Open/Ferrets/Machine pills,
 *    the Find icon, and on a wide screen "Answer quickly" — so none is a different size.
 *  - THE COLUMN'S EDGES: the first control's left edge is the cards' left edge, and the last control's right edge is
 *    the cards' right edge. On a phone "Answer quickly" is the first line of the list and spans the same column.
 *  - ONE LEFT EDGE below: section titles, ferret lines and cards start at the same x, and end at the same x.
 *  - Nothing scrolls sideways.
 *
 * Set `FY_INBOX_LAYOUT_SHOTS_DIR` to keep `<viewport>-<theme>-<scheme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const shotsDir = process.env.FY_INBOX_LAYOUT_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-inbox-layout-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/inbox-layout-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the inbox layout scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const { css, js } = await build();
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: 'phone-390', width: 390, height: 844, phone: true },
  { name: 'phone-320', width: 320, height: 640, phone: true },
  { name: 'desktop-1440', width: 1_440, height: 900, phone: false },
  { name: 'desktop-1100', width: 1_100, height: 800, phone: false },
] as const;
const THEMES = ['studio', 'neo'] as const;
const SCHEMES = ['light', 'dark'] as const;

const open = async (
  viewport: (typeof VIEWPORTS)[number],
  theme: string,
  scheme: 'light' | 'dark',
): Promise<{ tab: Page; close: () => Promise<void> }> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: scheme,
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  tab.on('console', message => message.type() === 'error' && problems.push(message.text()));
  await tab.goto(`${origin}/?theme=${theme}-${scheme}`);
  try {
    await tab.waitForSelector('[data-agenda-row]', { timeout: 4_000 });
    await tab.waitForSelector('[data-agenda-find-open]', { timeout: 4_000 });
  } catch (error) {
    throw new Error(`the scene did not draw: ${String(error)}\n${problems.join('\n')}`);
  }
  return { tab, close: async () => await context.close() };
};

interface Box {
  readonly what: string;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly height: number;
}

/** Every box the page draws that must line up, measured in one pass so nothing moves between readings. */
const measure = async (tab: Page) =>
  await tab.evaluate(() => {
    const box = (what: string, element: Element): Box => {
      const rect = element.getBoundingClientRect();
      return { what, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    const all = (selector: string, what: string) => [...document.querySelectorAll(selector)].map(e => box(what, e));
    const head = document.querySelector('.fy-attn-inbox__head') as HTMLElement;
    const page = document.querySelector('.fy-attn-inbox') as HTMLElement;
    const controls = [
      ...all('.fy-attn-inbox__head .fy-filter-menu__trigger', 'menu'),
      ...all('.fy-attn-inbox__head .fy-filter-menu__find', 'find'),
      ...all('.fy-attn-inbox__head .fy-inbox-quick', 'quick'),
    ];
    const bodyQuick = all('.fy-inbox-body .fy-inbox-quick', 'body quick');
    const column = [
      ...all('[data-agenda-section] > .fy-inbox-section__title', 'section title'),
      ...all('.fy-inbox-group', 'group'),
      ...all('.fy-inbox-group__head', 'ferret line'),
      ...all('[data-agenda-row]', 'card'),
      ...bodyQuick,
    ];
    const style = getComputedStyle(page);
    const inner = { left: page.getBoundingClientRect().left + parseFloat(style.paddingLeft) };
    return {
      controls,
      column,
      title: all('.fy-attn-inbox__title', 'title'),
      head: box('head', head),
      innerLeft: inner.left,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      pageOverflow: page.scrollWidth - page.clientWidth,
      menus: all('.fy-attn-inbox__head .fy-filter-menu__trigger', 'menu').length,
      clipped: [...document.querySelectorAll('.fy-attn-inbox__head .fy-filter-menu__label')]
        .filter(label => label.scrollWidth > label.clientWidth + 1)
        .map(label => label.textContent),
    };
  });

const near = (a: number, b: number, what: string) =>
  expect(Math.abs(a - b), `${what}: ${a} vs ${b}`).toBeLessThanOrEqual(1);

describe('the Inbox list lines up', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      for (const scheme of SCHEMES) {
        const label = `${viewport.name}, ${theme}, ${scheme}`;

        it(`has one row of equal controls whose ends are the card column's edges (${label})`, async () => {
          const { tab, close } = await open(viewport, theme, scheme);
          try {
            const found = await measure(tab);
            expect(found.menus, 'Show, Ferrets and Machine').toBe(3);
            const controls = [...found.controls].sort((a, b) => a.left - b.left);
            expect(controls.length).toBe(viewport.phone ? 4 : 5);
            const first = controls[0] as Box;
            for (const control of controls) {
              near(control.height, first.height, `${control.what} height`);
              near(control.top, first.top, `${control.what} top`);
              near(control.bottom, first.bottom, `${control.what} bottom`);
            }
            // The row never wraps: every control sits inside the head's one line.
            expect(found.head.height, 'the toolbar is one row').toBeLessThanOrEqual(first.height + 2);

            const column = found.column;
            const left = (column.find(entry => entry.what === 'card') as Box).left;
            const right = (column.find(entry => entry.what === 'card') as Box).right;
            for (const entry of column) {
              near(entry.left, left, `${entry.what} left edge`);
              near(entry.right, right, `${entry.what} right edge`);
            }
            near(found.innerLeft, left, 'the page column');
            // Phone: the status pill opens the row; desktop: the title does.
            near(((viewport.phone ? undefined : found.title[0]) ?? first).left, left, 'the row start');
            near((controls.at(-1) as Box).right, right, 'the row end');
            expect(found.clipped, 'no menu label is cut short').toEqual([]);
            expect(found.overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
            expect(found.pageOverflow, 'no sideways scroll in the page').toBeLessThanOrEqual(0);
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${label.replace(/, /g, '-')}-list.png`) });
          } finally {
            await close();
          }
        });

        it(`keeps the row's controls the same height with Find open (${label})`, async () => {
          const { tab, close } = await open(viewport, theme, scheme);
          try {
            await tab.locator('[data-agenda-find-open]').click();
            await tab.waitForSelector('[data-agenda-find]');
            const found = await tab.evaluate(() => {
              const rect = (selector: string) => {
                const r = (document.querySelector(selector) as Element).getBoundingClientRect();
                return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
              };
              const column = rect('[data-agenda-row]');
              return {
                find: rect('.fy-attn-inbox__find'),
                menu: rect('.fy-attn-inbox__head .fy-filter-menu__trigger'),
                column,
                overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              };
            });
            near(found.find.height, found.menu.height, 'Find box height');
            expect(found.find.left, 'Find stays in the column').toBeGreaterThanOrEqual(found.column.left - 1);
            expect(found.find.right, 'Find stays in the column').toBeLessThanOrEqual(found.column.right + 1);
            expect(found.overflow).toBeLessThanOrEqual(0);
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${label.replace(/, /g, '-')}-find-open.png`) });
          } finally {
            await close();
          }
        });
      }
});
