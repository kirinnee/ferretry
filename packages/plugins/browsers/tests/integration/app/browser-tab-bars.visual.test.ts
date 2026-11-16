/**
 * THE BROWSER SIDE TAB SPENDS ONE BAR (TWO ROWS AT MOST, ON A NARROW FRAME) ON META-INFORMATION, in a real browser.
 *
 * The scene (`fixtures/browser-tab-scene.tsx`) is the real page strip, surface header and remote pane over a fake
 * transport and display, in every state a person meets: idle, an agent driving, the owner holding the page, a hand-over
 * ask, a human-check page, a failed page, a lost display and a stopped browser. At a phone and a desktop width, light and
 * dark, nothing scrolls sideways and the page view starts within the bar budget.
 *
 * Set `FY_BROWSER_BARS_SHOTS_DIR` to keep `<FY_BROWSER_BARS_PREFIX>-<state>-<viewport>-<theme>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser, Page } from 'playwright-core';
import { type ServedScene, sceneContext, serveScene, THEMES, VIEWPORTS } from '../../support/app/scene-page.ts';

setDefaultTimeout(120_000);
const shotsDir = process.env.FY_BROWSER_BARS_SHOTS_DIR ?? '';
const prefix = process.env.FY_BROWSER_BARS_PREFIX ?? 'after';
const states = ['idle', 'driving', 'owner', 'ask', 'challenge', 'error', 'disconnected', 'stopped'] as const;

let browser: Browser;
let served: ServedScene;

beforeAll(async () => {
  served = await serveScene(import.meta.dir, 'fixtures/browser-tab-scene.tsx', 'browser-bars');
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  await served?.stop();
});

const pause = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));

interface Measure {
  readonly overflow: number;
  /** Where the page view (the streamed display) begins, below the top of the tab's frame. */
  readonly pageTop: number;
  readonly frameTop: number;
  readonly bars: number;
  readonly chips: readonly string[];
  /** Pieces of the old stacked chrome that must be gone. */
  readonly leftovers: readonly string[];
  /** Bar children that spill past the bar's own box (clipped or overlapping). */
  readonly spilled: readonly string[];
  readonly barHeight: number;
}

/** The chip each scene must show: the state a person has to be able to read at a glance. */
const expectedChip: Record<(typeof states)[number], readonly string[]> = {
  idle: ['live', 'connecting'],
  driving: ['agent'],
  owner: ['owner'],
  ask: ['ask'],
  challenge: ['challenge'],
  error: ['error'],
  disconnected: ['disconnected'],
  stopped: ['stopped'],
};

describe('the browser side tab spends one bar on meta-information', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      it(`${viewport.name} ${theme}: every state fits its bar budget without sideways scroll`, async () => {
        const context = await sceneContext(browser, served.origin, viewport, theme);
        const shot = async (name: string, tab: Page): Promise<void> => {
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${prefix}-${name}-${viewport.name}-${theme}.png`) });
        };
        try {
          for (const state of states) {
            const tab = await context.newPage();
            await tab.goto(`${served.origin}/?theme=studio-${theme}&state=${state}`);
            await tab.waitForSelector('[data-workspace-browser]');
            await tab.waitForSelector('[aria-label="Shared remote browser"]');
            await pause(400);
            const measure = await tab.evaluate<Measure>(`(() => {
              const frame = document.querySelector('[data-workspace-browser]');
              const screen = document.querySelector('.fy-remote-browser') ?? document.querySelector('[aria-label="Shared remote browser"] > div:last-of-type');
              const frameTop = frame.getBoundingClientRect().top;
              const bars = [...frame.querySelectorAll('[data-browser-bar]')];
              const barBox = bars[0]?.getBoundingClientRect();
              const spilled = bars[0] === undefined ? ['no bar'] : [...bars[0].querySelectorAll('[data-browser-bar-part]')]
                .filter(part => { const r = part.getBoundingClientRect(); return r.width > 0 && (r.right > barBox.right + 0.5 || r.left < barBox.left - 0.5); })
                .map(part => part.getAttribute('data-browser-bar-part'));
              const leftovers = ['[data-browser-pages]', '[data-browser-status-row]', '[role="tablist"]', '[data-browser-challenge]:not([data-browser-chip-detail] *)', '.fy-ws-pages', '.fy-ws-bar', '.fy-ws-marker']
                .filter(selector => frame.querySelector(selector) !== null);
              return {
                overflow: document.documentElement.scrollWidth - window.innerWidth,
                pageTop: screen.getBoundingClientRect().top,
                frameTop,
                bars: bars.length,
                barHeight: barBox?.height ?? 0,
                chips: [...frame.querySelectorAll('[data-browser-chip]')].map(chip => chip.getAttribute('data-browser-chip')),
                leftovers,
                spilled,
              };
            })()`);
            expect(measure.overflow).toBeLessThanOrEqual(0);
            expect(measure.bars).toBe(1);
            expect(measure.leftovers).toEqual([]);
            expect(measure.spilled).toEqual([]);
            expect(measure.chips).toHaveLength(1);
            expect(expectedChip[state]).toContain(measure.chips[0] as string);
            // The bar folds by its frame's width (`browser.css`): one row on a desktop (≤ 56px), two on a phone (the address
            // takes a row of its own, ≤ 104px). On a phone the field that types into the page sits under it.
            const phone = viewport.name === 'phone';
            expect(measure.barHeight).toBeLessThanOrEqual(phone ? 104 : 56);
            expect(measure.pageTop - measure.frameTop).toBeLessThanOrEqual(phone ? 168 : 72);
            await shot(state, tab);
            if (state === 'challenge' || state === 'ask' || state === 'error') {
              await tab.click('[data-browser-chip]');
              await tab.waitForSelector('[data-browser-chip-detail]');
              const detail = await tab.evaluate<{ readonly text: string; readonly inside: boolean }>(`(() => {
                const node = document.querySelector('[data-browser-chip-detail]');
                const box = node.getBoundingClientRect();
                return { text: node.textContent ?? '', inside: box.left >= 0 && box.right <= window.innerWidth };
              })()`);
              expect(detail.inside).toBe(true);
              expect(detail.text.length).toBeGreaterThan(10);
              await shot(`${state}-detail`, tab);
            }
            if (state === 'driving') {
              await tab.click('[aria-label="Browser controls"]');
              await tab.waitForSelector('[data-browser-menu]');
              const inside = await tab.evaluate<boolean>(
                `(() => { const box = document.querySelector('[data-browser-menu]').getBoundingClientRect(); return box.left >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight; })()`,
              );
              expect(inside).toBe(true);
              await shot('menu', tab);
            }
            if (state === 'idle') {
              await tab.click('[data-browser-bar-part="page"]');
              await tab.waitForSelector('[data-browser-pages]');
              await shot('pages', tab);
            }
            await tab.close();
          }
        } finally {
          await context.close();
        }
      });
});
