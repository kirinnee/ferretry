/**
 * r11 O2: the step page layout in a real browser over fake data (`fixtures/step-frame-scene.tsx`).
 *
 * Owner lines proved here (computed geometry, not a snapshot): "put them vertically, and show the example animation on
 * the right" (items 3, 5) and "make buttons have fixed width" (items 1, 5).
 *   1280: stacked cards share one x and width with y strictly increasing; the demo sits right of the cards (gap > 32)
 *         with its top within 8px of the first card's top; Back / Later / Next are each 136px wide and >= 44px tall; an
 *         in-body Button is >= 136px wide and 12px from its neighbour.
 *   390:  the demo is above the first card and <= 140px tall; the footer's three buttons are equal thirds inside the
 *         viewport; no horizontal scroll.
 *
 * Set `FY_STEP_FRAME_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png` (1280 and 390, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_STEP_FRAME_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-step-frame-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/step-frame-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the step frame scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

interface Viewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly phone: boolean;
  readonly scheme: 'light' | 'dark';
}
const VARIANTS: readonly Viewport[] = [
  { name: '1280-light', width: 1_280, height: 800, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 800, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 800, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 800, phone: true, scheme: 'dark' },
];

const open = async (variant: Viewport, scene: string) => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
    colorScheme: variant.scheme,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(8_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/?theme=studio-${variant.scheme}&scene=${scene}`);
  await tab.waitForSelector('[data-step-page], [data-outside]');
  return { tab, problems, close: async () => await context.close() };
};

const shotOf = async (tab: Page, variant: Viewport, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`) });
};

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly right: number;
  readonly bottom: number;
}

/** Everything the asserts need, measured in the page. */
const measure = async (tab: Page) =>
  await tab.evaluate(() => {
    const box = (node: Element | null): Box => {
      const r = node?.getBoundingClientRect() ?? new DOMRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
    };
    const cards = [...document.querySelectorAll('.fy-cc__card')].map(box);
    const footer = ['[data-step-back]', '[data-step-later]', '[data-step-next]'].map(selector =>
      box(document.querySelector(selector)),
    );
    const bodyButtons = [...document.querySelectorAll('[data-in-body-buttons] .kt-btn')].map(box);
    const cardTitles = [...document.querySelectorAll('.fy-cc__card')].map(card => {
      const line = card.querySelector('.fy-cc__line');
      return line === null
        ? 0
        : line.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(line).lineHeight);
    });
    return {
      cards,
      cardTitles,
      demo: box(document.querySelector('[data-step-demo]')),
      fake: box(document.querySelector('[data-fake-demo]')),
      footer,
      bodyButtons,
      viewportWidth: window.innerWidth,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      demoInFrame: document.querySelector('[data-step-demo] [data-fake-demo]') !== null,
      stickyTop: getComputedStyle(document.querySelector('[data-step-demo]') as Element).position,
    };
  });

const near = (actual: number, expected: number, tolerance: number): void => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
};

