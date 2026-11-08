/**
 * THE CHAT HAS NO BAND OF NOTHING ABOVE THE COMPOSER, in a real browser, on a phone and a desktop, in light and dark.
 *
 * The owner (2026-10-31): "… also why is there such a big gap in the convo and the composer".
 *
 * The scene is the REAL `Transcript` above a stand-in for Agenda's row (`fixtures/chat-tail-scene.tsx` says why it is
 * a stand-in: Conversation imports nothing of Agenda's app). At the tail the gap between the last message and the
 * composer is the one agenda row (the Jump pill lives IN it), not that row plus a second, invisible one; and that
 * row's height does not change when the pill comes and goes (the #1180 flicker).
 *
 * Set `FY_CHAT_TAIL_SHOTS_DIR` to keep `<viewport>-<scheme>-<scene>.png`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '@ferretry/app/testing/browser';

/** This file's folder: the scene paths below are relative to it, and the builder runs here. */
const packageRoot = import.meta.dir;

const shotsDir = process.env.FY_CHAT_TAIL_SHOTS_DIR ?? '';

const SCENE_CSS = `
  html, body, #root { height: 100%; margin: 0; }
  .scene-chat { box-sizing: border-box; display: flex; flex-direction: column; inset: 0; position: fixed; }
  .scene-chat .fy-chat-log { flex: 1 1 0; }
  .scene-agenda-row { align-items: center; box-sizing: border-box; display: flex; gap: 8px; min-height: 40px; padding: 0 8px; }
  .scene-agenda-row__jump { display: flex; flex: 0 0 auto; }
  .scene-agenda-row__jump:empty { display: none; }
  .scene-agenda-row__live { flex: 1 1 auto; min-width: 0; }
  .scene-agenda-row__main { background: none; border: 0; color: inherit; font: inherit; margin-left: auto; padding: 8px; }
  .scene-composer { border: 1px solid var(--fy-border, #888); border-radius: 12px; box-sizing: border-box; height: 56px; padding: 16px; }
`;

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-chat-tail-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', 'fixtures/chat-tail-scene.tsx'],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the chat-tail scene did not build (${code}):\n${stderr}\n${stdout}`);
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

const box = async (tab: Page, selector: string): Promise<Box> =>
  await tab.evaluate((query: string) => {
    const element = document.querySelector(query);
    if (element === null) throw new Error(`nothing matches ${query}`);
    const { top, bottom, height } = element.getBoundingClientRect();
    return { top, bottom, height };
  }, selector);

const VIEWPORTS = [
  { name: 'phone', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 },
  { name: 'desktop', viewport: { width: 1_440, height: 900 }, deviceScaleFactor: 1 },
] as const;

const open = async (
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
  await tab.goto(`${origin}/?theme=studio-${scheme}${query}`);
  return { tab, close: async () => await context.close() };
};

