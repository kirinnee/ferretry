/**
 * THE SHARED-BROWSER PANE DOES NOT JUMP WHEN THE BROWSER STARTS AND STOPS WORKING, in a real browser.
 *
 * The scene (`fixtures/browser-pane-jumpy-scene.tsx`) is the real surface header, status row and controls over a
 * stand-in page view. The page toggles the busy and loading facts the way the daemon does and samples the page view's and
 * the toolbar's top edge on every animation frame: across a long run of flips the edge must never move, a blip of work
 * must never show a label, and sustained work must show one and take it back only after a pause.
 *
 * Set `FY_BROWSER_JUMPY_SHOTS_DIR` to keep `browser-<state>-<viewport>.png` for review. Without it no file is written.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser, Page } from 'playwright-core';
import {
  type ServedScene,
  sceneContext,
  serveScene,
  THEMES,
  type Viewport,
  VIEWPORTS,
} from '../../support/app/scene-page.ts';

setDefaultTimeout(60_000);
const shotsDir = process.env.FY_BROWSER_JUMPY_SHOTS_DIR ?? '';

let browser: Browser;
let served: ServedScene;

beforeAll(async () => {
  served = await serveScene(import.meta.dir, 'fixtures/browser-pane-jumpy-scene.tsx', 'browser-jumpy');
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  await served?.stop();
});

const ACTIVITY = '[data-browser-activity]';
const PROGRESS = '[data-browser-progress]';

const activityText = async (tab: Page): Promise<string> => (await tab.locator(ACTIVITY).textContent()) ?? '';
const pause = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));

/** The distinct top edges the page view and the toolbar have had since the scene loaded. */
const edges = async (tab: Page): Promise<{ page: number[]; controls: number[] }> =>
  await tab.evaluate(() => ({
    page: [...new Set(window.__tops.page.map(top => Math.round(top * 100) / 100))],
    controls: [...new Set(window.__tops.controls.map(top => Math.round(top * 100) / 100))],
  }));

const shoot = async (tab: Page, state: string, viewport: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `browser-${state}-${viewport}.png`) });
};

const labelIs = (tab: Page, label: string, timeout: number): Promise<unknown> =>
  tab.waitForFunction(
    ([selector, want]) => document.querySelector(selector as string)?.textContent === want,
    [ACTIVITY, label],
    { timeout },
  );

const check = async (viewport: Viewport): Promise<void> => {
  const context = await sceneContext(browser, served.origin, viewport, 'light');
  try {
    const tab = await context.newPage();
    await tab.goto(`${served.origin}/?theme=studio-light`);
    await tab.waitForSelector('[data-page-view]');
    await tab.waitForSelector(ACTIVITY, { state: 'attached' });
    await tab.waitForSelector(PROGRESS, { state: 'attached' });
    await tab.evaluate(() => {
      window.__tops = { page: [], controls: [] };
    });
    await pause(100);
    await shoot(tab, 'idle', viewport.name);

    // A blip shorter than the show delay is never announced.
    await tab.evaluate(() => window.__setBusy(true));
    await pause(120);
    await tab.evaluate(() => window.__setBusy(false));
    await pause(500);
    expect(await activityText(tab)).toBe('');

    // Sustained work shows the label once the delay has passed...
    await tab.evaluate(() => window.__setBusy(true));
    await labelIs(tab, 'Working…', 2_000);
    await pause(300);
    await shoot(tab, 'working', viewport.name);

    // ...and keeps it through a short pause (the hide delay), so work in bursts reads as one run.
    await tab.evaluate(() => window.__setBusy(false));
    await pause(300);
    expect(await activityText(tab)).toBe('Working…');
    await labelIs(tab, '', 3_000);

    // A long flicker: busy and loading flipping faster than either delay, then a loading page.
    for (let flip = 0; flip < 12; flip += 1) {
      await tab.evaluate(
        on => {
          window.__setBusy(on);
          window.__setLoading(on);
        },
        flip % 2 === 0,
      );
      await pause(90);
    }
    await tab.evaluate(() => {
      window.__setBusy(false);
      window.__setLoading(true);
    });
    await labelIs(tab, 'Loading page…', 2_000);
    await pause(300);
    await shoot(tab, 'loading', viewport.name);
    await tab.evaluate(() => window.__setLoading(false));
    await labelIs(tab, '', 3_000);

    const seen = await edges(tab);
    expect(seen.page).toHaveLength(1);
    expect(seen.controls).toHaveLength(1);

    const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const rowFits = await tab.evaluate(() => {
      const row = document.querySelector<HTMLElement>('[data-browser-status-row]');
      return row !== null && row.scrollWidth <= row.clientWidth + 1;
    });
    expect(rowFits || viewport.name === 'phone').toBe(true);
  } finally {
    await context.close();
  }
};

describe('the browser pane holds still while the browser works', () => {
  for (const viewport of VIEWPORTS)
    it(`never moves the page view or the toolbar as busy and loading flip (${viewport.name})`, async () => {
      await check(viewport);
    });
});

/** The status row's worst case: nobody has driven the browser and the display link is down (the longest words it speaks). */
const WORST = 'actor=none&connection=disconnected';