describe('r11 O2: step page layout, stacked choices left and demo right', () => {
  for (const variant of VARIANTS.filter(v => !v.phone)) {
    it(`${variant.name}: cards stack in one column, demo on the right, footer buttons exactly 136px`, async () => {
      const { tab, problems, close } = await open(variant, 'stack');
      try {
        const m = await measure(tab);
        expect(m.demoInFrame).toBe(true);
        expect(m.cards).toHaveLength(3);
        // Stacked: same x and width, y strictly increasing.
        for (const card of m.cards) {
          near(card.x, m.cards[0]?.x ?? 0, 0.5);
          near(card.w, m.cards[0]?.w ?? 0, 0.5);
          expect(card.h).toBeGreaterThanOrEqual(64);
          expect(card.h).toBeLessThanOrEqual(80);
        }
        for (const [index, card] of m.cards.entries())
          if (index > 0) expect(card.y).toBeGreaterThan(m.cards[index - 1]?.y ?? 0);
        // Column width: 44% of the body, 360..480.
        expect(m.cards[0]?.w ?? 0).toBeGreaterThanOrEqual(360);
        expect(m.cards[0]?.w ?? 0).toBeLessThanOrEqual(480);
        // The long line clamps to 2.
        for (const lines of m.cardTitles) expect(lines).toBeLessThanOrEqual(2.01);
        // Demo to the right with a real gutter, top-aligned with the first card.
        const cardsRight = Math.max(...m.cards.map(card => card.right));
        expect(m.demo.x).toBeGreaterThan(cardsRight + 32);
        expect(Math.abs(m.demo.y - (m.cards[0]?.y ?? 0))).toBeLessThanOrEqual(8);
        expect(m.demo.w).toBeGreaterThanOrEqual(320);
        expect(m.stickyTop).toBe('sticky');
        // Fixed footer buttons: 136 x >= 44, 12 apart, right-aligned (Next is the right-most).
        for (const button of m.footer) {
          near(button.w, 136, 1);
          expect(button.h).toBeGreaterThanOrEqual(44);
        }
        near((m.footer[1]?.x ?? 0) - (m.footer[0]?.right ?? 0), 12, 1);
        near((m.footer[2]?.x ?? 0) - (m.footer[1]?.right ?? 0), 12, 1);
        // An in-body Button is fixed too and 12px from its neighbour.
        for (const button of m.bodyButtons) {
          expect(button.w).toBeGreaterThanOrEqual(135);
          expect(button.h).toBeGreaterThanOrEqual(44);
        }
        near((m.bodyButtons[1]?.x ?? 0) - (m.bodyButtons[0]?.right ?? 0), 12, 1);
        expect(m.overflowX).toBe(false);
        await shotOf(tab, variant, 'stack');
        expect(problems).toEqual([]);
        console.info(
          `[r11-o2] ${variant.name}: card x=${m.cards[0]?.x} w=${m.cards[0]?.w} h=${m.cards.map(c => c.h).join('/')} | demo x=${m.demo.x} y=${m.demo.y} w=${m.demo.w} (cards right ${cardsRight}) | footer w=${m.footer.map(b => b.w).join('/')} h=${m.footer.map(b => b.h).join('/')} | body btn w=${m.bodyButtons.map(b => b.w).join('/')}`,
        );
      } finally {
        await close();
      }
    });
  }

  for (const variant of VARIANTS.filter(v => v.phone)) {
    it(`${variant.name}: demo above the first card and <= 140px, footer in equal thirds, no horizontal scroll`, async () => {
      const { tab, problems, close } = await open(variant, 'stack');
      try {
        const m = await measure(tab);
        expect(m.demo.bottom).toBeLessThanOrEqual((m.cards[0]?.y ?? 0) + 0.5);
        expect(m.demo.h).toBeLessThanOrEqual(140);
        for (const card of m.cards) near(card.x, m.cards[0]?.x ?? 0, 0.5);
        for (const button of m.footer) {
          near(button.w, m.footer[0]?.w ?? 0, 1);
          expect(button.x).toBeGreaterThanOrEqual(0);
          expect(button.right).toBeLessThanOrEqual(m.viewportWidth);
          expect(button.h).toBeGreaterThanOrEqual(44);
        }
        expect(m.overflowX).toBe(false);
        await shotOf(tab, variant, 'stack');
        expect(problems).toEqual([]);
        console.info(
          `[r11-o2] ${variant.name}: demo bottom=${m.demo.bottom} h=${m.demo.h} first card y=${m.cards[0]?.y} | footer w=${m.footer.map(b => b.w).join('/')} right=${m.footer.at(-1)?.right}/${m.viewportWidth}`,
        );
      } finally {
        await close();
      }
    });
  }

  it('should keep the old `demo` prop working (drawn in the same right column)', async () => {
    const { tab, close } = await open(VARIANTS[0] as Viewport, 'prop');
    try {
      const m = await measure(tab);
      expect(m.demoInFrame).toBe(true);
      expect(m.demo.x).toBeGreaterThan(Math.max(...m.cards.map(card => card.right)) + 32);
    } finally {
      await close();
    }
  });

  it('should leave the body alone when a page has no demo (no empty right column drawn)', async () => {
    const { tab, close } = await open(VARIANTS[0] as Viewport, 'none');
    try {
      const m = await measure(tab);
      expect(m.demo.w).toBe(0);
      expect(m.cards).toHaveLength(3);
    } finally {
      await close();
    }
  });

  it('should draw a StepDemo inline outside a frame', async () => {
    const { tab, close } = await open(VARIANTS[0] as Viewport, 'inline');
    try {
      expect(await tab.locator('[data-outside] [data-fake-demo]').count()).toBe(1);
    } finally {
      await close();
    }
  });
});
