/**
 * A PAGE THE AGENT OPENS IS SHOWN BY THE BROWSER PANEL, in a real browser.
 *
 * The scene (`fixtures/browser-show-page-scene.tsx`) is the real Browser panel over a fake daemon that keeps one page per viewer.
 * The panel starts on Preview's "Where to?". When the ferret page hands it a `show-page` intent, the panel goes to the real
 * browser and selects that page with THIS viewer's id (named by the daemon once the display stream is up): the page renders, and
 * a second viewer of the same ferret stays on its own page.
 *
 * Set `FY_SHOW_PAGE_SHOTS_DIR` to keep `show-page-<phase>-<viewport>-<mode>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser } from 'playwright-core';
import { type ServedScene, sceneContext, serveScene, VIEWPORTS } from '../../support/app/scene-page.ts';

setDefaultTimeout(60_000);
const shotsDir = process.env.FY_SHOW_PAGE_SHOTS_DIR ?? '';

let browser: Browser;
let served: ServedScene;

beforeAll(async () => {
  served = await serveScene(import.meta.dir, 'fixtures/browser-show-page-scene.tsx', 'browser-show-page');
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  await served?.stop();
});

describe('the Browser panel shows the page the agent opened', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const)
      it(`goes to the real browser, selects the page for its own viewer, and leaves the other viewer alone (${viewport.name}, ${mode})`, async () => {
        const context = await sceneContext(browser, served.origin, viewport, mode);
        try {
          const tab = await context.newPage();
          const problems: string[] = [];
          tab.on('pageerror', error => problems.push(error.message));
          await tab.goto(`${served.origin}/?theme=studio-${mode}`);
          await tab.getByText('Where to?').waitFor();
          const shoot = async (phase: string): Promise<void> => {
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `show-page-${phase}-${viewport.name}-${mode}.png`) });
          };
          await shoot('before');

          await tab.evaluate(() => window.__show('p2'));

          // The target page renders, in the real browser.
          await tab.locator('[data-shown-page="p2"]').waitFor();
          expect(await tab.getByRole('heading', { name: 'Invoice 88' }).count()).toBe(1);
          expect(await tab.getByText('Where to?').count()).toBe(0);
          expect(await tab.getByLabel('Shared remote browser').count()).toBe(1);
          await shoot('shown');

          // It was selected for THIS viewer, never before the daemon had named it...
          const acts = await tab.evaluate(() => window.__acts.filter(act => act.action === 'activate-page'));
          expect(acts.length).toBeGreaterThan(0);
          expect(acts.every(act => act.pageId === 'p2' && act.viewer === 'v1')).toBe(true);
          // ...so a second viewer of the same ferret is still on its page.
          expect(await tab.evaluate(() => window.__pageOf('v1'))).toBe('p2');
          expect(await tab.evaluate(() => window.__pageOf('other'))).toBe('p1');
          expect(problems).toEqual([]);
        } finally {
          await context.close();
        }
      });
});
