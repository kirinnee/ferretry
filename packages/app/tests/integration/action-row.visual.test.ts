/**
 * C59: THE SHARED ANSWER-ROW RULES in a real browser over fake data (`fixtures/action-row-scene.tsx`), the ONE place the
 * audit's many "narrow, unequal, ragged buttons" are fixed. Computed geometry, 390 and 1280, light and dark:
 *   - `ActionRow`: a phone stacks both answers at the container's full width, the way on above; a desktop puts the two answers
 *     side by side as ONE group at the container's right edge (C59 O8-2), both the same size. A lone answer is the same group of one at the right end; on a phone either is the container's full width.
 *   - `fy-action-stack`: every recovery action is one size; on a phone the column's full width.
 *   - `fy-inline-action`: sits on the sentence's line without making it taller (and is no taller than a text line).
 *   - the step frame's footer on a phone: one button is the row's full width, two split it, three are thirds (it was always a
 *     narrow third), and on a desktop Back is grouped with Later and Next at the right end (C59 O8-2).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
/** Set `FY_ACTION_ROW_SHOTS_DIR` to keep `<variant>-row.png` of the answer rows (fake data only). */
const shotsDir = process.env.FY_ACTION_ROW_SHOTS_DIR ?? '';
let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-action-row-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/action-row-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the action row scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === '/app.js'
        ? new Response(js, { headers: { 'content-type': 'text/javascript' } })
        : new Response(page, { headers: { 'content-type': 'text/html' } }),
  });
  browser = await sharedChromium();
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VARIANTS = [
  { name: '1280-light', width: 1_280, height: 800, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 800, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 844, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 844, phone: true, scheme: 'dark' },
] as const;
type Variant = (typeof VARIANTS)[number];

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly right: number;
}