describe('the chat at its tail', () => {
  for (const { name } of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`leaves at most one row between the last message and the composer (${name}, ${scheme})`, async () => {
        const { tab, close } = await open(name, scheme, '');
        try {
          await tab.waitForSelector('.fy-transcript-content > :last-child');
          await tab.waitForSelector('.scene-agenda-row');
          await framesSettled(tab);
          await tab.evaluate(() => {
            const scroller = document.querySelector('.fy-transcript') as HTMLElement;
            scroller.scrollTop = scroller.scrollHeight;
          });
          await framesSettled(tab);
          const gap = await tab.evaluate(() => {
            const last = document.querySelector('.fy-transcript-content > :last-child') as HTMLElement;
            const composer = document.querySelector('.scene-composer') as HTMLElement;
            const row = document.querySelector('.scene-agenda-row') as HTMLElement;
            return {
              gap: composer.getBoundingClientRect().top - last.getBoundingClientRect().bottom,
              row: row.getBoundingClientRect().height,
            };
          });
          // The agenda row is the one row of chrome there; the scroller's own padding and the composer's top padding
          // are the little air around it. Two rows (the old invisible Jump row beside it) is over this.
          expect(gap.gap).toBeLessThanOrEqual(gap.row + 28);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-chat-bottom.png`) });
        } finally {
          await close();
        }
      });

  for (const { name } of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      it(`leaves no band above the composer in a chat with no agenda (${name}, ${scheme})`, async () => {
        const { tab, close } = await open(name, scheme, '&agenda=0');
        try {
          await tab.waitForSelector('.fy-transcript-content > :last-child');
          await framesSettled(tab);
          await tab.evaluate(() => {
            const scroller = document.querySelector('.fy-transcript') as HTMLElement;
            scroller.scrollTop = scroller.scrollHeight;
          });
          await framesSettled(tab);
          const gap = await tab.evaluate(() => {
            const last = document.querySelector('.fy-transcript-content > :last-child') as HTMLElement;
            const composer = document.querySelector('.scene-composer') as HTMLElement;
            return composer.getBoundingClientRect().top - last.getBoundingClientRect().bottom;
          });
          // Only the scroller's own padding and the composer's top padding: less than one row of chrome.
          expect(gap).toBeLessThanOrEqual(40);
          expect(await tab.locator('.fy-jump-latest-shell').count()).toBe(0);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${name}-${scheme}-plain-chat-bottom.png`) });
        } finally {
          await close();
        }
      });

  it('draws the Jump pill in the agenda row without changing that row or the transcript', async () => {
    const { tab, close } = await open('phone', 'light', '');
    try {
      await tab.waitForSelector('.scene-agenda-row');
      await tab.waitForSelector('.fy-transcript-content > :last-child');
      await framesSettled(tab);
      const atTail = {
        row: await box(tab, '.scene-agenda-row'),
        scroller: await box(tab, '.fy-transcript'),
        pill: await tab.locator('.fy-jump-latest').count(),
      };
      expect(atTail.pill).toBe(0);
      const scroller = await tab.locator('.fy-transcript').boundingBox();
      if (scroller === null) throw new Error('no transcript on screen');
      await tab.mouse.move(scroller.x + scroller.width / 2, scroller.y + scroller.height / 2);
      await tab.mouse.wheel(0, -700);
      await tab.waitForSelector('.fy-jump-latest');
      await framesSettled(tab);
      const away = {
        row: await box(tab, '.scene-agenda-row'),
        scroller: await box(tab, '.fy-transcript'),
        pill: await box(tab, '.fy-jump-latest'),
      };
      // The pill is IN the agenda row, and neither the row nor the scroller moved a pixel for it.
      expect(away.row.height).toBe(atTail.row.height);
      expect(away.row.top).toBe(atTail.row.top);
      expect(away.scroller.height).toBe(atTail.scroller.height);
      expect(away.pill.top).toBeGreaterThanOrEqual(away.row.top - 1);
      expect(away.pill.bottom).toBeLessThanOrEqual(away.row.bottom + 1);
      // Jump on the left, the Agenda button on its right, and they do not overlap.
      const toggle = await box(tab, '.scene-agenda-row__main');
      const horizontal = await tab.evaluate(() => {
        const pill = (document.querySelector('.fy-jump-latest') as HTMLElement).getBoundingClientRect();
        const main = (document.querySelector('.scene-agenda-row__main') as HTMLElement).getBoundingClientRect();
        return { pillRight: pill.right, mainLeft: main.left };
      });
      expect(horizontal.pillRight).toBeLessThanOrEqual(horizontal.mainLeft + 1);
      expect(toggle.height).toBeGreaterThan(0);
      if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, 'phone-light-chat-away.png') });
    } finally {
      await close();
    }
  });

  it('never resizes anything while the reader scrolls down past the pill', async () => {
    const { tab, close } = await open('phone', 'dark', '&busy=1');
    try {
      await tab.waitForSelector('.scene-agenda-row');
      await tab.waitForSelector('.fy-transcript-content > :last-child');
      await framesSettled(tab);
      const scroller = await tab.locator('.fy-transcript').boundingBox();
      if (scroller === null) throw new Error('no transcript on screen');
      await tab.mouse.move(scroller.x + scroller.width / 2, scroller.y + scroller.height / 2);
      await tab.mouse.wheel(0, -700);
      await tab.waitForSelector('.fy-jump-latest');
      await framesSettled(tab);
      await tab.evaluate(() => {
        const element = document.querySelector('.fy-transcript') as HTMLElement;
        const row = document.querySelector('.scene-agenda-row') as HTMLElement;
        const samples: { height: number; row: number; top: number; pill: boolean }[] = [];
        let running = true;
        const tick = (): void => {
          if (!running) return;
          samples.push({
            height: element.clientHeight,
            row: row.getBoundingClientRect().height,
            top: element.scrollTop,
            pill: document.querySelector('.fy-jump-latest') !== null,
          });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        (window as unknown as { __stop: () => unknown }).__stop = () => {
          running = false;
          return samples;
        };
      });
      for (let step = 0; step < 40; step += 1) {
        await tab.mouse.wheel(0, 60);
        await tab.waitForTimeout(16);
      }
      await tab.waitForTimeout(800);
      const samples = (await tab.evaluate(() => (window as unknown as { __stop: () => unknown }).__stop())) as {
        height: number;
        row: number;
        top: number;
        pill: boolean;
      }[];
      expect(new Set(samples.map(sample => sample.height)).size).toBe(1);
      expect(new Set(samples.map(sample => sample.row)).size).toBe(1);
      const flips = samples.filter((sample, index) => index > 0 && sample.pill !== samples[index - 1]?.pill);
      expect(flips.length).toBeLessThanOrEqual(1);
      expect(samples.at(-1)?.pill).toBe(false);
    } finally {
      await close();
    }
  });
});
