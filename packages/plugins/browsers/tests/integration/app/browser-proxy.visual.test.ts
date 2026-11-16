/**
 * Browser proxy, as a person sees it (docs/browser-proxy.md): the Machine tab's "Browser proxy" section with a
 * saved proxy, and the "via proxy" chip on the browser pane's status bar — at a phone and a desktop width,
 * light and dark, with no horizontal overflow at either. Set `FY_BROWSER_PROXY_SHOTS_DIR` to keep the
 * captures; every name and address in them is fake.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser } from 'playwright-core';
import { checkSettingsScene, type ServedScene, serveScene, THEMES, VIEWPORTS } from '../../support/app/scene-page.ts';

setDefaultTimeout(60_000);
const shotsDir = process.env.FY_BROWSER_PROXY_SHOTS_DIR ?? '';

let browser: Browser;
let served: ServedScene;

beforeAll(async () => {
  served = await serveScene(import.meta.dir, 'fixtures/browser-settings-scene.tsx', 'browser-proxy');
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  await served?.stop();
});

describe('Browser proxy visual contract', () => {
  for (const viewport of VIEWPORTS)
    for (const theme of THEMES)
      it(`${viewport.name} ${theme}: shows the section and the via-proxy chip without overflow`, async () => {
        const overflow = await checkSettingsScene(browser, {
          origin: served.origin,
          scene: 'proxy',
          viewport,
          theme,
          visible: ['[data-setup-section="browser-proxy"]', '[data-browser-proxy-chip]'],
          shotsDir,
          name: 'browser-proxy',
        });
        expect(overflow).toBeLessThanOrEqual(0);
      });
});
