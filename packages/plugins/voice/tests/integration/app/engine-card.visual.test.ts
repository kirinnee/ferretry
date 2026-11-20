/**
 * THE ENGINE CARDS, in a real browser, over fixed fake engines (`fixtures/engine-card-scene.tsx`): every card is the same
 * 186 px tall whatever it says, two or three sit in a row on a desktop and one per row on a phone, nothing is wider than
 * the screen, the radio group has one tab stop, and the small buttons are a full 44 px to press.
 *
 * Set `FY_ENGINE_CARD_SHOTS_DIR` to keep a screenshot of each case (light and dark, 1280 and 390).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

type Browser = Awaited<ReturnType<typeof sharedChromium>>;

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_ENGINE_CARD_SHOTS_DIR ?? '';

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-engine-card-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/engine-card-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the engine-card scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const open = async (
  view: string,
  viewport: (typeof VIEWPORTS)[number],
  mode: 'light' | 'dark',
  // A phone-emulated tab paints only its first screen, so a whole-catalog shot is taken in a plain 390-wide window as tall as the list.
  height: number = viewport.height,
) => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height },
    colorScheme: mode,
    deviceScaleFactor: viewport.phone ? 2 : 1,
    ...(viewport.phone ? { isMobile: height === viewport.height, hasTouch: true } : {}),
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

/** A full-page shot of a phone-emulated tab clips to the first screen; growing the viewport to the page keeps all of it. */
const shoot = async (tab: Awaited<ReturnType<typeof open>>['tab'], path: string): Promise<void> => {
  await tab.mouse.move(0, 0);
  await tab.screenshot({ path, fullPage: true });
};

describe('the engine cards', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const) {
      it(`keeps every card 186 px tall, in rows of up to three, never wider than the screen (${viewport.name}, ${mode})`, async () => {
        const { context, tab } = await open('short', viewport, mode);
        await tab.waitForSelector('.fy-engine-card');
        const boxes = await tab.locator('.fy-engine-card').evaluateAll(nodes =>
          nodes.map(node => {
            const box = node.getBoundingClientRect();
            return {
              height: Math.round(box.height),
              left: Math.round(box.left),
              top: Math.round(box.top),
              right: box.right,
            };
          }),
        );
        expect(boxes.length).toBe(5);
        for (const box of boxes) expect(box.height).toBe(186);
        const firstRow = boxes.filter(box => box.top === boxes[0]?.top).length;
        if (viewport.phone) expect(firstRow).toBe(1);
        else {
          expect(firstRow).toBeGreaterThanOrEqual(2);
          expect(firstRow).toBeLessThanOrEqual(3);
        }
        expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        // No bar label or value is cut short with an ellipsis.
        const clipped = await tab
          .locator('[data-option-bar] > span:not([data-option-bar-track])')
          .evaluateAll(nodes =>
            nodes.filter(node => node.scrollWidth > node.clientWidth).map(node => node.textContent),
          );
        expect(clipped).toEqual([]);
        // One tab stop for the whole group: the checked radio, and no other radio takes a Tab.
        expect(await tab.locator('input[type="radio"]:checked').count()).toBe(1);
        // Install and Size say the same number on every card that offers an install (the fake sizes carry the runtime too).
        const disagree = await tab.locator('.fy-engine-card').evaluateAll(nodes =>
          nodes.flatMap(node => {
            const install = /\(([^)]+)\)/u.exec(node.querySelector('[data-state="idle"]')?.textContent ?? '')?.[1];
            const size = node.querySelector('[data-option-bar="size"] [data-option-bar-text]')?.textContent;
            return install !== undefined && install !== size
              ? [`${(node as HTMLElement).dataset.engine}: ${install} vs ${size}`]
              : [];
          }),
        );
        expect(disagree).toEqual([]);
        // The install button is a full 44 px tall (the box itself, not a hit area around a small one).
        const first = 'parakeet-tdt-110m';
        const hit = await tab.locator(`.fy-engine-card[data-engine="${first}"] .fy-engine-mini`).evaluate(node => {
          const after = getComputedStyle(node, '::after');
          return {
            top: parseFloat(after.top),
            bottom: parseFloat(after.bottom),
            height: node.getBoundingClientRect().height,
          };
        });
        expect(hit.height).toBeGreaterThanOrEqual(43.5);
        // No card clips its own text: the card hides overflow, so a card whose content is taller than it shows a scroll height past it.
        const cut = await tab
          .locator('.fy-engine-card')
          .evaluateAll(nodes =>
            nodes
              .filter(node => node.scrollHeight > node.clientHeight)
              .map(node => (node as HTMLElement).dataset.engine),
          );
        expect(cut).toEqual([]);
        if (shotsDir !== '') await shoot(tab, join(shotsDir, `after-short-${viewport.name}-${mode}.png`));
        await context.close();
      }, 60_000);

      it(`holds the height with every engine open and with one downloading (${viewport.name}, ${mode})`, async () => {
        for (const view of ['all', 'downloading'] as const) {
          const { context, tab } = await open(view, viewport, mode, viewport.phone ? 2_400 : viewport.height);
          await tab.waitForSelector('.fy-engine-card');
          if (view === 'all') await tab.getByRole('button', { name: 'Show every engine' }).click();
          if (view === 'downloading') await tab.waitForSelector('[role="progressbar"]');
          const heights = await tab
            .locator('.fy-engine-card')
            .evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().height)));
          expect(new Set(heights)).toEqual(new Set([186]));
          if (view === 'all') expect(heights.length).toBe(10);
          if (shotsDir !== '') await shoot(tab, join(shotsDir, `after-${view}-${viewport.name}-${mode}.png`));
          await context.close();
        }
      }, 60_000);
    }

  it('opens the long text in place without changing the card height', async () => {
    const { context, tab } = await open('short', VIEWPORTS[0], 'light');
    await tab.waitForSelector('.fy-engine-card');
    const card = tab.locator('.fy-engine-card[data-engine="parakeet-tdt-110m"]');
    await card.getByRole('button', { name: 'About Parakeet 110M' }).click();
    expect(await card.locator('.fy-engine-details').count()).toBe(1);
    expect(Math.round((await card.boundingBox())?.height ?? 0)).toBe(186);
    await tab.keyboard.press('Escape');
    expect(await card.locator('.fy-engine-details').count()).toBe(0);
    await context.close();
  }, 60_000);
});
