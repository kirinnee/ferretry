/**
 * THE APP'S ONE IMAGE VIEWER, opened from a picture in a message, in a real browser over fake data
 * (`fixtures/image-viewer-scene.tsx`): in the chat page, in an agenda item's embedded chat, and from the block's own
 * fullscreen — at a phone and a desktop width, at 2x.
 *
 * Set `FY_IMAGE_VIEWER_SHOTS_DIR` to keep `<viewport>-<where>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

// A cold browser launch is slow; every scene below is one launch plus a short walk.
setDefaultTimeout(90_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_IMAGE_VIEWER_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-image-viewer-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/image-viewer-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the image viewer scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html, body, #root { height: 100%; margin: 0; }</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 800, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

const TRIGGER = 'button[data-fy-render-zoom-trigger]';
const VIEWER = '[data-testid="image-viewer"]';

const withScene = async (
  viewport: (typeof VIEWPORTS)[number],
  ctx: 'chat' | 'agenda',
  run: (tab: Page, shot: (name: string) => Promise<void>) => Promise<void>,
): Promise<void> => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: 'dark',
    deviceScaleFactor: 2,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  try {
    await tab.goto(`${origin}/?theme=studio-dark&ctx=${ctx}`);
    try {
      await tab.waitForSelector(`${TRIGGER} img`, { timeout: 10_000 });
    } catch (error) {
      throw new Error(
        `the scene did not draw: ${String(error)}\n${problems.join('\n')}\n${(await tab.locator('body').innerText()).slice(0, 1500)}\n${(await tab.content()).match(/data-fy-render[^ >]*/gu)?.join(' ')}`,
      );
    }
    await tab.waitForTimeout(300);
    await run(tab, async name => {
      if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${name}.png`) });
    });
    expect(problems, 'no page errors').toEqual([]);
  } finally {
    await context.close();
  }
};

const readout = (tab: Page): Promise<string> =>
  tab.locator('[data-testid="image-viewer-readout"]').innerText({ timeout: 5_000 });

describe('the image viewer, opened from a picture in a message', () => {
  for (const viewport of VIEWPORTS)
    for (const ctx of ['chat', 'agenda'] as const)
      it(`opens full-screen over the ${ctx}, says the picture's resolution, and closes with Escape (${viewport.name})`, async () => {
        await withScene(viewport, ctx, async (tab, shot) => {
          await shot(`${ctx}-before`);
          await tab.locator(TRIGGER).first().click();
          await tab.waitForSelector(VIEWER, { state: 'visible' });
          await tab.waitForSelector('[data-testid="image-viewer-readout"]');
          expect(await readout(tab)).toMatch(/· 1800×1200$/u);
          const box = await tab.locator(VIEWER).boundingBox();
          expect(box?.width).toBe(viewport.width);
          expect(box?.height).toBe(viewport.height);
          const overflow = await tab.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow).toBeLessThanOrEqual(0);
          await shot(`${ctx}-viewer`);
          await tab.getByRole('button', { name: 'Actual size' }).click();
          await tab.waitForTimeout(250);
          expect(await readout(tab)).toBe('100% · 1800×1200');
          await shot(`${ctx}-viewer-actual-size`);
          await tab.keyboard.press('Escape');
          await tab.waitForSelector(VIEWER, { state: 'detached' });
          expect(await tab.evaluate(() => document.activeElement?.hasAttribute('data-fy-render-zoom-trigger'))).toBe(
            true,
          );
        });
      });

  for (const viewport of VIEWPORTS)
    it(`opens from the block's own fullscreen and Escape closes only the viewer, not the block (${viewport.name})`, async () => {
      await withScene(viewport, 'chat', async (tab, shot) => {
        await tab.getByRole('button', { name: 'Fullscreen' }).first().click();
        await tab.waitForSelector('[data-fy-render-fullscreen="true"]');
        await tab.locator('[data-fy-render-fullscreen="true"] button[data-fy-render-zoom-trigger]').click();
        await tab.waitForSelector(VIEWER, { state: 'visible' });
        await tab.waitForSelector('[data-testid="image-viewer-readout"]');
        await shot('block-fullscreen-viewer');
        await tab.keyboard.press('Escape');
        await tab.waitForSelector(VIEWER, { state: 'detached' });
        expect(await tab.locator('[data-fy-render-fullscreen="true"]').count(), 'the block stays fullscreen').toBe(1);
        await shot('block-fullscreen-after-escape');
        await tab.keyboard.press('Escape');
        await tab.waitForSelector('[data-fy-render-fullscreen="true"]', { state: 'detached' });
      });
    });
});
