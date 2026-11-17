/**
 * The Browser tab and its "Test proxy" results, as a person sees them (docs/browser-proxy.md): the real tab with a saved
 * proxy and its status line LOADED over a scripted client (running via the proxy, stopped, running direct), the firewall
 * notes, the credential form refusing a raw value, then every state the test can show — busy, reachable (saved and
 * unsaved), each failure class, a refusal — at a phone and a desktop width, light and dark, with no horizontal overflow at
 * either. Set `FY_BROWSER_PROXY_SHOTS_DIR` to keep the captures (they are not committed); every name, address and secret
 * name in them is fake.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser, Page } from 'playwright-core';
import { checkSettingsScene, type ServedScene, serveScene, THEMES, VIEWPORTS } from '../../support/app/scene-page.ts';

setDefaultTimeout(60_000);
const shotsDir = process.env.FY_BROWSER_PROXY_SHOTS_DIR ?? '';

let browser: Browser;
let served: ServedScene;

beforeAll(async () => {
  served = await serveScene(import.meta.dir, 'fixtures/browser-settings-scene.tsx', 'browser-tab');
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  await served?.stop();
});

const RUNNING_VIA_PROXY = 'Running · via proxy http://proxy.example.test:8080 · signs in.';
const STATUS_WORDS = [
  RUNNING_VIA_PROXY,
  'Stopped · the next start goes via the saved proxy.',
  'Running · direct, no proxy.',
];

/** A raw credential typed into the expert fields, and Test proxy pressed: the form says why it will not run. */
const typeRawCredential = async (page: Page): Promise<void> => {
  await page.fill('[data-browser-proxy-url]', 'socks5://proxy.example.test:1080');
  await page.click('[data-browser-proxy-expert]');
  await page.fill('[data-browser-proxy-username]', 'amy.example');
  await page.fill('[data-browser-proxy-password]', 'correct-horse');
  await page.click('[data-browser-proxy-test]');
};

const SCENES = [
  {
    scene: 'tab',
    visible: ['[data-browser-state="running"]', '[data-setup-section="browser-proxy"]'],
    inspect: async (page: Page) => {
      expect(await page.locator('[data-browser-state]').first().textContent()).toBe(RUNNING_VIA_PROXY);
    },
  },
  {
    scene: 'status',
    visible: ['[data-browser-state="stopped"]'],
    inspect: async (page: Page) => {
      expect(await page.locator('[data-browser-state]').allTextContents()).toEqual(STATUS_WORDS);
    },
  },
  {
    scene: 'firewall',
    visible: ['[data-setup-note="browser-firewall"][data-tone="warn"]'],
    inspect: async (page: Page) => {
      expect(await page.locator('[data-setup-note="browser-firewall"]').count()).toBe(4);
    },
  },
  {
    scene: 'invalid',
    visible: ['[data-browser-proxy-url]'],
    inspect: async (page: Page) => {
      await typeRawCredential(page);
      await page.waitForSelector('[data-browser-proxy-test-refusal]', { state: 'visible' });
    },
  },
  { scene: 'proxy-test', visible: ['[data-setup-note="browser-proxy-test"]'], inspect: undefined },
] as const;

describe('Browser tab visual contract', () => {
  for (const one of SCENES)
    for (const viewport of VIEWPORTS)
      for (const theme of THEMES)
        it(`${one.scene} ${viewport.name} ${theme}: draws without overflow`, async () => {
          const overflow = await checkSettingsScene(browser, {
            origin: served.origin,
            scene: one.scene,
            viewport,
            theme,
            visible: one.visible,
            inspect: one.inspect,
            shotsDir,
            name: `browser-${one.scene}`,
          });
          expect(overflow).toBeLessThanOrEqual(0);
        });
});
