/**
 * THE OPEN ITEM'S ⋯ MENU IS NEVER CLIPPED OR COVERED, in a real browser, over fake data (`fixtures/inbox-item-menu-scene.tsx`):
 * the real Inbox page opened on an item, in the 350px column the 5.0 sweep saw beside a 168px nav.
 *
 * The sweep: "1 hour / 4 hours / Custom / Merge with…" were drawn at x=81-211 — under the nav and clipped by the card's own
 * overflow — and could not be clicked. The popover is now drawn on the page body, fixed at ⋯, so every choice is what a click
 * at its centre hits, whatever the column's width, and it stays inside the window (a sheet on a phone).
 *
 * Set `FY_ITEM_MENU_SHOTS_DIR` to keep `<viewport>-item-menu.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_ITEM_MENU_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-item-menu-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/inbox-item-menu-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the item menu scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const { css, js } = await build();
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

/** Whether a click at the centre of `selector` lands on it (not clipped away, not covered), and where its box is. */
const hit = async (tab: Page, selector: string) =>
  await tab.evaluate(query => {
    const element = document.querySelector(query);
    if (element === null) throw new Error(`nothing matches ${query}`);
    const box = element.getBoundingClientRect();
    const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      lands: at !== null && element.contains(at),
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      windowWidth: document.documentElement.clientWidth,
      windowHeight: window.innerHeight,
    };
  }, selector);

describe('the open item’s ⋯ menu', () => {
  for (const viewport of VIEWPORTS)
    it(`every choice is on screen and takes a click (${viewport.name})`, async () => {
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
      try {
        await tab.goto(`${origin}/?theme=studio-light`);
        await tab.waitForSelector('.fy-item-view__bar [data-agenda-menu-toggle]:visible', { timeout: 8_000 });
        await tab.click('.fy-item-view__bar [data-agenda-menu-toggle]:visible');
        await tab.waitForSelector('[data-agenda-menu] [data-agenda-menu-snooze]');
        await tab.waitForTimeout(400);
        if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-item-menu.png`) });
        for (const selector of [
          '[data-agenda-menu-snooze="hour"]',
          '[data-agenda-menu-snooze="hours"]',
          '[data-agenda-menu-snooze="custom"]',
          '[data-agenda-menu] [data-agenda-menu-group="aside"] button',
        ]) {
          const found = await hit(tab, selector);
          expect(found.lands, `${selector}: a click at its centre lands on it`).toBe(true);
          expect(found.left, `${selector}: inside the window, left`).toBeGreaterThanOrEqual(0);
          expect(found.right, `${selector}: inside the window, right`).toBeLessThanOrEqual(found.windowWidth);
          expect(found.bottom, `${selector}: inside the window, bottom`).toBeLessThanOrEqual(found.windowHeight);
        }
      } finally {
        await context.close();
      }
    });
});
