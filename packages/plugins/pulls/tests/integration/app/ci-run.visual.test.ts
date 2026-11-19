/**
 * THE CI RUN PAGE in a real browser over fake data (`fixtures/ci-run-scene.tsx`): names with no break in them stay inside the
 * page, the biggest run the contract allows mounts a bounded few rows, and a step E8 still flags live inside a job that
 * stopped keeps its length an hour later; light and dark, phone and desktop.
 *
 * Set `FY_CI_RUN_SHOTS_DIR` to keep `<viewport>-<scheme>-<case>.png` (cases: long, long-open, big, big-more, stopped).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_CI_RUN_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-ci-run-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', resolve(packageRoot, 'fixtures/ci-run-scene.tsx')],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the ci run scene did not build (${code}):\n${stderr}\n${stdout}`);
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
  await page.waitForSelector('[data-scene-ready] [data-ci-run-page]');
  return { page, close: async () => await context.close(), problems };
};

/** `fullPage` is off for a page taller than Chrome paints in one shot (256 jobs): the shot is the viewport instead. */
const shot = async (page: Page, variant: Variant, name: string, fullPage = true): Promise<void> => {
  if (shotsDir !== '') await page.screenshot({ path: join(shotsDir, `${variant.name}-${name}.png`), fullPage });
};

const noSidewaysScroll = async (page: Page): Promise<void> => {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
};

/** Nothing the page drew sticks out past the viewport's right edge. */
const nothingPastTheEdge = async (page: Page, selector: string): Promise<void> => {
  const widest = await page.evaluate((selected: string) => {
    const edge = document.documentElement.clientWidth;
    return Math.max(...[...document.querySelectorAll(selected)].map(el => el.getBoundingClientRect().right - edge));
  }, selector);
  expect(widest, `${selector} stays inside the page`).toBeLessThanOrEqual(0.5);
};

describe('the CI run page', () => {
  for (const variant of VARIANTS) {
    it(`${variant.name}: 500-character names with no break in them wrap inside the page`, async () => {
      const { page, close, problems } = await open(variant, 'long');
      try {
        await noSidewaysScroll(page);
        await nothingPastTheEdge(page, '[data-ci-run-page] h2, [data-ci-slowest-line], [data-ci-job], [data-ci-step]');
        await shot(page, variant, 'long');
        // The failed job opens by itself, so its 500-character step name is on screen too.
        expect(
          await page
            .locator('[data-ci-step]')
            .filter({ hasText: 'S'.repeat(500) })
            .count(),
        ).toBe(1);
        expect(await page.locator('[data-ci-slowest-line]').textContent()).toContain('S'.repeat(500));
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });

    it(`${variant.name}: the biggest run the contract allows mounts a bounded few rows, and the rest is one button away`, async () => {
      const { page, close, problems } = await open(variant, 'big');
      try {
        expect(await page.locator('[data-ci-job]').count()).toBe(256);
        expect(await page.locator('[data-ci-step]').count()).toBe(100);
        await noSidewaysScroll(page);
        await shot(page, variant, 'big', false);
        await page.locator('[data-ci-more-steps] button').first().click();
        expect(await page.locator('[data-ci-job="1"] [data-ci-step]').count()).toBe(50);
        await page.locator('[data-ci-more-steps]').first().scrollIntoViewIfNeeded();
        await shot(page, variant, 'big-more', false);
        await noSidewaysScroll(page);
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });

    it(`${variant.name}: a step still flagged live inside a job that stopped keeps its length`, async () => {
      const { page, close, problems } = await open(variant, 'stopped');
      try {
        await page.locator('[data-ci-job="8"] button[aria-expanded]').click();
        expect(await page.locator('[data-ci-step="2"] [data-ci-duration]').textContent()).toBe('9s');
        await noSidewaysScroll(page);
        await shot(page, variant, 'stopped');
        expect(problems).toEqual([]);
      } finally {
        await close();
      }
    });
  }
});
