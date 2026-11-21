/**
 * THE LAST PAGE ("You're set up"), in a real browser, over fixed fake data (`fixtures/end-page-scene.tsx`). The owner's
 * words: "this page looks really bad" and "buttons: proper spacing, proper width". So the asserts are on computed
 * geometry, not a snapshot:
 *
 *   r11-1b G1 (gate r11-1 lines 2 and 12): the page draws the picture the `onboarding.end` slot holds (Access's cheering ferret,
 *         proved real and hover-reactive in Access's own tests; here a stand-in of the same box) in the frame's demo
 *         column — the right half at 1280, above the page at 390; with no panel in the slot there is no column; one primary button; the "You're set up" heading is on screen at the top;
 *         at 390 the footer's Open this machine is ONE line (no wrap) and Back is the footer's fixed 136px.
 *   both  NO BOX: no ancestor of the summary (up to the page) and nothing inside it draws a border; one row per segment,
 *         each with a mark, 44px tall; a segment set up in part says "Partly set up" with a link to finish it, a skipped
 *         one says "Finish later"; no "(some pages skipped)"; the page text is at most 300 characters; exactly one
 *         primary button; nothing is wider than the screen; no content is under the sticky footer at the end of the scroll.
 *   1280  the checklists (this machine, this device) are STACKED in the left column and the ferret fills the right half;
 *         Create a project, Continue a conversation and Open this machine are ONE width (±1px).
 *   390   the checklists are stacked; the two ways to start fill their row, 8–16px apart.
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

          // ── no box: nothing that wraps the summary, and nothing inside it, has a visible border ───────────────────
          const borders = await tab.evaluate(() => {
            const summary = document.querySelector('[data-onboarding-summary]') as HTMLElement;
            const page = document.querySelector('[data-flow-end]') as HTMLElement;
            const visible = (node: Element): boolean => {
              const style = getComputedStyle(node);
              return ['Top', 'Right', 'Bottom', 'Left'].some(
                side =>
                  Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 &&
                  style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none',
              );
            };
            const wrapping: string[] = [];
            for (let node: Element | null = summary; node !== null; node = node.parentElement) {
              if (visible(node)) wrapping.push(node.className || node.tagName);
              if (node === page) break;
            }
            const inside = [...summary.querySelectorAll('*')]
              .filter(visible)
              .map(node => node.className || node.tagName);
            return { wrapping, inside };
          });
          expect(borders.wrapping, 'no ancestor of the summary (up to the page) draws a border').toEqual([]);
          expect(borders.inside, 'nothing inside the summary draws a border').toEqual([]);

          // ── the checklists: one row per segment, side by side on a desktop, stacked on a phone ────────────────────
          const machineList = await one('[data-end-list="machine"]');
          const deviceList = await one('[data-end-list="device"]');
          expect(deviceList.y, 'the device checklist is under the machine one').toBeGreaterThanOrEqual(
            machineList.bottom,
          );
          expect(Math.abs(deviceList.x - machineList.x), 'one left edge').toBeLessThanOrEqual(1);
          expect(Math.abs(deviceList.w - machineList.w), 'one width').toBeLessThanOrEqual(1);
          const rows = await all('[data-end-row]');
          expect(rows.length, 'one row per segment: 6 on the machine, 2 on this device').toBe(8);
          expect(await all('[data-end-row] svg'), 'every row has its mark').toHaveLength(rows.length);
          expect(await all('[data-end-state="done"] svg'), 'the set-up rows are checked').toHaveLength(3);
          for (const row of rows) expect(row.h, 'a row is a 44px target').toBeGreaterThanOrEqual(43.5);
          const states = await tab
            .locator('[data-end-row]')
            .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-end-state')));
          expect(states.filter(state => state === 'done').length).toBe(3);
          expect(states.filter(state => state === 'partial').length, 'one segment is set up in part').toBe(1);
          expect(states.filter(state => state === 'later').length).toBe(4);

          // ── the words of a segment left for later: quiet, honest, never "(some pages skipped)" ────────────────────
          const partial = await tab.locator('[data-end-state="partial"]').innerText();
          expect(partial, 'a partly set up segment says so').toContain('Claude Code');
          expect(partial).toContain('Partly set up');
          expect(partial, 'and offers to finish it').toContain('Finish');
          const skipped = await tab.locator('[data-end-state="later"]').first().innerText();
          expect(skipped).toContain('Finish later');
          expect(skipped).toContain('Set up');
          const page = await tab.locator('[data-flow-end]').innerText();
          expect(page, 'no "(some pages skipped)"').not.toMatch(/some pages skipped/iu);
          expect(page.length, 'the page says little (300 characters)').toBeLessThanOrEqual(300);
          const later = await all('[data-onboarding-later-link]');
          expect(later.length, 'a link for every segment not set up in full').toBe(5);
          for (const link of later) expect(link.h, 'a quiet link is still a 44px target').toBeGreaterThanOrEqual(43.5);
          expect((await all('[data-onboarding-open-settings]')).length).toBe(1);

          // ── the way on: ONE primary, and the three actions share one width ─────────────────────────────────────────
          expect(
            await tab.locator('[data-variant="primary"]:visible').count(),
            'exactly one primary button on the page',
          ).toBe(1);
          expect(await tab.locator('[data-step-next]').innerText()).toBe('Open this machine');
          const project = await one('[data-flow-end-project]');
          const alternative = await one('[data-flow-end-alternative]');
          const next = await one('[data-step-next]');
          const body = await one('.fy-spf__body');
          for (const [label, box] of [
            ['Create a project', project],
            ['Continue a conversation', alternative],
            ['Open this machine', next],
          ] as const) {
            expect(box.h, `${label}: a 44px target`).toBeGreaterThanOrEqual(43.5);
            expect(box.x, `${label}: inside the screen`).toBeGreaterThanOrEqual(0);
            expect(box.right, `${label}: inside the screen`).toBeLessThanOrEqual(viewport.width);
          }
          if (viewport.phone) {
            for (const box of [project, alternative]) {
              expect(Math.abs(box.w - body.w), '390: a way to start fills the row').toBeLessThanOrEqual(1);
              expect(Math.abs(box.x - body.x), '390: it starts at the row’s edge').toBeLessThanOrEqual(1);
            }
            expect(Math.abs(project.w - alternative.w), '390: the two share one width').toBeLessThanOrEqual(1);
            expect(alternative.y - project.bottom, '390: the two are 8–16px apart').toBeGreaterThanOrEqual(8);
            expect(alternative.y - project.bottom).toBeLessThanOrEqual(16);
            // O2's footer rule: Back is the fixed 136px; Open this machine takes what Back leaves and its label is ONE line.
            const back = await one('[data-step-back]');
            expect(Math.abs(back.w - 136), '390: Back is the footer’s fixed 136px').toBeLessThanOrEqual(1);
            expect(next.w, '390: Open this machine is at least a fixed footer button wide').toBeGreaterThanOrEqual(135);
            expect(next.x - back.right, '390: Back and Open this machine are 12px apart').toBeGreaterThanOrEqual(11);
            expect(next.x - back.right).toBeLessThanOrEqual(13);
            expect(next.h, '390: the label does not wrap (one line, the footer’s height)').toBeLessThanOrEqual(
              back.h + 1,
            );
            expect(
              await tab.locator('[data-step-next]').evaluate(node => {
                const range = document.createRange();
                range.selectNodeContents(node);
                return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
              }),
              '390: Open this machine is drawn on one line',
            ).toBe(1);
          } else {
            expect(Math.abs(project.w - alternative.w), '1280: Create / Continue share one width').toBeLessThanOrEqual(
              1,
            );
            expect(Math.abs(project.w - next.w), '1280: Open this machine shares it too').toBeLessThanOrEqual(1);
            expect(Math.abs(alternative.w - next.w), '1280: all three actions are one width').toBeLessThanOrEqual(1);
            expect(project.w, '1280: a fixed, sensible width (not the row)').toBeLessThan(0.5 * body.w);
            expect(Math.abs(project.y - alternative.y), '1280: the two ways to start share a row').toBeLessThanOrEqual(
              1,
            );
            expect(alternative.x - project.right, '1280: 8–16px apart').toBeGreaterThanOrEqual(8);
            expect(alternative.x - project.right).toBeLessThanOrEqual(16);
          }
          // ── the ferret: the REAL character, in the demo column (the right half at 1280, above the page at 390) ───
          const mascot = await one('[data-end-mascot]');
          expect(mascot.w, 'the mascot is drawn').toBeGreaterThan(0);
          expect(
            await all('[data-end-mascot] [data-panel="access.end-mascot"]'),
            'the picture is the panel Access places in the onboarding.end slot',
          ).toHaveLength(1);
          if (viewport.phone) {
            expect(mascot.bottom, '390: the ferret sits above the lists').toBeLessThanOrEqual(body.y + 1);
            expect(mascot.h, '390: it is big enough to be seen').toBeGreaterThanOrEqual(96);
          } else {
            expect(mascot.x, '1280: the ferret is in the right half, beside the lists').toBeGreaterThanOrEqual(
              body.right,
            );
            expect(mascot.w, '1280: it fills the right half').toBeGreaterThanOrEqual(240);
            expect(mascot.x + mascot.w / 2, '1280: it is right of the middle').toBeGreaterThan(viewport.width / 2);
          }
          // The heading is on screen at the top of the page (390: it used to start at "This machine").
          const heading = await one('.fy-spf__title');
          expect(await tab.locator('.fy-spf__title').innerText()).toBe("You're set up");
          expect(heading.y, 'the "You\'re set up" heading is on screen').toBeGreaterThanOrEqual(0);
          expect(heading.bottom).toBeLessThanOrEqual(viewport.height);
          expect(
            await tab.locator('[data-flow-end-note]').evaluate(node => (node as HTMLDetailsElement).open),
            'the long words about projects start closed',
          ).toBe(false);

          // ── nothing sideways, nothing under the sticky footer ──────────────────────────────────────────────────────
          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          await tab.evaluate(() => (document.querySelector('[data-scene-main]') as HTMLElement).scrollTo(0, 1_000_000));
          await tab.waitForTimeout(100);
          const footer = await one('[data-step-footer]');
          const end = await one('[data-flow-end]');
          expect(footer.bottom, 'the footer is on screen').toBeLessThanOrEqual(viewport.height + 1);
          expect(end.bottom, 'at the end of the scroll, no content is under the footer').toBeLessThanOrEqual(
            footer.y + 1,
          );
          for (const selector of [
            '[data-flow-end-note] summary',
            '[data-onboarding-open-settings]',
            '[data-end-row]:last-child',
          ])
            for (const box of await all(selector))
              expect(box.bottom, `${selector} is above the footer at the end of the scroll`).toBeLessThanOrEqual(
                footer.y + 1,
              );
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `end-page-${viewport.name}-${mode}-later-end.png`) });
          await tab.evaluate(() => (document.querySelector('[data-scene-main]') as HTMLElement).scrollTo(0, 0));
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `end-page-${viewport.name}-${mode}-later.png`) });

          // Nothing skipped: every row checked, no link to finish anything.
          await tab.goto(`${origin}/?case=clean&theme=studio-${mode}`);
          await tab.waitForSelector('[data-flow-end]');
          expect(await tab.locator('[data-onboarding-later-link]').count()).toBe(0);
          expect(await tab.locator('[data-end-state="done"]').count()).toBe(
            await tab.locator('[data-end-row]').count(),
          );
          expect(
            await tab.locator('[data-end-list="device"]').count(),
            'no device checklist when nothing is on it',
          ).toBe(0);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `end-page-${viewport.name}-${mode}-clean.png`) });

          // Access off: no panel in the slot, so no picture column and the lists are the page.
          await tab.goto(`${origin}/?case=later&picture=none&theme=studio-${mode}`);
          await tab.waitForSelector('[data-flow-end]');
          expect(await tab.locator('[data-end-mascot]').count(), 'no picture without a panel').toBe(0);
          expect(await tab.locator('.fy-spf__demo:not(:empty)').count(), 'and no demo column').toBe(0);
          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

          // Only this device's pages; and no start button at all (both screens paused): the page still closes.
          await tab.goto(`${origin}/?case=device&theme=studio-${mode}`);
          await tab.waitForSelector('[data-flow-end]');
          expect(
            await tab
              .locator('[data-end-row]')
              .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-end-row'))),
          ).toEqual(['client:access.passkey']);
          await tab.goto(`${origin}/?case=bare&theme=studio-${mode}`);
          await tab.waitForSelector('[data-flow-end]');
          expect(await tab.locator('[data-flow-end-start]').count()).toBe(0);
          expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          if (viewport.phone === false) {
            const only = await one('[data-onboarding-summary]');
            const bare = await one('.fy-spf__body');
            expect(
              only.w / bare.w,
              '1280: with no start section the summary is the whole body, not a half',
            ).toBeGreaterThanOrEqual(0.95);
          }
        } finally {
          await context.close();
        }
      }, 90_000);
    }
});
