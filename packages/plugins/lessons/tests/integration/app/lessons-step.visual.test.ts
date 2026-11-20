/**
 * THE FIRST-RUN LESSONS PAGE, in a real browser, over a fake daemon (`fixtures/lessons-step-scene.tsx`): two cards that are
 * never full width on a desktop and stack on a phone, the same height, nothing cut short, no sideways scroll, one tab stop,
 * and the picture in each card shows at rest and plays once when its card is chosen.
 *
 * Set `FY_LESSONS_STEP_SHOTS_DIR` to keep a screenshot of each case (light and dark, 1280 and 390, plus today's step body as
 * the "before").
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

const open = async (view: string, viewport: (typeof VIEWPORTS)[number], mode: 'light' | 'dark') => {
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
  await tab.goto(`${origin}/?view=${view}&theme=studio-${mode}`);
  await tab.waitForSelector('[data-scene="ready"]');
  return { context, tab };
};

describe('the first-run Lessons page', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const) {
      it(`draws two cards of one height, cut nothing short and never scroll sideways (${viewport.name}, ${mode})`, async () => {
        const { context, tab } = await open('page', viewport, mode);
        await tab.waitForSelector('[data-choice="on"]');
        const boxes = await tab.locator('[data-choice]').evaluateAll(nodes =>
          nodes.map(node => {
            const box = node.getBoundingClientRect();
            return { height: Math.round(box.height), width: Math.round(box.width), top: Math.round(box.top) };
          }),
        );
        expect(boxes.length).toBe(2);
        expect(boxes[0]?.height).toBe(boxes[1]?.height as number);
        if (viewport.phone) expect(boxes[0]?.top).not.toBe(boxes[1]?.top);
        else {
          // Side by side, each at most 320 px: never the full width of the page.
          expect(boxes[0]?.top).toBe(boxes[1]?.top as number);
          for (const box of boxes) expect(box.width).toBeLessThanOrEqual(320);
        }
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        if (!viewport.phone) {
          // The line above the cards is no wider than the cards, and a clear step (>= 18 px) sits between them.
          const geometry = await tab.evaluate(() => {
            const line = document.querySelector('.fy-lessons-step-line')?.getBoundingClientRect();
            const cards = [...document.querySelectorAll('[data-choice]')].map(node => node.getBoundingClientRect());
            return {
              lineRight: line?.right ?? 0,
              lineBottom: line?.bottom ?? 0,
              cardsRight: Math.max(...cards.map(box => box.right)),
              cardsTop: cards[0]?.top ?? 0,
            };
          });
          expect(geometry.lineRight).toBeLessThanOrEqual(geometry.cardsRight + 1);
          expect(geometry.cardsTop - geometry.lineBottom).toBeGreaterThanOrEqual(18);
        }
        const clipped = await tab
          .locator('.fy-lsd__said, .fy-lsd__rule, .fy-cc__title, .fy-cc__line')
          .evaluateAll(nodes =>
            nodes.filter(node => node.scrollWidth > node.clientWidth).map(node => node.textContent),
          );
        expect(clipped).toEqual([]);
        // One tab stop for the pair, and neither card is chosen on arrival.
        expect(await tab.locator('input[type="radio"]:checked').count()).toBe(0);
        expect(await tab.locator('input[type="radio"][tabindex="0"]').count()).toBe(1);
        if (shotsDir !== '')
          await tab.screenshot({ path: join(shotsDir, `after-page-${viewport.name}-${mode}.png`), fullPage: true });
        await context.close();
      }, 60_000);

      it(`shows the chosen card, with its picture resting on the finished scene (${viewport.name}, ${mode})`, async () => {
        const { context, tab } = await open('page', viewport, mode);
        await tab.waitForSelector('[data-choice="on"]');
        await tab.locator('[data-choice="on"]').click();
        await tab.waitForSelector('[data-choice="on"][data-selected="true"]');
        if (shotsDir !== '')
          await tab.screenshot({
            path: join(shotsDir, `after-chosen-mid-${viewport.name}-${mode}.png`),
            fullPage: true,
          });
        // After the scene has played, every chip is fully shown (nothing is left at opacity 0).
        await tab.waitForTimeout(900);
        const opacities = await tab
          .locator('.fy-lsd__said, .fy-lsd__arrow, .fy-lsd__rule')
          .evaluateAll(nodes => nodes.map(node => getComputedStyle(node).opacity));
        expect(new Set(opacities)).toEqual(new Set(['1']));
        expect(await tab.locator('[data-lessons-now]').count()).toBe(0);
        if (shotsDir !== '')
          await tab.screenshot({ path: join(shotsDir, `after-chosen-${viewport.name}-${mode}.png`), fullPage: true });
        await context.close();
      }, 60_000);

      it(`draws today's step body for the before shot (${viewport.name}, ${mode})`, async () => {
        if (shotsDir === '') return;
        const { context, tab } = await open('before', viewport, mode);
        await tab.waitForSelector('[data-lessons-settings]');
        await tab.waitForTimeout(300);
        await tab.screenshot({ path: join(shotsDir, `before-${viewport.name}-${mode}.png`), fullPage: true });
        await context.close();
      }, 60_000);
    }

  it('plays no picture animation when the person turned motion off', async () => {
    const { context, tab } = await open('page', VIEWPORTS[0], 'light');
    await tab.waitForSelector('[data-choice="on"]');
    await tab.evaluate(() => document.documentElement.setAttribute('data-motion', 'reduced'));
    await tab.locator('[data-choice="on"]').click();
    await tab.waitForSelector('[data-choice="on"][data-selected="true"]');
    const names = await tab
      .locator('.fy-lsd__said, .fy-lsd__arrow, .fy-lsd__rule')
      .evaluateAll(nodes => nodes.map(node => getComputedStyle(node).animationName));
    expect(new Set(names)).toEqual(new Set(['none']));
    await context.close();
  }, 60_000);
});
