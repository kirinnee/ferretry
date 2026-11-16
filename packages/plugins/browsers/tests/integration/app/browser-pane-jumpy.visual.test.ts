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
import { type ServedScene, sceneContext, serveScene, type Viewport, VIEWPORTS } from '../../support/app/scene-page.ts';

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