const open = async (variant: Variant, scene: string) => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    colorScheme: variant.scheme,
    hasTouch: variant.phone,
    isMobile: variant.phone,
    deviceScaleFactor: variant.phone ? 2 : 1,
  });
  const origin = server?.url.origin ?? '';
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=studio-${variant.scheme}&scene=${scene}`);
  await tab.waitForSelector('[data-case]');
  await tab.evaluate(async () => await document.fonts.ready);
  return { tab, close: async () => await context.close() };
};

const boxes = async (tab: Page, selector: string): Promise<Box[]> =>
  await tab.evaluate(sel => {
    return Array.from(document.querySelectorAll(sel)).map(element => {
      const r = element.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right };
    });
  }, selector);

describe('C59 the shared answer row', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: ActionRow, two answers: phone stacked full width, desktop the two ends of one row, one size`, async () => {
      const { tab, close } = await open(variant, 'row');
      try {
        const [container] = await boxes(tab, '[data-sample="two"]');
        const [secondary] = await boxes(tab, '[data-sample="two"] [data-b="secondary"]');
        const [primary] = await boxes(tab, '[data-sample="two"] [data-b="primary"]');
        expect(container && secondary && primary).toBeTruthy();
        if (container === undefined || secondary === undefined || primary === undefined) return;
        expect(Math.abs(secondary.w - primary.w), 'one width').toBeLessThanOrEqual(1);
        expect(Math.abs(secondary.h - primary.h), 'one height').toBeLessThanOrEqual(1);
        expect(primary.h, 'a 44 px target').toBeGreaterThanOrEqual(43.5);
        if (variant.phone) {
          // Q6 (ruling C-6): content-sized with a minimum, NEVER the container's full width, 44 px tall, the way on above.
          expect(primary.w, 'phone: narrower than the column').toBeLessThan(container.w - 40);
          expect(Math.abs(primary.w - 192), 'phone: the 12rem minimum').toBeLessThanOrEqual(1);
          expect(primary.x - container.x, 'phone: at the start edge').toBeLessThanOrEqual(1);
          expect(primary.y, 'phone: the way on is above').toBeLessThan(secondary.y);
        } else {
          expect(Math.abs(primary.y - secondary.y), 'desktop: one row').toBeLessThanOrEqual(1);
          // C59 O8-2: ONE group at the right edge: the way out right beside the way on (a 12px gap), not on the far edge.
          expect(Math.abs(primary.right - container.right), 'primary at the right end').toBeLessThanOrEqual(1);
          expect(
            Math.abs(primary.x - (secondary.right + 12)),
            'the answers are one group (12px apart)',
          ).toBeLessThanOrEqual(1);
          expect(secondary.x - container.x, 'the way out is NOT at the far left').toBeGreaterThan(40);
        }
        const [lonePrimary] = await boxes(tab, '[data-sample="lone-primary"] button');
        const [loneContainer] = await boxes(tab, '[data-sample="lone-primary"]');
        const [loneSecondary] = await boxes(tab, '[data-sample="lone-secondary"] button');
        if (lonePrimary === undefined || loneContainer === undefined || loneSecondary === undefined)
          throw new Error('lone rows');
        if (variant.phone) {
          expect(lonePrimary.w, 'phone: a lone primary is narrower than the column').toBeLessThan(loneContainer.w - 40);
          expect(loneSecondary.w, 'phone: a lone secondary is narrower than the column').toBeLessThan(
            loneContainer.w - 40,
          );
        } else {
          expect(
            Math.abs(lonePrimary.right - loneContainer.right),
            'a lone primary takes the right end',
          ).toBeLessThanOrEqual(1);
          expect(
            Math.abs(loneSecondary.right - loneContainer.right),
            'a lone secondary is the same group of one, at the right end',
          ).toBeLessThanOrEqual(1);
        }
      } finally {
        await close();
      }
    });

    it(`${variant.name}: ActionRow fits its CONTAINER: side by side as one group only when both fit, else stacked full width, never clipped`, async () => {
      const { tab, close } = await open(variant, 'narrow');
      try {
        for (const width of [160, 309, 399, 400, 604]) {
          const sample = `[data-sample="w-${width}"]`;
          const [container] = await boxes(tab, sample);
          const [secondary] = await boxes(tab, `${sample} [data-b="secondary"]`);
          const [primary] = await boxes(tab, `${sample} [data-b="primary"]`);
          if (container === undefined || secondary === undefined || primary === undefined) throw new Error('boxes');
          const named = `${width}px container`;
          // The container is its own size (a phone window can still hold 604px at most as wide as the window).
          const room = container.w;
          for (const button of [secondary, primary]) {
            expect(button.x, `${named}: starts inside the container`).toBeGreaterThanOrEqual(container.x - 0.5);
            expect(button.right, `${named}: ends inside the container`).toBeLessThanOrEqual(container.right + 0.5);
            expect(button.h, `${named}: a 44 px target`).toBeGreaterThanOrEqual(43.5);
          }
          const sideBySide = room >= 396 && !variant.phone;
          if (sideBySide) {
            expect(Math.abs(primary.y - secondary.y), `${named}: one row`).toBeLessThanOrEqual(1);
            expect(Math.abs(primary.right - container.right), `${named}: group at the right end`).toBeLessThanOrEqual(
              1,
            );
            expect(Math.abs(primary.x - (secondary.right + 12)), `${named}: one group`).toBeLessThanOrEqual(1);
            expect(Math.abs(primary.w - 192), `${named}: 12rem`).toBeLessThanOrEqual(1);
          } else {
            // Too narrow for the group (or a phone): one per line, each at its own width (12rem, or the container when that is narrower).
            const own = Math.min(192, room);
            expect(
              Math.abs(primary.w - own),
              `${named}: the way on is content-sized, not full width`,
            ).toBeLessThanOrEqual(1);
            expect(
              Math.abs(secondary.w - own),
              `${named}: the way out is content-sized, not full width`,
            ).toBeLessThanOrEqual(1);
            expect(Math.abs(primary.y - secondary.y), `${named}: stacked`).toBeGreaterThan(20);
            // Tab follows the picture: the DOM order is the drawn order, so the first in the DOM is the upper one.
            const order = await tab.evaluate(
              s => [...document.querySelectorAll(`${s} button`)].map(button => button.getAttribute('data-b')),
              sample,
            );
            const upper = primary.y < secondary.y ? 'primary' : 'secondary';
            expect(order[0], `${named}: Tab reaches the upper answer first`).toBe(upper);
          }
        }
        expect(
          await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
          'nothing scrolls sideways',
        ).toBeLessThanOrEqual(0);
      } finally {
        await close();
      }
    });

    it(`${variant.name}: Q6 answers with an icon or a long label are content-sized, one line, never full width on a phone`, async () => {
      const { tab, close } = await open(variant, 'row');
      try {
        if (shotsDir !== '') {
          await mkdir(shotsDir, { recursive: true });
          await tab.screenshot({ path: join(shotsDir, `${variant.name}-row.png`), fullPage: true });
        }
        const [container] = await boxes(tab, '[data-sample="long"]');
        const found = await tab.evaluate(() =>
          [...document.querySelectorAll('[data-sample="long"] button')].map(button => {
            // The label's own text: how many distinct line tops its glyph boxes have.
            const tops = new Set<number>();
            const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
              if ((node.textContent ?? '').trim() === '') continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              for (const rect of range.getClientRects()) tops.add(Math.round(rect.top / 4));
            }
            const lines = tops.size;
            const box = button.getBoundingClientRect();
            return { label: button.textContent?.trim() ?? '', w: box.width, h: box.height, lines };
          }),
        );
        if (container === undefined) throw new Error('long sample');
        expect(found).toHaveLength(3);
        for (const button of found) {
          expect(button.lines, `${button.label} is one line`).toBe(1);
          expect(button.h, `${button.label} is a 44 px target`).toBeGreaterThanOrEqual(43.5);
          expect(button.w, `${button.label} is narrower than the column`).toBeLessThan(container.w - 40);
        }
      } finally {
        await close();
      }
    });

    it(`${variant.name}: ActionRow, Tab visits the answers in the order they are drawn (phone: the way on first; desktop: the way out first)`, async () => {
      const { tab, close } = await open(variant, 'row');
      try {
        // Focus lands on the first control of the sample, then Tab walks on; each stop must be below / right of the last.
        await tab.locator('[data-sample="two"] button').first().focus();
        const first = await tab.evaluate(() => document.activeElement?.getAttribute('data-b'));
        await tab.keyboard.press('Tab');
        const second = await tab.evaluate(() => document.activeElement?.getAttribute('data-b'));
        const [one] = await boxes(tab, `[data-sample="two"] [data-b="${first}"]`);
        const [two] = await boxes(tab, `[data-sample="two"] [data-b="${second}"]`);
        if (one === undefined || two === undefined) throw new Error('tab stops');
        expect([first, second]).toEqual(variant.phone ? ['primary', 'secondary'] : ['secondary', 'primary']);
        // The picture agrees with the keys: Tab goes down on a phone (the way on is on top) and right on a desktop.
        if (variant.phone) expect(two.y, 'phone: the second stop is lower').toBeGreaterThan(one.y);
        else expect(two.x, 'desktop: the second stop is further right').toBeGreaterThan(one.x);
      } finally {
        await close();
      }
    });

    it(`${variant.name}: ActionRow, a focused answer keeps focus on the SAME action when the window crosses the breakpoint`, async () => {
      const { tab, close } = await open(variant, 'row');
      try {
        for (const answer of ['primary', 'secondary'] as const) {
          await tab.locator(`[data-sample="two"] [data-b="${answer}"]`).focus();
          await tab.setViewportSize(variant.phone ? { width: 1_280, height: 800 } : { width: 390, height: 844 });
          // The row reorders its DOM at the breakpoint (phone: the way on first; desktop: the way out first): wait for that
          // new order, not for a width that was already nonzero before the resize.
          await tab.waitForFunction(
            expected => document.querySelector('[data-sample="two"] button')?.getAttribute('data-b') === expected,
            variant.phone ? 'secondary' : 'primary',
          );
          const after = await tab.evaluate(() => ({
            focused: document.activeElement?.getAttribute('data-b'),
            label: document.activeElement?.textContent,
          }));
          expect(after.focused, `${answer} stays focused after the resize (${after.label})`).toBe(answer);
          // Enter acts on that action, not on the one that took its slot.
          await tab.evaluate(() => {
            const w = window as unknown as { __pressed?: string[] };
            const fresh = w.__pressed === undefined;
            w.__pressed = [];
            if (!fresh) return;
            for (const button of document.querySelectorAll('[data-sample="two"] button'))
              button.addEventListener('click', () => w.__pressed?.push(button.getAttribute('data-b') ?? ''));
          });
          await tab.keyboard.press('Enter');
          expect(await tab.evaluate(() => (window as unknown as { __pressed: string[] }).__pressed)).toEqual([answer]);
          await tab.setViewportSize({ width: variant.width, height: variant.height });
        }
      } finally {
        await close();
      }
    });

    it(`${variant.name}: the recovery stack is one size, the column's full width on a phone`, async () => {
      const { tab, close } = await open(variant, 'stack');
      try {
        const [container] = await boxes(tab, '[data-sample="stack"]');
        const buttons = await boxes(tab, '[data-sample="stack"] button');
        expect(buttons).toHaveLength(3);
        if (container === undefined) throw new Error('stack');
        for (const button of buttons) {
          expect(Math.abs(button.w - (buttons[0]?.w ?? 0)), 'one width').toBeLessThanOrEqual(1);
          expect(button.h, 'a 44 px target').toBeGreaterThanOrEqual(43.5);
        }
        if (variant.phone)
          for (const button of buttons)
            expect(Math.abs(button.w - container.w), 'phone: full width').toBeLessThanOrEqual(1);
      } finally {
        await close();
      }
    });

    it(`${variant.name}: an inline action sits on the line and does not make it taller`, async () => {
      const { tab, close } = await open(variant, 'inline');
      try {
        const geometry = await tab.evaluate(() => {
          const line = document.querySelector('[data-sample="inline"]') as HTMLElement;
          const action = line.querySelector('button') as HTMLElement;
          const withAction = line.getBoundingClientRect().height;
          const lineHeight = Number.parseFloat(getComputedStyle(line).lineHeight);
          const actionHeight = action.getBoundingClientRect().height;
          action.style.display = 'none';
          const without = line.getBoundingClientRect().height;
          return { withAction, without, lineHeight, actionHeight };
        });
        expect(geometry.actionHeight, 'no taller than a text line').toBeLessThanOrEqual(geometry.lineHeight + 1);
        expect(geometry.withAction, 'the line keeps its height').toBeLessThanOrEqual(
          geometry.without + geometry.lineHeight + 1,
        );
      } finally {
        await close();
      }
    });

    for (const [scene, count] of [
      ['footer1', 1],
      ['footer2', 2],
      ['footer3', 3],
    ] as const)
      it(`${variant.name}: the step footer with ${count} button(s) ${variant.phone ? 'splits the row in equal tracks' : 'groups Back with the buttons that move on, at the right end'}`, async () => {
        const { tab, close } = await open(variant, scene);
        try {
          const buttons = await boxes(tab, '.fy-spf__footer .fy-spf__button');
          expect(buttons).toHaveLength(count);
          const [row] = await boxes(tab, '.fy-spf__actions');
          if (row === undefined) throw new Error('actions');
          if (variant.phone) {
            const inner = row.w - 32;
            const gaps = (count - 1) * 12;
            for (const button of buttons)
              expect(
                Math.abs(button.w - (inner - gaps) / count),
                `one of ${count}: an equal track`,
              ).toBeLessThanOrEqual(1.5);
          } else if (count > 1) {
            const first = buttons[0];
            const second = buttons[1];
            if (first === undefined || second === undefined) throw new Error('buttons');
            expect(
              Math.abs(second.x - first.right - 12),
              'Back is beside the buttons that move on (12px)',
            ).toBeLessThanOrEqual(1);
          }
        } finally {
          await close();
        }
      });
  }
});
