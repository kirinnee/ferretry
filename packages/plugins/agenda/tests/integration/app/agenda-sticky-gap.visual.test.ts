/**
 * THE OPEN AGENDA ITEM KEEPS ITS HEAD AND ITS ANSWER ROW IN REACH, in a real browser, on a phone and a desktop, in light
 * and dark.
 *
 * The owner (2026-10-31): "make the top bar sticky, and if options are provided (standard card, instead of complex
 * card), make the options stick to the bottom too … also why is there such a big gap in the convo and the composer".
 *
 *  - The scene is the REAL `AgendaItemView` over a card that runs several screens (`fixtures/agenda-sticky-scene.tsx`).
 *    Scrolled to the middle and to the end, the head must sit on the scroller's top edge, a one-row answer card's
 *    options on its bottom edge, and nothing may be left behind either of them at the end of the scroll. A reply card
 *    answers in the composer, so it has no dock.
 *  - The chat at its tail (Conversation's `Transcript` with this half's `AgendaLine`) is not drawn here:
 *    neither plugin imports the other, so Conversation draws its transcript against a stand-in row
 *    (`packages/plugins/conversation/tests/integration/app/chat-tail.visual.test.ts`).
 *
 * Set `FY_STICKY_GAP_SHOTS_DIR` to keep `<viewport>-<scheme>-<scene>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

/** This file's folder: the scene paths below are relative to it, and the builder runs here. */
const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_STICKY_GAP_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-chat-log { flex: 1 1 0; }
  .scene-composer { border: 1px solid var(--fy-border, #888); border-radius: 12px; box-sizing: border-box; height: 56px; padding: 16px; }
`;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-sticky-gap-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/agenda-sticky-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the sticky/gap scene did not build (${code}):\n${stderr}\n${stdout}`);
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

// Settled means NOTHING IS STILL MOVING: the item view opens with a 160ms translate+fade, and a box read while it
// runs is a box at one frame of it. Wait for the finite animations themselves to finish (not for a time; the busy
// spinner never ends), then for the frames the observers (scroll padding) need to land.
const framesSettled = async (tab: Page): Promise<void> => {
  await tab.waitForFunction(() =>
    document
      .getAnimations()
      .filter(entry => entry.effect?.getComputedTiming().endTime !== Infinity)
      .every(entry => entry.playState === 'finished'),
  );
  await tab.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
};

interface Box {
  readonly top: number;
  readonly bottom: number;
  readonly height: number;
}

interface Edges {
  readonly scroller: Box;
  readonly head: Box;
  readonly dock: Box;
}

// ONE evaluate reads all three, so they are one frame's layout: separate round trips are separate frames.
const edges = async (tab: Page): Promise<Edges> =>
  await tab.evaluate(() => {
    const read = (query: string): { top: number; bottom: number; height: number } => {
      const element = document.querySelector(query);
      if (element === null) throw new Error(`nothing matches ${query}`);
      const { top, bottom, height } = element.getBoundingClientRect();
      return { top, bottom, height };
    };
    return {
      scroller: read('.fy-item-view__body'),
      head: read('[data-agenda-top]'),
      dock: read('[data-agenda-dock]'),
    };
  });

const VIEWPORTS = [
  { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
  { name: 'desktop', viewport: { width: 1_440, height: 900 }, deviceScaleFactor: 1 },
] as const;

const open = async (
  scene: string,
  name: string,
  scheme: 'light' | 'dark',
  query: string,
): Promise<{ tab: Page; close: () => Promise<void> }> => {
  const viewport = VIEWPORTS.find(entry => entry.name === name) ?? VIEWPORTS[0];
  const context = await browser.newContext({
    viewport: viewport.viewport,
    colorScheme: scheme,
    deviceScaleFactor: viewport.deviceScaleFactor,
    hasTouch: name === 'phone',
    isMobile: name === 'phone',
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  await tab.goto(`${origin}/?theme=studio-${scheme}&scene=${scene}${query}`);
  return { tab, close: async () => await context.close() };
};

describe('the open agenda item', () => {
  for (const { name } of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`keeps its head and its answer row on screen while a long card scrolls (${name}, ${scheme})`, async () => {
        const { tab, close } = await open('item', name, scheme, '&kind=choice');
        try {
          await tab.waitForSelector('.fy-item-view__body');
          await tab.waitForSelector('[data-agenda-dock] [data-agenda-quick-replies], [data-agenda-dock] button');
          await framesSettled(tab);
          const scrollerSize = await tab.evaluate(() => {
            const body = document.querySelector('.fy-item-view__body') as HTMLElement;
            return { scroll: body.scrollHeight, client: body.clientHeight };
          });
          // The card really is long: the test would prove nothing on one that fits.
          expect(scrollerSize.scroll).toBeGreaterThan(scrollerSize.client * 1.8);

          const check = async (label: string): Promise<void> => {
            const { scroller, head, dock } = await edges(tab);
            expect(head.height, `${label}: the head has a height`).toBeGreaterThan(20);
            expect(Math.abs(head.top - scroller.top), `${label}: the head sits on the top edge`).toBeLessThanOrEqual(1);
            expect(dock.height, `${label}: the dock has a height`).toBeGreaterThan(20);
            expect(
              Math.abs(dock.bottom - scroller.bottom),
              `${label}: the dock sits on the bottom edge`,
            ).toBeLessThanOrEqual(1);
            const options = await tab.evaluate(() => {
              const dockElement = document.querySelector('[data-agenda-dock]') as HTMLElement;
              const buttons = [...dockElement.querySelectorAll('button')];
              const area = dockElement.getBoundingClientRect();
              return buttons.map(button => {
                const rect = button.getBoundingClientRect();
                return rect.top >= area.top - 1 && rect.bottom <= area.bottom + 1 && rect.width > 0;
              });
            });
            expect(options.length, `${label}: options are in the dock`).toBeGreaterThan(0);
            expect(options.every(Boolean), `${label}: every option is inside the dock`).toBe(true);
          };

          await check('at the top');
          await tab.evaluate(() => {
            const body = document.querySelector('.fy-item-view__body') as HTMLElement;
            body.scrollTop = (body.scrollHeight - body.clientHeight) / 2;
          });
          await framesSettled(tab);
          await check('mid-scroll');
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-card-scrolled.png`) });

          await tab.evaluate(() => {
            const body = document.querySelector('.fy-item-view__body') as HTMLElement;
            body.scrollTop = body.scrollHeight;
          });
          await framesSettled(tab);
          await check('at the end');
          // Nothing is left behind the dock: the last thing in the scroller ends above it.
          const tail = await tab.evaluate(() => {
            const column = document.querySelector('.fy-item-view__column') as HTMLElement;
            const dock = document.querySelector('[data-agenda-dock]') as HTMLElement;
            const last = [...column.children]
              .filter(child => child !== dock && (child as HTMLElement).offsetHeight > 0)
              .at(-1) as HTMLElement;
            return { lastBottom: last.getBoundingClientRect().bottom, dockTop: dock.getBoundingClientRect().top };
          });
          expect(tail.lastBottom).toBeLessThanOrEqual(tail.dockTop + 1);
        } finally {
          await close();
        }
      });

  it('leaves the bottom to the composer for a card that is answered in words', async () => {
    const { tab, close } = await open('item', 'phone', 'light', '&kind=reply');
    try {
      await tab.waitForSelector('.fy-item-view__body');
      await framesSettled(tab);
      const dock = await tab.evaluate(() => {
        const element = document.querySelector('[data-agenda-dock]') as HTMLElement | null;
        return element === null ? 0 : element.getBoundingClientRect().height;
      });
      expect(dock).toBeLessThanOrEqual(12);
      const { head, scroller } = await edges(tab);
      expect(Math.abs(head.top - scroller.top)).toBeLessThanOrEqual(1);
      if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, 'phone-light-reply-card.png') });
    } finally {
      await close();
    }
  });
});
