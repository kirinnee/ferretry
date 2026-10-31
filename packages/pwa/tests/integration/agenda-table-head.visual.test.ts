/**
 * A MARKDOWN TABLE NEVER COVERS THE OPEN AGENDA CARD'S HEAD, in a real browser, on a phone and a desktop, in light
 * and dark.
 *
 * The owner (2026-10-31, &B109): "sticky table header clips". The open card's head (the pager, the title) sticks to
 * the top of the card's scroller (#1192); a table's own sticky header row used to stick to the same edge and painted
 * over it.
 *
 *  - The scene is the REAL `AgendaItemView` over a card with two markdown tables (`fixtures/agenda-table-scene.tsx`),
 *    scrolled from the top to the end in small steps. At every step no table cell may be painted over the head: where
 *    a cell's box meets the head's box, the head is what the pixel belongs to.
 *  - A table too wide for the column scrolls sideways INSIDE its own box and says so: the box is the scroller, the
 *    card body never gains a horizontal scroll, and the box carries an edge cue while there is more to the right.
 *
 * Set `FY_TABLE_HEAD_SHOTS_DIR` to keep `<viewport>-<scheme>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const shotsDir = process.env.FY_TABLE_HEAD_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-chat-log { flex: 1 1 0; }
  .scene-composer { border: 1px solid var(--fy-border, #888); border-radius: 12px; box-sizing: border-box; height: 56px; padding: 16px; }
`;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-table-head-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/agenda-table-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the table scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const { css, js } = await build();
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${SCENE_CSS}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
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

const framesSettled = async (tab: Page): Promise<void> =>
  await tab.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

const VIEWPORTS = [
  { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
  { name: 'desktop', viewport: { width: 1_440, height: 900 }, deviceScaleFactor: 1 },
] as const;

const open = async (
  name: string,
  scheme: 'light' | 'dark',
  query: string,
): Promise<{ tab: Page; close: () => Promise<void> }> => {
  const viewport = VIEWPORTS.find(entry => entry.name === name) ?? VIEWPORTS[0];
  const context = await browser.newContext({
    viewport: viewport.viewport,
    colorScheme: scheme,
    deviceScaleFactor: viewport.deviceScaleFactor,
    hasTouch: name === 'phone',
    isMobile: name === 'phone',
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=studio-${scheme}${query}`);
  await tab.waitForSelector('.fy-item-view__body table');
  await framesSettled(tab);
  return { tab, close: async () => await context.close() };
};

/** The cells whose box meets the head's box, and whether the pixel there belongs to the head. */
const coveringTheHead = async (tab: Page): Promise<readonly string[]> =>
  await tab.evaluate(() => {
    const head = document.querySelector('.fy-item-view__head') as HTMLElement;
    const area = head.getBoundingClientRect();
    const covering: string[] = [];
    for (const cell of document.querySelectorAll('.fy-item-view__body th, .fy-item-view__body td')) {
      const rect = cell.getBoundingClientRect();
      const left = Math.max(rect.left, area.left);
      const right = Math.min(rect.right, area.right);
      const top = Math.max(rect.top, area.top);
      const bottom = Math.min(rect.bottom, area.bottom);
      if (right - left < 2 || bottom - top < 2) continue;
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      if (hit !== null && !head.contains(hit))
        covering.push(`${cell.tagName} "${(cell.textContent ?? '').slice(0, 20)}"`);
    }
    return covering;
  });

const scrollSteps = async (tab: Page, visit: (label: string) => Promise<void>): Promise<void> => {
  const range = await tab.evaluate(() => {
    const body = document.querySelector('.fy-item-view__body') as HTMLElement;
    return body.scrollHeight - body.clientHeight;
  });
  expect(range, 'the card is long enough to scroll').toBeGreaterThan(200);
  for (let at = 0; at <= range; at += 37) {
    await tab.evaluate(top => {
      (document.querySelector('.fy-item-view__body') as HTMLElement).scrollTop = top;
    }, at);
    await framesSettled(tab);
    await visit(`scrollTop ${String(at)}`);
  }
};

describe('a markdown table in the open agenda item', () => {
  for (const { name } of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      for (const view of ['table', 'cards'] as const) {
        if (name === 'desktop' && view === 'cards') continue;
        it(`never paints over the card's head while the card scrolls (${name}, ${scheme}, ${view})`, async () => {
          const { tab, close } = await open(name, scheme, `&view=${view}`);
          try {
            await scrollSteps(tab, async label => {
              expect(await coveringTheHead(tab), `${label}: cells painted over the head`).toEqual([]);
            });
            await tab.evaluate(() => {
              const body = document.querySelector('.fy-item-view__body') as HTMLElement;
              const table = body.querySelector('table') as HTMLElement;
              body.scrollTop =
                table.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop + 90;
            });
            await framesSettled(tab);
            if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-${view}-mid.png`) });
          } finally {
            await close();
          }
        });
      }

  // A desktop wraps every cell to the pane and never scrolls a table sideways, so only a phone has this to prove.
  for (const name of ['phone'] as const)
    for (const scheme of ['light', 'dark'] as const)
      it(`scrolls a table that cannot wrap inside its own box and shows that it does (${name}, ${scheme})`, async () => {
        const { tab, close } = await open(name, scheme, '&view=table&wide=1');
        try {
          const state = await tab.evaluate(() => {
            const body = document.querySelector('.fy-item-view__body') as HTMLElement;
            const box = document.querySelector('.fy-item-view__body .md-table-scroll') as HTMLElement;
            return {
              bodyOverflowsSideways: body.scrollWidth > body.clientWidth + 1,
              boxScrolls: box.scrollWidth > box.clientWidth + 1,
              boxOverflowX: getComputedStyle(box).overflowX,
              cue: box.dataset.mdTableMore ?? null,
            };
          });
          expect(state.bodyOverflowsSideways, 'the card body does not scroll sideways').toBe(false);
          expect(state.boxScrolls, 'the table box is the scroller').toBe(true);
          expect(['auto', 'scroll']).toContain(state.boxOverflowX);
          expect(state.cue, 'there is more to the right and the box says so').toBe('end');
          await tab.evaluate(() => {
            const box = document.querySelector('.fy-item-view__body .md-table-scroll') as HTMLElement;
            box.scrollLeft = box.scrollWidth;
          });
          await framesSettled(tab);
          const atEnd = await tab.evaluate(
            () =>
              (document.querySelector('.fy-item-view__body .md-table-scroll') as HTMLElement).dataset.mdTableMore ??
              null,
          );
          expect(atEnd, 'at the far end there is nothing more to the right').toBe('start');
          await tab.evaluate(() => {
            const body = document.querySelector('.fy-item-view__body') as HTMLElement;
            const table = body.querySelector('table') as HTMLElement;
            body.scrollTop =
              table.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 120;
          });
          await framesSettled(tab);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-wide.png`) });
        } finally {
          await close();
        }
      });
});
