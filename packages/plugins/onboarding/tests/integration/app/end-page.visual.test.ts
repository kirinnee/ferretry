/**
 * THE LAST PAGE ("You're set up"), in a real browser, over fixed fake data (`fixtures/end-page-scene.tsx`). The owner's
 * words: "this page looks really bad" and "buttons: proper spacing, proper width". So the asserts are on computed
 * geometry, not a snapshot:
 *
 *   1280  what was set up and the way to start sit SIDE BY SIDE (no empty right half); every row of what was set up has
 *         an icon; the buttons of a group are one width and one left edge; the "left for later" buttons are the
 *         frame's own 136px; nothing is wider than the viewport; the page says little.
 *   390   one column, what was set up first; the same equal widths; every button inside the screen; no sideways scroll.
 *
 * Light and dark. Set `FY_END_PAGE_SHOTS_DIR` to keep a screenshot of each case.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

type Browser = Awaited<ReturnType<typeof sharedChromium>>;

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_END_PAGE_SHOTS_DIR ?? '';

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 800, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-end-page-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/end-page-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the end-page scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  const { css, js } = await build();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(html, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly right: number;
  readonly bottom: number;
}
const READ = `(selector) => [...document.querySelectorAll(selector)].map(node => {
  const b = node.getBoundingClientRect();
  return { x: b.left, y: b.top, w: b.width, h: b.height, right: b.right, bottom: b.bottom };
})`;

describe('the last page', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const) {
      it(`is laid out, not dumped (${viewport.name}, ${mode})`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: mode,
          deviceScaleFactor: viewport.phone ? 2 : 1,
          ...(viewport.phone ? { isMobile: true, hasTouch: true } : {}),
        });
        const origin = server?.url.origin ?? '';
        await context.route('**/*', async route =>
          new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
        );
        const tab = await context.newPage();
        try {
          await tab.goto(`${origin}/?case=later&theme=studio-${mode}`);
          await tab.waitForSelector('[data-flow-end]');
          await tab.waitForTimeout(300);
          const all = async (selector: string): Promise<readonly Box[]> =>
            (await tab.evaluate(`(${READ})(${JSON.stringify(selector)})`)) as readonly Box[];
          const one = async (selector: string): Promise<Box> => {
            const boxes = await all(selector);
            expect(boxes.length, `${selector} is drawn once`).toBe(1);
            return boxes[0] as Box;
          };
          const sameWidth = (boxes: readonly Box[], label: string): void => {
            expect(boxes.length, `${label}: there are buttons`).toBeGreaterThan(0);
            for (const box of boxes) {
              expect(Math.abs(box.w - (boxes[0] as Box).w), `${label}: one width`).toBeLessThanOrEqual(1);
              expect(Math.abs(box.x - (boxes[0] as Box).x), `${label}: one left edge`).toBeLessThanOrEqual(1);
              expect(box.h, `${label}: a 44px target`).toBeGreaterThanOrEqual(43.5);
              expect(box.x, `${label}: inside the screen`).toBeGreaterThanOrEqual(0);
              expect(box.right, `${label}: inside the screen`).toBeLessThanOrEqual(viewport.width);
            }
          };

          const summary = await one('[data-onboarding-summary]');
          const start = await one('[data-flow-end-start]');
          const later = await all('[data-onboarding-later-link]');
          const starts = await all('[data-flow-end-start] button');
          const settings = await all('[data-onboarding-open-settings]');
          expect(later.length, 'three things left for later, each with its own button').toBe(3);
          expect(starts.length, 'two ways to start').toBe(2);
          sameWidth(later, 'later buttons');
          sameWidth(starts, 'start buttons');
          expect(
            starts[1] === undefined ? 0 : starts[1].y - (starts[0] as Box).bottom,
            'start buttons: 8–16px apart',
          ).toBeGreaterThanOrEqual(8);
          expect(starts[1] === undefined ? 99 : starts[1].y - (starts[0] as Box).bottom).toBeLessThanOrEqual(16);
          sameWidth(settings, 'the Settings button');
          expect((later[0] as Box).w, 'later buttons are the frame’s 136px').toBeGreaterThanOrEqual(135);
          expect((later[0] as Box).w).toBeLessThanOrEqual(137);
          expect((settings[0] as Box).w, 'the Settings button is the same 136px').toBeGreaterThanOrEqual(135);
          expect((settings[0] as Box).w).toBeLessThanOrEqual(137);

          // Every row of what was set up has an icon (a drawn mark, not a bare sentence).
          const rows = await all('[data-end-row]');
          const icons = await all('[data-end-row] svg');
          expect(rows.length, 'rows of what was set up').toBeGreaterThanOrEqual(2);
          expect(icons.length, 'one icon per row').toBe(rows.length);

          if (viewport.phone) {
            expect(start.y, '390: the way to start comes after what was set up').toBeGreaterThanOrEqual(summary.bottom);
          } else {
            expect(start.x, '1280: start sits to the right of the summary').toBeGreaterThanOrEqual(summary.right + 16);
            expect(Math.abs(start.y - summary.y), '1280: the two columns start together').toBeLessThanOrEqual(8);
            const body = await one('.fy-spf__body');
            expect(
              (start.right - summary.x) / body.w,
              '1280: the two columns fill the page body (no empty right half)',
            ).toBeGreaterThanOrEqual(0.95);
          }

          // Few words: what was set up, what is left, and the way on; the page body is not a wall of text.
          const words = await tab.evaluate(
            () =>
              (document.querySelector('.fy-spf__body') as HTMLElement).innerText.split(/\s+/u).filter(Boolean).length,
          );
          expect(words, 'the body says little').toBeLessThanOrEqual(50);
          expect(
            await tab.locator('[data-flow-end-note]').evaluate(node => (node as HTMLDetailsElement).open),
            'the long words about projects start closed',
          ).toBe(false);

          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          const next = await one('[data-step-next]');
          expect(next.bottom, 'Open this machine is on screen').toBeLessThanOrEqual(viewport.height + 1);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `end-page-${viewport.name}-${mode}-later.png`) });

          // Nothing skipped: no "left for later" list, no empty box for it.
          await tab.goto(`${origin}/?case=clean&theme=studio-${mode}`);
          await tab.waitForSelector('[data-flow-end]');
          expect(await tab.locator('[data-onboarding-later-link]').count()).toBe(0);
          expect(await tab.locator('[data-onboarding-summary-later]').count()).toBe(0);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `end-page-${viewport.name}-${mode}-clean.png`) });

          // Only this device's pages; and no start button at all (both screens paused): the page still closes.
          await tab.goto(`${origin}/?case=device&theme=studio-${mode}`);
          await tab.waitForSelector('[data-flow-end]');
          expect(
            await tab
              .locator('[data-end-row]')
              .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-end-row'))),
          ).toEqual(['device', 'skipped']);
          await tab.goto(`${origin}/?case=bare&theme=studio-${mode}`);
          await tab.waitForSelector('[data-flow-end]');
          expect(await tab.locator('[data-flow-end-start]').count()).toBe(0);
          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          if (viewport.phone === false) {
            const only = await one('[data-onboarding-summary]');
            const body = await one('.fy-spf__body');
            expect(
              only.w / body.w,
              '1280: with no start section the summary is the whole body, not a half',
            ).toBeGreaterThanOrEqual(0.95);
          }
        } finally {
          await context.close();
        }
      }, 90_000);
    }
});