describe('the status row stays readable at its longest', () => {
  for (const viewport of VIEWPORTS)
    for (const family of ['studio', 'genz', 'neumorphism'] as const)
      for (const theme of THEMES)
        it(`shows every word of the row whole, nothing clipped or collapsed (${viewport.name}, ${family}, ${theme})`, async () => {
          const context = await sceneContext(browser, served.origin, viewport, theme);
          try {
            const tab = await context.newPage();
            await tab.goto(`${served.origin}/?theme=${family}-${theme}&${WORST}`);
            await tab.waitForSelector('[data-browser-status-row]');
            const cut = await tab.evaluate(() => {
              const row = document.querySelector<HTMLElement>('[data-browser-status-row]') as HTMLElement;
              const edge = row.getBoundingClientRect().right;
              return (
                [...row.children]
                  .map(each => each as HTMLElement)
                  // A word is cut when its text is wider than its box (truncated), or when its box is pushed past the row.
                  .filter(
                    each =>
                      each.textContent !== '' &&
                      (each.scrollWidth > each.clientWidth + 1 || each.getBoundingClientRect().right > edge + 0.5),
                  )
                  .map(each => each.textContent)
              );
            });
            expect(cut).toEqual([]);
            const chip = await tab.evaluate(() => {
              const node = [...document.querySelectorAll<HTMLElement>('[data-browser-status-row] > *')].find(
                each => each.textContent === 'No input yet',
              );
              return node === undefined ? 0 : node.getBoundingClientRect().width;
            });
            // The chip keeps room for its words (it used to collapse to an empty circle).
            expect(chip).toBeGreaterThan(60);
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `browser-worst-${family}-${viewport.name}-${theme}.png`) });
          } finally {
            await context.close();
          }
        });
});

/** Every word the row speaks, at the phone widths people really hold (320 is the narrowest), at the Larger text size. */
const NARROW = [320, 390, 430] as const;
/** The two states that speak the longest labels: the display link down, and a page loading over a down link. */
const LONGEST = {
  disconnected: WORST,
  loading: `${WORST}&loading=1`,
} as const;

/**
 * The words the row cut, read from the TEXT itself rather than from the row's children: every text node must sit whole inside
 * the row and inside every box between it and the row that clips (a truncating label, a chip). A label may wrap onto a second
 * line; it may never be clipped, ellipsised or pushed out of the row.
 */
const cutWords = (tab: Page): Promise<string[]> =>
  tab.evaluate(() => {
    const row = document.querySelector<HTMLElement>('[data-browser-status-row]') as HTMLElement;
    const cut: string[] = [];
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = (node.textContent ?? '').trim();
      if (text === '') continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const word = range.getBoundingClientRect();
      for (let box = node.parentElement; box !== null && box !== row.parentElement; box = box.parentElement) {
        const style = getComputedStyle(box);
        const clips = style.overflowX !== 'visible' || style.overflowY !== 'visible';
        if (!clips) continue;
        const edge = box.getBoundingClientRect();
        const outside =
          word.right > edge.right + 0.5 ||
          word.left < edge.left - 0.5 ||
          word.bottom > edge.bottom + 0.5 ||
          word.top < edge.top - 0.5 ||
          box.scrollWidth > box.clientWidth + 1;
        if (outside) {
          cut.push(text);
          break;
        }
      }
    }
    return cut;
  });

describe('the status row stays whole at the Larger text size on a phone', () => {
  for (const width of NARROW)
    for (const family of ['studio', 'genz', 'neumorphism'] as const)
      for (const [state, query] of Object.entries(LONGEST))
        it(`cuts no word of a nested label (${width}px, ${family}, ${state})`, async () => {
          const context = await sceneContext(browser, served.origin, { width, height: 844 }, 'light');
          try {
            const tab = await context.newPage();
            await tab.goto(`${served.origin}/?theme=${family}-light&text=larger&${query}`);
            await tab.waitForSelector('[data-browser-status-row]');
            if (state === 'loading') await labelIs(tab, 'Loading page…', 3_000);
            await pause(200);
            expect(await cutWords(tab)).toEqual([]);
            // The label's slot is held: it speaking and falling silent leaves the row as tall as it was and the toolbar the same
            // distance beneath it. (The row, not the bar above it: that bar's own state chip is not this row's business.)
            const rowShape = (): Promise<{ height: number; gap: number }> =>
              tab.evaluate(() => {
                const row = (
                  document.querySelector('[data-browser-status-row]') as HTMLElement
                ).getBoundingClientRect();
                const controls = (document.querySelector('[data-controls]') as HTMLElement).getBoundingClientRect();
                return {
                  height: Math.round(row.height * 100) / 100,
                  gap: Math.round((controls.top - row.bottom) * 100) / 100,
                };
              });
            const before = await rowShape();
            await tab.evaluate(on => window.__setLoading(on), state !== 'loading');
            await labelIs(tab, state === 'loading' ? '' : 'Loading page…', 3_000);
            await pause(200);
            expect(await rowShape()).toEqual(before);
            const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            expect(overflow).toBeLessThanOrEqual(0);
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `browser-larger-${state}-${family}-${width}.png`) });
          } finally {
            await context.close();
          }
        });
});
