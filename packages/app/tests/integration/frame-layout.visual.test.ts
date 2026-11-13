/**
 * THE FRAME LAYS OUT THE AGENDA AND THE FERRET PAGE, in a real browser, over fake data (`fixtures/frame-scene.tsx`):
 * the real shell, the default layout and the stylesheet that ships; no daemon.
 *
 *  - AGENDA PAGE: at 1280 the page column is as wide as v4's even while a background view draws a status line (that line
 *    used to be a column of the frame's own row and took ~400px from the page: the item column was 350px). The ⋯ menu's
 *    placement is the Agenda plugin's own visual test (`inbox-item-menu.visual.test.ts`).
 *  - FERRET PAGE: the side pane has its own column and scrolls, so every panel the default layout lists is reachable and
 *    the chat keeps most of the row; on a phone the pane does not crush the chat.
 *
 * Set `FY_LAYOUT_SHOTS_DIR` to keep `<viewport>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_LAYOUT_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-frame-layout-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', resolve(packageRoot, 'fixtures/frame-scene.tsx')],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the frame scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const { css, js } = await build();
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

const open = async (viewport: (typeof VIEWPORTS)[number], path: string, ready: string) => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.phone ? 2 : 1,
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
  await tab.goto(`${origin}${path}?theme=studio-light`);
  try {
    await tab.waitForSelector(ready, { timeout: 8_000 });
    if (shotsDir !== '')
      await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${path.replaceAll('/', '_')}-opened.png`) });
  } catch (error) {
    throw new Error(`the scene did not draw ${ready}: ${String(error)}\n${problems.join('\n')}`);
  }
  return { tab, close: async () => await context.close() };
};

const width = async (tab: Page, selector: string): Promise<number> =>
  await tab.evaluate(query => document.querySelector(query)?.getBoundingClientRect().width ?? -1, selector);

/** Whether the point at the centre of `selector` hits that element (or something inside it): not clipped, not covered. */
const hitsItself = async (tab: Page, selector: string): Promise<{ readonly hit: boolean; readonly left: number }> =>
  await tab.evaluate(query => {
    const element = document.querySelector(query);
    if (element === null) throw new Error(`nothing matches ${query}`);
    const box = element.getBoundingClientRect();
    const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { hit: at !== null && element.contains(at), left: box.left };
  }, selector);

describe('the agenda page with a status line drawn in flow', () => {
  it('at 1280 keeps v4’s page column and puts the line in a strip under the top bar, across the page', async () => {
    const { tab, close } = await open(VIEWPORTS[0], '/d/ws/agenda', '[data-relay-fallback]');
    try {
      if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, '1280-agenda-page.png') });
      expect(await width(tab, '.fy-main'), 'the page column (v4: ~680px)').toBeGreaterThanOrEqual(680);
      const line = await tab.evaluate(() => {
        const box = (query: string) => document.querySelector(query)?.getBoundingClientRect();
        const note = box('[data-relay-fallback]');
        const top = box('.fy-top');
        const columns = box('.fy-columns');
        const body = box('.fy-body');
        return {
          noteLeft: note?.left ?? -1,
          noteRight: note?.right ?? -1,
          noteTop: note?.top ?? -1,
          noteBottom: note?.bottom ?? -1,
          topBottom: top?.bottom ?? -1,
          columnsTop: columns?.top ?? -1,
          bodyLeft: body?.left ?? -1,
          bodyRight: body?.right ?? -1,
        };
      });
      expect(line.noteTop, 'under the top bar').toBeGreaterThanOrEqual(line.topBottom);
      expect(line.noteBottom, 'above the columns').toBeLessThanOrEqual(line.columnsTop);
      expect(line.noteLeft, 'the strip starts at the body’s left edge').toBeLessThanOrEqual(line.bodyLeft + 16);
    } finally {
      await close();
    }
  });

  it('at 390 keeps the page column at the phone’s width', async () => {
    const { tab, close } = await open(VIEWPORTS[1], '/d/ws/agenda', '[data-relay-fallback]');
    try {
      if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, '390-agenda-page.png') });
      expect(await width(tab, '.fy-main'), 'the page column').toBeGreaterThanOrEqual(330);
    } finally {
      await close();
    }
  });
});

describe('the ferret page', () => {
  it('at 1280 gives the side pane its own scrolling column and keeps the chat most of the row', async () => {
    const { tab, close } = await open(VIEWPORTS[0], '/d/ws/ferrets/zoe', '[data-slot="ferret.side"] [data-side-panel]');
    try {
      const panels = await tab.locator('[data-slot="ferret.side"] [data-side-panel]').count();
      expect(panels, 'every panel the default layout lists is drawn').toBe(14);
      const slot = await tab.evaluate(() => {
        const element = document.querySelector('[data-slot="ferret.side"]') as HTMLElement;
        const box = element.getBoundingClientRect();
        return {
          width: box.width,
          height: box.height,
          scrolls: getComputedStyle(element).overflowY === 'auto' || getComputedStyle(element).overflowY === 'scroll',
        };
      });
      expect(slot.width, 'the pane is a column, not the chat’s width').toBeLessThanOrEqual(420);
      expect(slot.scrolls, 'the pane scrolls on its own').toBe(true);
      expect(slot.height, 'the pane is never taller than the window').toBeLessThanOrEqual(VIEWPORTS[0].height);
      expect(await width(tab, '[data-chat]'), 'the chat keeps the row').toBeGreaterThanOrEqual(400);
      if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, '1280-ferret-side-panels.png') });
      // The last panel is reachable: scrolled into its column it is on screen.
      await tab.locator('[data-side-panel="insights"]').scrollIntoViewIfNeeded();
      const insights = await hitsItself(tab, '[data-side-panel="insights"]');
      expect(insights.hit, 'the last panel can be reached').toBe(true);
      if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, '1280-ferret-side-panels-scrolled.png') });
    } finally {
      await close();
    }
  });

  it('at 390 the side pane does not crush the chat', async () => {
    const { tab, close } = await open(VIEWPORTS[1], '/d/ws/ferrets/zoe', '[data-chat]');
    try {
      if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, '390-ferret-page.png') });
      expect(await width(tab, '[data-chat]'), 'the chat takes the phone’s width').toBeGreaterThanOrEqual(330);
    } finally {
      await close();
    }
  });
});
