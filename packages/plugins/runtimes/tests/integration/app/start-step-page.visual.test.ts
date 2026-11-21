/**
 * THE FIRST-RUN "START FROM" PAGE (r11 O14), in a real browser over a fake machine (`fixtures/start-step-scene.tsx`), inside
 * the real step frame. These asserts are the proof of the owner's items 3 and 5 on this page: "put them vertically, show
 * the example animation on the right, reduce the description" and "make buttons have fixed width".
 *
 *   1280: the two cards are stacked (same x and width, y increasing); the demo is in `[data-step-demo]`, right of the cards
 *         (gap > 32px) and top-aligned with the first card (within 8px); the page text is <= 160 characters; the page has
 *         no button of its own (the footer's Back / Later / Next are 136px wide); choosing a card writes nothing, and the
 *         REAL setup flow's Next records the step done exactly once and writes no setting (the copy itself is the Copy
 *         panel's own reviewed change).
 *   both choices: the whole body PLUS the portaled demo is <= 160 characters (Fresh and Copy with the Copy panel open).
 *   390:  the demo is above the first card; no sideways scroll; footer buttons inside the viewport.
 *   both: nothing is clipped; one tab stop; the demo follows the chosen card; with motion off it never animates.
 *
 * Set `FY_START_STEP_SHOTS_DIR` to keep a screenshot of each case (light and dark, 1280 and 390).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

type Browser = Awaited<ReturnType<typeof sharedChromium>>;

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_START_STEP_SHOTS_DIR ?? '';

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 800, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-start-step-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/start-step-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the start-step scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const open = async (viewport: (typeof VIEWPORTS)[number], mode: 'light' | 'dark') => {
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
  await tab.goto(`${origin}/?view=page&theme=studio-${mode}`);
  await tab.waitForSelector('[data-scene="ready"]');
  await tab.waitForSelector('[data-choice="clone"]');
  return { context, tab };
};

/** Names of the demo's parts that stick out of the demo column, or are drawn over a sibling part. */
const sticksOut = (tab: Awaited<ReturnType<typeof open>>['tab']) =>
  tab.evaluate(() => {
    const demo = (document.querySelector('[data-step-demo]') as HTMLElement).getBoundingClientRect();
    const parts = [
      ...document.querySelectorAll(
        '[data-step-demo] .fy-ssd__machine, [data-step-demo] .fy-ssd__arrow, [data-step-demo] .fy-ssd__row',
      ),
    ];
    const rects = parts.map(node => ({ name: String(node.getAttribute('class')), r: node.getBoundingClientRect() }));
    const out = rects
      .filter(
        ({ r }) =>
          r.top < demo.top - 0.5 ||
          r.bottom > demo.bottom + 0.5 ||
          r.left < demo.left - 0.5 ||
          r.right > demo.right + 0.5,
      )
      .map(({ name, r }) => `${name} out: ${String(r.left)}-${String(r.right)} x ${String(r.top)}-${String(r.bottom)}`);
    const machines = rects.filter(({ name }) => name.includes('fy-ssd__machine'));
    const arrow = rects.find(({ name }) => name.includes('fy-ssd__arrow'));
    // The two machines and the arrow between them never overlap.
    const overlap: string[] = [];
    for (let at = 0; at + 1 < machines.length; at += 1)
      if ((machines[at]?.r.right ?? 0) > (machines[at + 1]?.r.left ?? 0) + 0.5) overlap.push('machines overlap');
    if (arrow !== undefined && machines.length === 2) {
      if (arrow.r.left < (machines[0]?.r.right ?? 0) - 0.5 || arrow.r.right > (machines[1]?.r.left ?? 0) + 0.5)
        overlap.push('the arrow is not between the machines');
    }
    return [...out, ...overlap];
  });

/** The route keys of every call the page made that is not a read: a write would show here. */
const writes = (tab: Awaited<ReturnType<typeof open>>['tab']) =>
  tab.evaluate(() => window.__calls.filter(route => !route.startsWith('GET ')));

