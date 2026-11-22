/**
 * C59: THE SHARED ANSWER-ROW RULES in a real browser over fake data (`fixtures/action-row-scene.tsx`), the ONE place the
 * audit's many "narrow, unequal, ragged buttons" are fixed. Computed geometry, 390 and 1280, light and dark:
 *   - `ActionRow`: a phone stacks both answers at the container's full width, the way on above; a desktop puts the secondary at
 *     the container's left edge and the primary at the right edge of ONE row, both the same size. A lone primary takes the right
 *     end on a desktop, a lone secondary stays at the left; on a phone either is the container's full width.
 *   - `fy-action-stack`: every recovery action is one size; on a phone the column's full width.
 *   - `fy-inline-action`: sits on the sentence's line without making it taller (and is no taller than a text line).
 *   - the step frame's footer on a phone: one button is the row's full width, two split it, three are thirds (it was always a
 *     narrow third), and the way back is at the LEFT end on a desktop.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
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
        const [secondary, primary] = await boxes(tab, '[data-sample="two"] button');
        expect(container && secondary && primary).toBeTruthy();
        if (container === undefined || secondary === undefined || primary === undefined) return;
        expect(Math.abs(secondary.w - primary.w), 'one width').toBeLessThanOrEqual(1);
        expect(Math.abs(secondary.h - primary.h), 'one height').toBeLessThanOrEqual(1);
        expect(primary.h, 'a 44 px target').toBeGreaterThanOrEqual(43.5);
        if (variant.phone) {
          expect(Math.abs(primary.w - container.w), 'phone: full width').toBeLessThanOrEqual(1);
          expect(primary.y, 'phone: the way on is above').toBeLessThan(secondary.y);
        } else {
          expect(Math.abs(primary.y - secondary.y), 'desktop: one row').toBeLessThanOrEqual(1);
          expect(Math.abs(secondary.x - container.x), 'secondary at the left end').toBeLessThanOrEqual(1);
          expect(Math.abs(primary.right - container.right), 'primary at the right end').toBeLessThanOrEqual(1);
        }
        const [lonePrimary] = await boxes(tab, '[data-sample="lone-primary"] button');
        const [loneContainer] = await boxes(tab, '[data-sample="lone-primary"]');
        const [loneSecondary] = await boxes(tab, '[data-sample="lone-secondary"] button');
        if (lonePrimary === undefined || loneContainer === undefined || loneSecondary === undefined)
          throw new Error('lone rows');
        if (variant.phone) {
          expect(Math.abs(lonePrimary.w - loneContainer.w), 'phone: a lone primary is full width').toBeLessThanOrEqual(
            1,
          );
          expect(
            Math.abs(loneSecondary.w - loneContainer.w),
            'phone: a lone secondary is full width',
          ).toBeLessThanOrEqual(1);
        } else {
          expect(
            Math.abs(lonePrimary.right - loneContainer.right),
            'a lone primary takes the right end',
          ).toBeLessThanOrEqual(1);
          expect(Math.abs(loneSecondary.x - loneContainer.x), 'a lone secondary stays at the left').toBeLessThanOrEqual(
            1,
          );
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
      it(`${variant.name}: the step footer with ${count} button(s) ${variant.phone ? 'splits the row in equal tracks' : 'keeps the way back at the left end'}`, async () => {
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
            expect(second.x - first.right, 'Back is away from the buttons that move on').toBeGreaterThan(40);
          }
        } finally {
          await close();
        }
      });
  }
});
