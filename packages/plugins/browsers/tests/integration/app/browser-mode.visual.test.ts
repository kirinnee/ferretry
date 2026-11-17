/**
 * Browser mode, as a person sees it (docs/browser-mode.md): the Machine tab's "Browser mode" section and the
 * strip the browser pane shows over a page that appears to be asking for a human check — at a phone and a
 * desktop width, light and dark, with no horizontal overflow at either. Set `FY_BROWSER_MODE_SHOTS_DIR` to
 * keep the captures; every name in them is fake.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser } from 'playwright-core';
import { checkSettingsScene, type ServedScene, serveScene, THEMES, VIEWPORTS } from '../../support/app/scene-page.ts';

setDefaultTimeout(60_000);
const shotsDir = process.env.FY_BROWSER_MODE_SHOTS_DIR ?? '';

let browser: Browser;
let served: ServedScene;

beforeAll(async () => {
  served = await serveScene(import.meta.dir, 'fixtures/browser-settings-scene.tsx', 'browser-mode');
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  await served?.stop();
});

describe('Browser mode visual contract', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      it(`${viewport.name} ${theme}: shows the section and the human-check strip without overflow`, async () => {
        const overflow = await checkSettingsScene(browser, {
          origin: served.origin,
          scene: 'mode',
          viewport,
          theme,
          visible: ['[data-setup-section="browser-mode"]', '[data-browser-challenge="cloudflare"]'],
          shotsDir,
          name: 'browser-mode',
        });
        expect(overflow).toBeLessThanOrEqual(0);
      });
});
