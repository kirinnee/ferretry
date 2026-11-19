/**
 * THE CI FLAMEGRAPH in a real browser over fake data (`fixtures/flame-scene.tsx`): the whole run, zoomed into one job, a run
 * still going, and a CI that is not GitHub Actions; light and dark, phone and desktop. It checks what only a browser can:
 * the bars sit inside the chart, no sideways scroll, and every label keeps >= 4.5:1 on its bar's colour.
 *
 * Set `FY_FLAME_SHOTS_DIR` to keep `<viewport>-<scheme>-<case>.png` (cases: whole, zoomed, running, check, big, big-list-top, big-list-end).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_FLAME_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-flame-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', resolve(packageRoot, 'fixtures/flame-scene.tsx')],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the flame scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VARIANTS = [
  { name: '1280-light', width: 1_280, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, phone: true, scheme: 'dark' },
] as const;
type Variant = (typeof VARIANTS)[number];

/** Relative luminance of an sRGB colour whose channels are 0..1. */
const luminance = (rgb: readonly [number, number, number]): number => {
  const [r, g, b] = rgb.map(channel => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: readonly [number, number, number], b: readonly [number, number, number]): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};
/** Chrome serialises a resolved colour as `rgb(…)`/`rgba(…)` or `color(srgb r g b)`. */
const parseColour = (text: string): [number, number, number] => {
  const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/u.exec(text);
  if (srgb !== null) return [Number(srgb[1]), Number(srgb[2]), Number(srgb[3])];
  const rgb = /^rgba?\((\d+), (\d+), (\d+)/u.exec(text);
  if (rgb !== null) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255];
  throw new Error(`cannot read the colour ${text}`);
};

const open = async (
  variant: Variant,
  run: string,
): Promise<{ page: Page; close: () => Promise<void>; problems: string[] }> => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: 900 },
    deviceScaleFactor: variant.phone ? 2 : 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
    colorScheme: variant.scheme,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', error => problems.push(error.message));
  await page.goto(`${origin}/?theme=studio-${variant.scheme}&run=${run}`);
  await page.waitForSelector('[data-scene-ready] [data-flame-bar]');
  return { page, close: async () => await context.close(), problems };
};

