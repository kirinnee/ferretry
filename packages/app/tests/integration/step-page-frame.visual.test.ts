/**
 * r11 O2: the step page layout in a real browser over fake data (`fixtures/step-frame-scene.tsx`).
 *
 * Owner lines proved here (computed geometry, not a snapshot): "put them vertically, and show the example animation on
 * the right" (items 3, 5) and "make buttons have fixed width" (items 1, 5).
 *   1280: stacked cards share one x and width with y strictly increasing; the demo sits right of the cards (gap > 32)
 *         with its top within 8px of the first card's top; Back / Later / Next are each 136px wide and >= 44px tall; an
 *         in-body Button is >= 136px wide and 12px from its neighbour.
 *   390:  the demo is above the first card, <= 140px tall AND really drawn (nonzero box, hit-testable at its centre); the
 *         footer's three buttons are equal thirds inside the viewport; the page's own scroller does not scroll sideways.
 *   320 + 390, the ending's footer (Back + "Open this machine"): every label's text box sits inside its button's box and
 *         inside the viewport (a long label wraps inside its third).
 *   pending: a page `hidden` behind a loading cover draws no demo (the portal is gated); the demo appears when the page does.
 *
 * Set `FY_STEP_FRAME_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png` (1280 and 390, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { LOADING_FADE_MS, LOADING_MIN_MS } from '../../src/ui/loading-gate.ts';
import { NEXT_SPINNER_LOG, type NextSpinnerRun, sceneBuilder, sharedChromium } from '../support/browser/index.ts';

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
      scroller: (() => {
        const node = document.querySelector('[data-scroller]') as HTMLElement;
        return { scrollWidth: node.scrollWidth, clientWidth: node.clientWidth };
      })(),
      demoVisible: (() => {
        const node = document.querySelector('[data-step-demo]');
        if (node === null) return false;
        const r = node.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return r.width > 0 && r.height > 0 && getComputedStyle(node).display !== 'none' && node.contains(hit);
      })(),
      labels: ['[data-step-back]', '[data-step-later]', '[data-step-next]']
        .map(selector => document.querySelector(selector))
        .filter((node): node is Element => node !== null)
        .map(node => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return { button: box(node), text: box(range as unknown as Element), label: node.textContent ?? '' };
        }),
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
        // Fixed footer buttons: 136 x >= 44 (Next is the right-most).
        for (const button of m.footer) {
          near(button.w, 136, 1);
          expect(button.h).toBeGreaterThanOrEqual(44);
        }
        // C59 O8-2, the shared answer-row rule: Back, Later and Next are ONE group, each 12 apart, at the right end of the column
        // (no Back stranded on the far edge).
        near((m.footer[2]?.x ?? 0) - (m.footer[1]?.right ?? 0), 12, 1);
        near((m.footer[1]?.x ?? 0) - (m.footer[0]?.right ?? 0), 12, 1);
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
        // The demo is really there: a nonzero box that the page shows at its centre, not only "<= 140".
        expect(m.demoVisible).toBe(true);
        expect(m.demo.h).toBeGreaterThanOrEqual(40);
        expect(m.fake.w).toBeGreaterThan(0);
        expect(m.fake.h).toBeGreaterThan(0);
        // The scroller the page really scrolls in (not the document) does not scroll sideways.
        expect(m.scroller.scrollWidth).toBeLessThanOrEqual(m.scroller.clientWidth);
        await shotOf(tab, variant, 'stack');
        expect(problems).toEqual([]);
        console.info(
          `[r11-o2] ${variant.name}: scroller ${m.scroller.scrollWidth}/${m.scroller.clientWidth} demoVisible=${m.demoVisible} fake=${m.fake.w}x${m.fake.h} | demo bottom=${m.demo.bottom} h=${m.demo.h} first card y=${m.cards[0]?.y} | footer w=${m.footer.map(b => b.w).join('/')} right=${m.footer.at(-1)?.right}/${m.viewportWidth}`,
        );
      } finally {
        await close();
      }
    });
  }

  for (const [width, scheme] of [
    [320, 'light'],
    [390, 'light'],
    [390, 'dark'],
  ] as const) {
    it(`${width}-${scheme}: a long footer label ("Open this machine") stays inside its button and the viewport`, async () => {
      const variant: Viewport = { name: `${width}-${scheme}`, width, height: 800, phone: true, scheme };
      const { tab, problems, close } = await open(variant, 'long');
      try {
        const m = await measure(tab);
        expect(m.labels.map(item => item.label)).toEqual(['Back', 'Open this machine']);
        for (const { button, text, label } of m.labels) {
          expect(text.x, `${label} starts inside its button`).toBeGreaterThanOrEqual(button.x - 0.5);
          expect(text.right, `${label} ends inside its button`).toBeLessThanOrEqual(button.right + 0.5);
          expect(text.y).toBeGreaterThanOrEqual(button.y - 0.5);
          expect(text.bottom).toBeLessThanOrEqual(button.bottom + 0.5);
          expect(text.right, `${label} ends inside the viewport`).toBeLessThanOrEqual(m.viewportWidth);
          expect(button.right).toBeLessThanOrEqual(m.viewportWidth);
        }
        // The three equal columns hold: Back and Next are the same width, Next in the third column.
        near(m.labels[0]?.button.w ?? 0, m.labels[1]?.button.w ?? 0, 1);
        expect(m.scroller.scrollWidth).toBeLessThanOrEqual(m.scroller.clientWidth);
        await shotOf(tab, variant, 'long-label');
        expect(problems).toEqual([]);
        const next = m.labels[1];
        console.info(
          `[r11-o2] ${variant.name}: Next button x=${next?.button.x}..${next?.button.right} h=${next?.button.h}, label x=${next?.text.x}..${next?.text.right} h=${next?.text.h}, viewport ${m.viewportWidth}`,
        );
      } finally {
        await close();
      }
    });
  }

  for (const variant of [VARIANTS[0], VARIANTS[2]] as readonly Viewport[]) {
    it(`${variant.name}: a page hidden behind its loading cover draws no demo, and the demo appears when the page does`, async () => {
      const { tab, problems, close } = await open(variant, 'pending');
      try {
        const covered = await measure(tab);
        expect(await tab.locator('[data-flow-cover]').isVisible()).toBe(true);
        expect(await tab.locator('[data-fake-demo]').count(), 'no demo node while covered').toBe(0);
        expect(covered.demoVisible).toBe(false);
        expect(covered.demo.w).toBe(0);
        await tab.locator('[data-step-next]').click();
        await tab.waitForSelector('[data-step-demo] [data-fake-demo]');
        const ready = await measure(tab);
        expect(await tab.locator('[data-flow-cover]').count()).toBe(0);
        expect(ready.demoVisible).toBe(true);
        expect(ready.fake.w).toBeGreaterThan(0);
        expect(problems).toEqual([]);
        console.info(
          `[r11-o2] ${variant.name}: pending demo w=${covered.demo.w} visible=${covered.demoVisible} -> ready demo w=${ready.demo.w} h=${ready.demo.h} visible=${ready.demoVisible}`,
        );
      } finally {
        await close();
      }
    });
  }

  // C59 O8-4c: a step that is busy (onboarding's cover) draws the page loader in the middle of the area between the heading and the footer.
  for (const variant of VARIANTS)
    it(`${variant.name}: the busy loader sits in the vertical middle of the step's area, not at the top`, async () => {
      const { tab, close } = await open(variant, 'covered');
      try {
        await tab.waitForSelector('[data-loading="page"]');
        await tab.waitForTimeout(650); // past the 300 ms threshold and the fade
        await shotOf(tab, variant, 'busy-loader');
        const where = await tab.evaluate(() => {
          const loader = document.querySelector('[data-loading="page"]')?.getBoundingClientRect() ?? new DOMRect();
          const head = document.querySelector('.fy-spf__head')?.getBoundingClientRect() ?? new DOMRect();
          const footer = document.querySelector('.fy-spf__footer')?.getBoundingClientRect() ?? new DOMRect();
          const area = { top: head.bottom, bottom: footer.top };
          return {
            offCentre:
              Math.abs((loader.top + loader.bottom) / 2 - (area.top + area.bottom) / 2) / (area.bottom - area.top),
            scrolls:
              (document.querySelector('[data-scroller]')?.scrollHeight ?? 0) >
              (document.querySelector('[data-scroller]')?.clientHeight ?? 0) + 1,
          };
        });
        expect(where.offCentre, 'centred between the heading and the footer, not top-heavy').toBeLessThan(0.06);
        expect(where.scrolls, 'filling the area adds no scroll').toBe(false);
      } finally {
        await close();
      }
    });

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

/**
 * r11-1c C3: the footer Next's busy spinner waits the loader threshold like a page loader. On the real frame, Next is pressed and
 * stays busy for `busyMs`: at 1 ms and 100 ms (under the 300 ms threshold) the spinner is never visible; at 600 ms it appears and is
 * then held for its minimum (fade + minimum, from the code's own constants) after the answer, never a blink. Red on base: the
 * spinner was drawn at once, 15-38 ms at 1 ms answers and 200-260 ms at 100 ms.
 */
