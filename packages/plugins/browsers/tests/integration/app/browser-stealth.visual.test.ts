/**
 * The Stealth switch on the Browser tab, as a person sees it (docs/browser-mode.md, "Stealth"): off with the site-terms
 * note, off after turning it on (held for the owner), and on — at a phone and a desktop width, light and dark, with no
 * horizontal overflow at either. Set `FY_BROWSER_STEALTH_SHOTS_DIR` to keep the captures; every name in them is fake.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser, Page } from 'playwright-core';
import { checkSettingsScene, type ServedScene, serveScene, THEMES, VIEWPORTS } from '../../support/app/scene-page.ts';

setDefaultTimeout(60_000);
const shotsDir = process.env.FY_BROWSER_STEALTH_SHOTS_DIR ?? '';

let browser: Browser;
let served: ServedScene;

beforeAll(async () => {
  served = await serveScene(import.meta.dir, 'fixtures/browser-settings-scene.tsx', 'browser-stealth');
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  await served?.stop();
});

const SWITCH = '[data-setup-section="browser-stealth"] [role="switch"]';
const SCENES = [
  {
    scene: 'stealth',
    name: 'browser-stealth-off',
    visible: [SWITCH, '[data-browser-stealth-note]'],
    inspect: async (page: Page) => {
      expect(await page.getAttribute(SWITCH, 'aria-checked')).toBe('false');
    },
  },
  {
    scene: 'stealth',
    name: 'browser-stealth-held',
    visible: [SWITCH],
    inspect: async (page: Page) => {
      await page.click(SWITCH);
      await page.waitForSelector('[data-setup-note="browser-stealth-held"]', { state: 'visible' });
      expect(await page.getAttribute(SWITCH, 'aria-checked')).toBe('false');
    },
  },
  {
    scene: 'stealth-on',
    name: 'browser-stealth-on',
    visible: [SWITCH],
    inspect: async (page: Page) => {
      expect(await page.getAttribute(SWITCH, 'aria-checked')).toBe('true');
    },
  },
] as const;

describe('Browser stealth switch visual contract', () => {
  for (const one of SCENES)
    for (const viewport of VIEWPORTS)
      for (const theme of THEMES)
        it(`${one.name} ${viewport.name} ${theme}: draws without overflow`, async () => {
          const overflow = await checkSettingsScene(browser, {
            origin: served.origin,
            scene: one.scene,
            viewport,
            theme,
            visible: one.visible,
            inspect: one.inspect,
            shotsDir,
            name: one.name,
          });
          expect(overflow).toBeLessThanOrEqual(0);
        });
});
