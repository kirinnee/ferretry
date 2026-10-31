/**
 * "JUMP TO LATEST" MUST NEVER HIDE WHAT THE READER IS LOOKING AT, in a real browser, on a phone and a desktop,
 * in light and dark.
 *
 * The owner (2026-10-31): "there's a bug where jump to latest clips the table". The pill floated over the
 * bottom of the scroller, so the last row of the newest message's table sat under it. The scene
 * (`fixtures/jump-latest-scene.tsx`) is the real `Transcript` over a conversation ending in a table, a code
 * block or a diagram, with a stand-in composer beneath. The reader wheels up a little, so the pill shows
 * while the newest message is still on screen, and the pill's box must not intersect the scroller's — so the
 * newest block's visible bottom stays above the pill's top — and must sit above the composer.
 *
 * Set `FY_JUMP_LATEST_SHOTS_DIR` to keep `<viewport>-<scheme>-<last>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const shotsDir = process.env.FY_JUMP_LATEST_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-messages { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }
  .scene-chat .fy-transcript-shell { flex: 1 1 auto; margin: 0 auto; max-width: 760px; width: 100%; box-sizing: border-box; min-height: 0; }
  .scene-composer { border-top: 1px solid var(--fy-border, #888); flex: none; height: 64px; padding: 12px 16px; box-sizing: border-box; }
`;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-jump-latest-'));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(packageRoot, 'scripts/build-composer-integration-fixture.ts'),
      '--out',
      directory,
      '--entry',
      'tests/integration/fixtures/jump-latest-scene.tsx',
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the jump-latest scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const { css, js } = await build();
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>${SCENE_CSS}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
      return new Response('not here', { status: 404 });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const framesSettled = async (tab: Page): Promise<void> =>
  await tab.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

interface Geometry {
  readonly scrollerBottom: number;
  readonly pillTop: number;
  readonly pillBottom: number;
  readonly lastBottom: number;
  readonly composerTop: number;
}

const geometry = async (tab: Page): Promise<Geometry> =>
  await tab.evaluate(() => {
    const rect = (selector: string): DOMRect => {
      const element = document.querySelector(selector);
      if (element === null) throw new Error(`no ${selector} on the page`);
      return element.getBoundingClientRect();
    };
    const rows = [...document.querySelectorAll('.fy-transcript-content > *')];
    return {
      scrollerBottom: rect('.fy-transcript').bottom,
      pillTop: rect('.fy-jump-latest').top,
      pillBottom: rect('.fy-jump-latest').bottom,
      lastBottom: (rows.at(-1) as Element).getBoundingClientRect().bottom,
      composerTop: rect('.scene-composer').top,
    };
  });

const VIEWPORTS = [
  { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
  { name: 'desktop', viewport: { width: 1_440, height: 900 }, deviceScaleFactor: 1 },
] as const;

describe('jump to latest beside the newest message', () => {
  for (const { name, viewport, deviceScaleFactor } of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      for (const last of ['table', 'code'] as const)
        it(`leaves the end of a ${last} readable on a ${name} in ${scheme}`, async () => {
          const context = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor });
          try {
            const origin = server?.url.origin ?? '';
            await context.route('**/*', async route =>
              new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
            );
            const tab = await context.newPage();
            await tab.goto(`${origin}/?theme=studio-${scheme}&last=${last}`);
            await tab.waitForSelector('.fy-transcript-content > :last-child');
            await framesSettled(tab);

            // The reader wheels up a little: still within sight of the newest message, but detached.
            const scroller = await tab.locator('.fy-transcript').boundingBox();
            if (scroller === null) throw new Error('no transcript on screen');
            await tab.mouse.move(scroller.x + scroller.width / 2, scroller.y + scroller.height / 2);
            await tab.mouse.wheel(0, -40);
            await tab.waitForSelector('.fy-jump-latest');
            await framesSettled(tab);

            const seen = await geometry(tab);
            if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-${last}.png`) });

            // Nothing in the scroller is under the pill, so the newest block's visible bottom is above its top.
            expect(Math.min(seen.lastBottom, seen.scrollerBottom)).toBeLessThanOrEqual(seen.pillTop);
            expect(seen.scrollerBottom).toBeLessThanOrEqual(seen.pillTop);
            // And the pill sits above the composer, never over it.
            expect(seen.pillBottom).toBeLessThanOrEqual(seen.composerTop);
          } finally {
            await context.close();
          }
        });
});