describe('r11-1c C3: the Next button spinner is gated like a page loader', () => {
  const SLACK_MS = 100;
  const sampled = async (busyMs: number, variant: Viewport): Promise<NextSpinnerRun[]> => {
    const context = await browser.newContext({
      viewport: { width: variant.width, height: variant.height },
      colorScheme: variant.scheme,
    });
    const origin = server?.url.origin ?? '';
    await context.route('**/*', async route =>
      new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
    );
    await context.addInitScript(NEXT_SPINNER_LOG);
    try {
      const tab = await context.newPage();
      tab.setDefaultTimeout(8_000);
      await tab.goto(`${origin}/?theme=studio-${variant.scheme}&scene=busy&busyMs=${busyMs}`);
      await tab.waitForSelector('[data-step-next]');
      await tab.locator('[data-step-next]').click();
      await tab.waitForTimeout(busyMs + 1_200);
      return await tab.evaluate(() => (window as unknown as { __nextSpinner: NextSpinnerRun[] }).__nextSpinner);
    } finally {
      await context.close();
    }
  };
  for (const variant of [VARIANTS[0], VARIANTS[2]] as readonly Viewport[]) {
    for (const busyMs of [1, 100])
      it(`answers ${busyMs} ms late: the spinner is never visible (${variant.name})`, async () => {
        const runs = await sampled(busyMs, variant);
        console.info(
          `C3 ${variant.name} ${busyMs} ms: ${runs.map(run => `${Math.round(run.ms)}/${Math.round(run.fullMs)} ms`).join(', ') || 'never drawn'}`,
        );
        expect(runs).toEqual([]);
      });
    it(`answers 600 ms late: it comes up after the threshold and stays for its minimum (${variant.name})`, async () => {
      const runs = await sampled(600, variant);
      console.info(
        `C3 ${variant.name} 600 ms: ${runs.map(run => `${Math.round(run.ms)}/${Math.round(run.fullMs)} ms`).join(', ') || 'never drawn'}`,
      );
      expect(runs.length, 'the spinner was drawn once').toBe(1);
      expect(runs[0]?.ms ?? 0).toBeGreaterThanOrEqual(LOADING_FADE_MS + LOADING_MIN_MS - SLACK_MS);
      expect(runs[0]?.fullMs ?? 0).toBeGreaterThanOrEqual(LOADING_MIN_MS - SLACK_MS);
    });
  }
});
