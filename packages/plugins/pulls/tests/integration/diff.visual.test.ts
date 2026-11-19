/**
 * THE FILES TAB in a real browser over fake data (`fixtures/diff-scene.tsx`): the tree and a split diff from 1024 px, one
 * unified column on a phone, nothing wider than the screen, and the rows a file with no patch shows.
 *
 * Set `FY_PULLS_DIFF_SHOTS_DIR` to keep `<viewport>-<theme>-<case>.png` (1280 and 390 wide, light and dark).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser } from 'playwright-core';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_PULLS_DIFF_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-pulls-diff-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', resolve(packageRoot, 'fixtures/diff-scene.tsx')],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the diff scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const VARIANTS = [
  { name: '1280-light', width: 1_280, height: 900, phone: false, scheme: 'light' },
  { name: '1280-dark', width: 1_280, height: 900, phone: false, scheme: 'dark' },
  { name: '390-light', width: 390, height: 1_100, phone: true, scheme: 'light' },
  { name: '390-dark', width: 390, height: 1_100, phone: true, scheme: 'dark' },
] as const;
const CASES = ['split', 'large', 'threads', 'viewed', 'bounded'] as const;

const open = async (variant: (typeof VARIANTS)[number], scene: string, height: number = variant.height) => {
  const context = await browser.newContext({
    viewport: { width: variant.width, height },
    // One pixel per CSS pixel: a phone-height scene stays a size a reviewer can read whole.
    deviceScaleFactor: 1,
    hasTouch: variant.phone,
    isMobile: variant.phone,
    colorScheme: variant.scheme,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/?theme=studio-${variant.scheme}&case=${scene}`);
  await tab.waitForSelector('[data-pulls-files="ready"]');
  // On a phone the file list is behind a button; one scene opens it to show it.
  if (variant.phone && scene === 'split') await tab.getByRole('button', { name: 'File list' }).click();
  return { tab, problems, close: async () => await context.close() };
};

describe('the Files tab', () => {
  for (const variant of VARIANTS)
    for (const scene of CASES)
      it(`${variant.name} · ${scene}: draws once, fits the screen and has the right view`, async () => {
        const page = await open(variant, scene);
        const { tab } = page;
        const treeShown = !variant.phone || scene === 'split';
        const wide = await tab.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
        );
        expect(wide).toBe(false);
        expect(await tab.locator(`[data-diff-view="${variant.phone ? 'split' : 'unified'}"]`).count()).toBe(0);
        expect(await tab.locator(`[data-diff-view="${variant.phone ? 'unified' : 'split'}"]`).count()).toBeGreaterThan(
          0,
        );
        expect(await tab.locator('[data-file-tree]').count()).toBe(treeShown ? 1 : 0);
        if (scene === 'large') expect(await tab.getByText('Too large or binary to show here.').count()).toBe(1);
        if (scene === 'threads') expect(await tab.locator('[data-thread]').count()).toBe(2);
        if (scene === 'viewed') expect(await tab.locator('[data-viewed="true"]').count()).toBe(2);
        if (scene === 'bounded') {
          // 25 of 83 cards, the long line cut to a short row with its note, the hidden characters named.
          expect(await tab.locator('[data-diff-file]').count()).toBe(25);
          expect(await tab.locator('[data-files-more]').count()).toBe(1);
          expect(await tab.locator('[data-diff-cut]').count()).toBe(1);
          expect(await tab.locator('[data-diff-control]').count()).toBeGreaterThan(3);
          expect(await tab.locator('[data-diff-more]').count()).toBe(1);
          const tallest = await tab.evaluate(() =>
            Math.max(
              ...[...document.querySelectorAll('[data-diff-line]')].map(line => line.getBoundingClientRect().height),
            ),
          );
          expect(tallest).toBeLessThan(500);
        }
        if (scene === 'large') {
          // A short path stays on one line: it is not split inside its name by the numbers beside it.
          const lines = await tab.evaluate(() => {
            const button = document.querySelector('[data-diff-file="data/fixtures.json"] header button');
            if (button === null) return -1;
            const range = document.createRange();
            range.selectNodeContents(button);
            return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
          });
          expect(lines).toBe(1);
        }
        // Every card sits inside the scene, none is cut: the last one ends before the scene does.
        const cut = await tab.evaluate(() => {
          const end = document.querySelector('[data-scene]')?.getBoundingClientRect().bottom ?? 0;
          return [...document.querySelectorAll('[data-diff-file]')].some(
            card => card.getBoundingClientRect().bottom > end,
          );
        });
        expect(cut).toBe(false);
        if (shotsDir !== '') {
          // The shot is of a page exactly as tall as the scene: a browser does not paint what lies beyond a mobile
          // viewport, so a scene is shot in a viewport of its own height (nothing in it is sized by the viewport).
          // The page itself is as tall as the viewport (the app shell scrolls inside it), so the scene is what is measured.
          const height = await tab.evaluate(
            () => Math.ceil(document.querySelector('[data-scene]')?.getBoundingClientRect().bottom ?? 0) + 8,
          );
          const whole = await open(variant, scene, Math.max(height, variant.height));
          await whole.tab.screenshot({ path: join(shotsDir, `${variant.name}-${scene}.png`) });
          await whole.close();
        }
        expect(page.problems).toEqual([]);
        await page.close();
      });
});