describe('r11 O14: the first-run Start from page', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const) {
      it(`stacks the cards with the demo on the right, short words, nothing to press (${viewport.name}, ${mode})`, async () => {
        const { context, tab } = await open(viewport, mode);
        const m = await tab.evaluate(() => {
          const box = (node: Element | null) => {
            const r = node?.getBoundingClientRect() ?? new DOMRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
          };
          const body = document.querySelector('.fy-spf__body') as HTMLElement;
          return {
            cards: [...document.querySelectorAll('[data-choice]')].map(box),
            demo: box(document.querySelector('[data-step-demo]')),
            demoHasScene: document.querySelector('[data-step-demo] [data-start-demo]') !== null,
            bodyText: body.innerText,
            pageText:
              `${body.innerText}\n${(document.querySelector('[data-step-demo]') as HTMLElement).innerText}`.trim(),
            bodyButtons: body.querySelectorAll('button').length,
            overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            // The first page of the flow has no Back: the footer is whichever of the three the flow draws.
            footer: ['[data-step-back]', '[data-step-later]', '[data-step-next]']
              .map(s => document.querySelector(s))
              .filter((node): node is Element => node !== null)
              .map(box),
            viewport: window.innerWidth,
            clipped: [...document.querySelectorAll('.fy-cc__title, .fy-cc__line')]
              .filter(node => node.scrollWidth > node.clientWidth)
              .map(node => node.textContent),
            tabStops: document.querySelectorAll('input[type="radio"][tabindex="0"]').length,
          };
        });
        expect(m.cards).toHaveLength(2);
        expect(m.footer.length).toBeGreaterThanOrEqual(2);
        expect(m.demoHasScene).toBe(true);
        // Stacked: one x and width, y strictly increasing.
        expect(Math.abs((m.cards[0]?.x ?? 0) - (m.cards[1]?.x ?? 1))).toBeLessThan(0.5);
        expect(Math.abs((m.cards[0]?.w ?? 0) - (m.cards[1]?.w ?? 1))).toBeLessThan(0.5);
        expect(m.cards[1]?.y ?? 0).toBeGreaterThan(m.cards[0]?.bottom ?? 0);
        if (viewport.phone) {
          // The demo sits above the first card, and nothing scrolls sideways.
          expect(m.demo.bottom).toBeLessThanOrEqual((m.cards[0]?.y ?? 0) + 1);
          expect(m.demo.h).toBeLessThanOrEqual(140);
          expect(m.overflowX).toBe(false);
          for (const button of m.footer) {
            expect(button.x).toBeGreaterThanOrEqual(0);
            expect(button.right).toBeLessThanOrEqual(m.viewport);
          }
        } else {
          const cardsRight = Math.max(...m.cards.map(card => card.right));
          // The frame's column gap is 32px; sub-pixel card widths leave it a hair under.
          expect(m.demo.x).toBeGreaterThanOrEqual(cardsRight + 31);
          expect(Math.abs(m.demo.y - (m.cards[0]?.y ?? 0))).toBeLessThanOrEqual(8);
          for (const button of m.footer) expect(Math.abs(button.w - 136)).toBeLessThanOrEqual(1);
        }
        // The owner's words: short, nothing to press on the page itself.
        console.log(`O14 fresh ${viewport.name} ${mode}: ${String(m.pageText.length)} chars`);
        expect(m.pageText.length).toBeLessThanOrEqual(160);
        expect(m.bodyButtons).toBe(0);
        expect(m.clipped).toEqual([]);
        expect(m.tabStops).toBe(1);
        await tab.waitForTimeout(900);
        // The settled scene fits inside the demo column: nothing is cut by its edges.
        const cut = await tab.evaluate(() => {
          const demo = (document.querySelector('[data-step-demo]') as HTMLElement).getBoundingClientRect();
          return [...document.querySelectorAll('[data-step-demo] *')]
            .map(node => ({ node, r: node.getBoundingClientRect() }))
            .filter(
              ({ r }) =>
                r.width > 0 &&
                (r.top < demo.top - 0.5 ||
                  r.bottom > demo.bottom + 0.5 ||
                  r.left < demo.left - 0.5 ||
                  r.right > demo.right + 0.5),
            )
            .map(
              ({ node, r }) =>
                `${node.className} ${String(r.top)}-${String(r.bottom)} in ${String(demo.top)}-${String(demo.bottom)}`,
            );
        });
        expect(cut).toEqual([]);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `after-fresh-${viewport.name}-${mode}.png`) });
        await context.close();
      }, 60_000);

      it(`a card click writes nothing and Next records the step once; the demo follows the card; the Copy panel opens below (${viewport.name}, ${mode})`, async () => {
        const { context, tab } = await open(viewport, mode);
        expect(await tab.locator('[data-step-demo] [data-start-demo][data-start-mode="fresh"]').count()).toBe(1);
        await tab.locator('[data-choice="clone"]').click();
        await tab.waitForSelector('[data-choice="clone"][data-selected="true"]');
        expect(await tab.locator('[data-step-demo] [data-start-demo][data-start-mode="clone"]').count()).toBe(1);
        // It is an ANIMATION, not a still: the copy scene's rows are crossing right after the pick.
        const playing = await tab.evaluate(
          () => (document.querySelector('[data-step-demo]') as HTMLElement).getAnimations({ subtree: true }).length,
        );
        expect(playing).toBeGreaterThanOrEqual(3);
        // The Copy flow is the page's own second half: it sits BELOW the cards, never beside them.
        await tab.waitForSelector('[data-copy-no-sources], [data-copy-source]');
        // The Copy choice reads as short as the Fresh one: the cards, the Copy panel's source stage and the demo together.
        const copyText = await tab.evaluate(() =>
          `${(document.querySelector('.fy-spf__body') as HTMLElement).innerText}\n${(document.querySelector('[data-step-demo]') as HTMLElement).innerText}`.trim(),
        );
        console.log(`O14 copy ${viewport.name} ${mode}: ${String(copyText.length)} chars`);
        expect(copyText.length).toBeLessThanOrEqual(160);
        const order = await tab.evaluate(() => {
          const cards = document.querySelector('[data-choice-cards]')?.getBoundingClientRect();
          const copy = document.querySelector('[data-copy-settings], [data-copy-no-sources]')?.getBoundingClientRect();
          return { cardsBottom: cards?.bottom ?? 0, copyTop: copy?.top ?? 0 };
        });
        expect(order.copyTop).toBeGreaterThanOrEqual(order.cardsBottom - 1);
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        // (The flow's living background never stops moving, so only the demo's own animations are waited for.)
        await tab.evaluate(() =>
          Promise.all(
            (document.querySelector('[data-step-demo]') as HTMLElement)
              .getAnimations({ subtree: true })
              .map(animation => animation.finished),
          ),
        );
        // The settled copy scene: both machines and the arrow between them sit inside the column, none over another.
        expect(await sticksOut(tab)).toEqual([]);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `after-copy-${viewport.name}-${mode}.png`) });
        await tab.locator('[data-choice="fresh"]').click();
        await tab.waitForSelector('[data-choice="fresh"][data-selected="true"]');
        // Choosing wrote nothing at all, and nothing has recorded the step yet.
        expect(await writes(tab)).toEqual([]);
        // The REAL Next (the setup flow's own): it records the step done exactly once and writes no setting.
        await tab.locator('[data-step-next]').click();
        await tab.waitForSelector('[data-flow-page="runtimes.start"]', { state: 'detached' });
        await tab.waitForTimeout(300);
        expect(await tab.evaluate(() => window.__answers)).toEqual(['runtimes.start=done']);
        expect(await writes(tab)).toEqual(['POST /v1/onboarding/steps/:plugin/:stepId']);
        await context.close();
      }, 60_000);
    }

  it('plays no picture animation when the person turned motion off', async () => {
    const { context, tab } = await open(VIEWPORTS[0], 'light');
    await tab.evaluate(() => document.documentElement.setAttribute('data-motion', 'reduced'));
    await tab.locator('[data-choice="clone"]').click();
    await tab.waitForSelector('[data-choice="clone"][data-selected="true"]');
    const names = await tab
      .locator('[data-start-demo], [data-start-demo] *')
      .evaluateAll(nodes => nodes.map(node => getComputedStyle(node).animationName));
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names)).toEqual(new Set(['none']));
    await context.close();
  }, 60_000);
});
