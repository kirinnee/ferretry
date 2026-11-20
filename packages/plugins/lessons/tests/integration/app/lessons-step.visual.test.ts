/**
 * THE FIRST-RUN LESSONS PAGE (r11 O8), in a real browser over a fake daemon (`fixtures/lessons-step-scene.tsx`), inside the
 * real step frame. These asserts are the proof of the owner's lines (11): "this page is really bad … no bun example",
 * and items 3 and 5 ("put them vertically, show the example animation on the right, reduce the description").
 *
 *   1280: the two cards are stacked (same x and width, y increasing); the demo is in `[data-step-demo]`, right of the cards
 *         (gap > 32px) and top-aligned with the first card (within 8px); the page text has no "bun" and is <= 160
 *         characters; the page has no button of its own; choosing a card writes NOTHING, and Next writes exactly once.
 *   390:  the demo is above the first card; no sideways scroll; footer buttons inside the viewport.
 *   both: nothing is clipped; one tab stop; at rest the demo's rule is fully shown (opacity 1); with motion off it never animates.
 *
 * Set `FY_LESSONS_STEP_SHOTS_DIR` to keep a screenshot of each case (light and dark, 1280 and 390).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

type Browser = Awaited<ReturnType<typeof sharedChromium>>;

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_LESSONS_STEP_SHOTS_DIR ?? '';

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 800, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-lessons-step-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/lessons-step-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the lessons-step scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  await tab.waitForSelector('[data-choice="on"]');
  return { context, tab };
};

describe('r11 O8: the first-run Lessons page', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const) {
      it(`stacks the cards with the demo on the right, no bun, short words (${viewport.name}, ${mode})`, async () => {
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
            demoHasScene: document.querySelector('[data-step-demo] [data-lessons-demo]') !== null,
            bodyText: body.innerText,
            bodyButtons: body.querySelectorAll('button').length,
            overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            footer: ['[data-step-back]', '[data-step-later]', '[data-step-next]'].map(s =>
              box(document.querySelector(s)),
            ),
            viewport: window.innerWidth,
            clipped: [
              ...document.querySelectorAll(
                '.fy-cc__title, .fy-cc__line, .fy-lessons-step-line, .fy-lsd__said, .fy-lsd__rule',
              ),
            ]
              .filter(node => node.scrollWidth > node.clientWidth)
              .map(node => node.textContent),
            checked: document.querySelectorAll('input[type="radio"]:checked').length,
            tabStops: document.querySelectorAll('input[type="radio"][tabindex="0"]').length,
          };
        });
        expect(m.cards).toHaveLength(2);
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
          expect(m.demo.x).toBeGreaterThan(cardsRight + 32);
          expect(Math.abs(m.demo.y - (m.cards[0]?.y ?? 0))).toBeLessThanOrEqual(8);
        }
        // The owner's words: no bun, short, nothing to press on the page itself.
        expect(m.bodyText.toLowerCase()).not.toContain('bun');
        expect(m.bodyText.length).toBeLessThanOrEqual(160);
        expect(m.bodyButtons).toBe(0);
        expect(m.clipped).toEqual([]);
        expect(m.checked).toBe(0);
        expect(m.tabStops).toBe(1);
        await tab.waitForTimeout(1_300);
        // The settled scene fits inside the demo column: no chip is cut by its edges.
        const cut = await tab.evaluate(() => {
          const demo = (document.querySelector('[data-step-demo]') as HTMLElement).getBoundingClientRect();
          return [
            ...document.querySelectorAll(
              '[data-step-demo] .fy-lsd, [data-step-demo] .fy-lsd__said, [data-step-demo] .fy-lsd__shelf',
            ),
          ].filter(node => {
            const r = node.getBoundingClientRect();
            return (
              r.top < demo.top - 0.5 ||
              r.bottom > demo.bottom + 0.5 ||
              r.left < demo.left - 0.5 ||
              r.right > demo.right + 0.5
            );
          }).length;
        });
        expect(cut).toBe(0);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `after-page-${viewport.name}-${mode}.png`) });
        await context.close();
      }, 60_000);

      it(`a click writes nothing and Next writes once, the demo follows the card (${viewport.name}, ${mode})`, async () => {
        const { context, tab } = await open(viewport, mode);
        await tab.locator('[data-choice="off"]').click();
        await tab.waitForSelector('[data-choice="off"][data-selected="true"]');
        // The picture now shows nothing filed; the card click alone has written nothing.
        expect(await tab.locator('[data-step-demo] [data-lessons-demo][data-kept="false"]').count()).toBe(1);
        expect(await tab.locator('[data-lessons-rule]').count()).toBe(0);
        expect(await tab.evaluate(() => window.__patches)).toEqual([]);
        await tab.waitForTimeout(700);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `after-off-${viewport.name}-${mode}.png`) });
        await tab.locator('[data-choice="on"]').click();
        await tab.waitForSelector('[data-choice="on"][data-selected="true"]');
        await tab.waitForTimeout(1_200);
        // After the scene played, the rule is fully shown (nothing left at opacity 0).
        expect(await tab.locator('[data-lessons-rule]').evaluate(node => getComputedStyle(node).opacity)).toBe('1');
        expect(await tab.evaluate(() => window.__patches)).toEqual([]);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `after-on-${viewport.name}-${mode}.png`) });
        await tab.locator('[data-step-next]').click();
        await tab.waitForFunction(() => window.__patches.length > 0);
        await tab.waitForTimeout(200);
        expect(await tab.evaluate(() => window.__patches)).toEqual([{ passiveDefault: true }]);
        await context.close();
      }, 60_000);
    }

  it('plays no picture animation when the person turned motion off', async () => {
    const { context, tab } = await open(VIEWPORTS[0], 'light');
    await tab.evaluate(() => document.documentElement.setAttribute('data-motion', 'reduced'));
    await tab.locator('[data-choice="on"]').click();
    await tab.waitForSelector('[data-choice="on"][data-selected="true"]');
    const names = await tab
      .locator('.fy-lsd__said, .fy-lsd__rule, .fy-lsd__empty')
      .evaluateAll(nodes => nodes.map(node => getComputedStyle(node).animationName));
    expect(new Set(names)).toEqual(new Set(['none']));
    await context.close();
  }, 60_000);
});