/** `fullPage` is off for a page taller than Chrome paints in one shot (the 244-line list): the shot is the viewport instead. */
const shot = async (page: Page, variant: Variant, name: string, fullPage = true): Promise<void> => {
  if (shotsDir !== '') await page.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`), fullPage });
};

const noSidewaysScroll = async (page: Page): Promise<void> => {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
};

describe('the CI flamegraph', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: whole run, then zoomed into a job and back`, async () => {
      const { page, close, problems } = await open(variant, 'failed');
      try {
        // The run's bar is the full width of the chart and every bar below it stays inside.
        const chart = must(await page.locator('.fy-flame-chart').boundingBox(), 'the chart');
        const run = must(await page.locator('[data-flame-bar="run"] .fy-flame-fill').boundingBox(), 'the run bar');
        expect(Math.abs(run.width - chart.width)).toBeLessThan(3);
        for (const box of await page.locator('[data-flame-bar] .fy-flame-fill').evaluateAll(elements =>
          elements.map(element => {
            const { left, right } = element.getBoundingClientRect();
            return { left, right };
          }),
        )) {
          expect(box.left).toBeGreaterThanOrEqual(chart.x - 0.5);
          expect(box.right).toBeLessThanOrEqual(chart.x + chart.width + 0.5);
        }
        // Jobs are one row down, in the run's order; the failed one is wider than the lint job.
        const lint = must(await page.locator('[data-flame-bar="job:1"] .fy-flame-fill').boundingBox(), 'lint');
        const test = must(await page.locator('[data-flame-bar="job:2"] .fy-flame-fill').boundingBox(), 'test');
        expect(test.width).toBeGreaterThan(lint.width * 4);
        expect(test.y).toBeGreaterThan(run.y);
        // The label keeps its contrast on the bar's colour for every status drawn.
        for (const key of ['run', 'job:1', 'job:2', 'step:2:4']) {
          const pair = await page.locator(`[data-flame-bar="${key}"]`).evaluate(element => ({
            fill: getComputedStyle(element.querySelector('.fy-flame-fill') as Element).fill,
            text: getComputedStyle(element.querySelector('text') as Element).fill,
          }));
          expect(
            contrast(parseColour(pair.text), parseColour(pair.fill)),
            `${key} label contrast`,
          ).toBeGreaterThanOrEqual(4.5);
        }
        expect(await page.locator('[data-flame-note]').textContent()).toContain('longer than the run’s wall time');
        // A duration never splits across lines.
        expect(await page.locator('[data-flame-note]').textContent()).toContain('6\u00a0m\u00a040\u00a0s');
        await noSidewaysScroll(page);
        await shot(page, variant, 'whole');

        await page.locator('[data-flame-bar="job:2"]').click();
        await page.waitForSelector('.fy-flame-trail .fy-flame-here:text("test")');
        // A pointer left where the click was would highlight whichever bar slid under it: park it away from the chart.
        await page.mouse.move(0, 0);
        // One highlight: the bar the line under the chart describes, which is the zoomed job until something else is picked.
        expect(
          await page.locator('[data-shown]').evaluateAll(els => els.map(el => el.getAttribute('data-flame-bar'))),
        ).toEqual(['job:2']);
        // The breadcrumb starts at the chart's left edge on a phone as on a desktop.
        const crumb = must(await page.locator('.fy-flame-trail .fy-flame-back').boundingBox(), 'the breadcrumb');
        expect(Math.abs(crumb.x - chart.x)).toBeLessThan(3);
        expect(await page.locator('[data-flame-bar]').count()).toBe(6);
        const zoomed = must(
          await page.locator('[data-flame-bar="job:2"] .fy-flame-fill').boundingBox(),
          'the zoomed job',
        );
        expect(Math.abs(zoomed.width - chart.width)).toBeLessThan(3);
        await noSidewaysScroll(page);
        await shot(page, variant, 'zoomed');

        await page.locator('.fy-flame-back').click();
        expect(await page.locator('[data-flame-bar="job:1"]').count()).toBe(1);
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });

    it(`${variant.name}: the biggest run the contract allows (256 jobs x 500 steps) draws a bounded chart and lists the rest`, async () => {
      const { page, close, problems } = await open(variant, 'big');
      try {
        // 1 run + 13 job bars + 12 x 13 step bars: the same few dozen bars however big the run is.
        expect(await page.locator('[data-flame-bar]').count()).toBe(170);
        await noSidewaysScroll(page);
        await shot(page, variant, 'big');
        const chart = must(await page.locator('.fy-flame-chart').boundingBox(), 'the chart');
        for (const box of await page.locator('[data-flame-bar] .fy-flame-fill').evaluateAll(elements =>
          elements.map(element => {
            const { left, right } = element.getBoundingClientRect();
            return { left, right };
          }),
        )) {
          expect(box.left).toBeGreaterThanOrEqual(chart.x - 0.5);
          expect(box.right).toBeLessThanOrEqual(chart.x + chart.width + 0.5);
        }
        // The folded bar opens the text list: every folded job is one line, and none of the 244 is out of reach.
        await page.locator('[data-flame-bar="more:run"]').click();
        await page.waitForSelector('[data-flame-item]');
        await page.mouse.move(0, 0);
        expect(await page.locator('[data-flame-item]').count()).toBe(244);
        expect(await page.locator('[data-flame-more] summary').textContent()).toBe('List 244 shorter jobs');
        await noSidewaysScroll(page);
        await shot(page, variant, 'big-list-top', false);
        // The end of the list, the legend and the sentence under it.
        await page.locator('[data-flame-note]').scrollIntoViewIfNeeded();
        await shot(page, variant, 'big-list-end', false);
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });

    it(`${variant.name}: a run still going and a check from another CI`, async () => {
      const running = await open(variant, 'running');
      try {
        expect(await running.page.locator('[data-live]').count()).toBeGreaterThan(0);
        await noSidewaysScroll(running.page);
        await shot(running.page, variant, 'running');
        expect(running.problems).toEqual([]);
      } finally {
        await running.close();
      }
      const check = await open(variant, 'check');
      try {
        expect(await check.page.locator('[data-flame-bar]').count()).toBe(1);
        await noSidewaysScroll(check.page);
        await shot(check.page, variant, 'check');
        expect(check.problems).toEqual([]);
      } finally {
        await check.close();
      }
    });
  }
});

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}
