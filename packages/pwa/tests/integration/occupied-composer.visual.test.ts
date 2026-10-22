/**
 * THE OCCUPIED-COMPOSER NOTICE IN A REAL BROWSER — a send the daemon refused because the agent's own
 * message box already held the person's unsent text, and the one tap that gets the person's new
 * message through.
 *
 * WHY THIS TIER. The bug was a person stranded: a red sentence naming a session id and a terminal
 * remedy, and every later send refused the same way. What has to be true is a journey — the refusal is
 * a notice with two buttons, a tap acts on exactly the quoted text, and the person's own message is then
 * sent without being typed again — so it is driven end to end in Chromium, on the shipped `Composer` and
 * the app's whole stylesheet (see `composer-editor.visual.test.ts` for how the scene is built).
 *
 * IT IS ALSO THE EVIDENCE DRIVER. Set `COMPOSER_EVIDENCE_DIR` to an absolute directory outside the
 * repository and the last journey writes the notice at desktop and phone width, light and dark.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';
import { type ComposerSceneServer, serveComposerScene } from './support/composer-scene.ts';

const evidenceDir = process.env.COMPOSER_EVIDENCE_DIR ?? null;

const DESKTOP = { viewport: { width: 1_440, height: 900 } } as const;
const PHONE = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
} as const;

/** What the person had typed straight into the agent's terminal and never sent. */
const STUCK = 'can you also check why the login test is flaky on CI before you push';
const NOTICE = '[data-occupied-composer]';

let browser: Browser;
let server: ComposerSceneServer;

beforeAll(async () => {
  server = await serveComposerScene();
  browser = await sharedChromium();
}, 180_000);

afterAll(async () => {
  await server?.stop();
});

const open = async (theme: string, phone = false) => {
  const context = await browser.newContext(phone ? PHONE : DESKTOP);
  const page = await context.newPage();
  await page.route(/^(?!http:\/\/127\.0\.0\.1:)/u, route => route.abort());
  await page.route(/\/v1\//u, route => route.abort());
  const query = new URLSearchParams({
    editor: 'off',
    theme,
    occupied: STUCK,
    draft: 'ship the fix',
    ...(phone ? { compact: '1' } : {}),
  });
  await page.goto(`${server.url}?${query.toString()}`);
  await page.waitForSelector('[data-composer-send]');
  return { page, close: () => context.close() };
};

/** Sends what is in the box and waits for the refusal's notice. */
const refused = async (page: Page): Promise<void> => {
  await page.locator('[data-composer-send]').click();
  await page.waitForSelector(NOTICE);
};

const recorded = (page: Page, name: '__sent' | '__drafts') =>
  page.evaluate(key => (window as unknown as Record<string, unknown[]>)[key], name);

describe('a send refused because the agent’s box holds the person’s unsent text', () => {
  test('shows a plain notice quoting the text, with no session id and no red error', async () => {
    const scene = await open('studio-light');
    try {
      await refused(scene.page);

      const notice = scene.page.locator(NOTICE);
      await expect(notice.textContent()).resolves.toContain('already has text that wasn’t sent');
      await expect(notice.textContent()).resolves.toContain(STUCK.slice(0, 40));
      await expect(notice.textContent()).resolves.not.toContain('scene-session');
      expect(await scene.page.locator('.fy-composer-error').count()).toBe(0);
      expect(await notice.locator('[data-occupied-action]').allTextContents()).toEqual(['Send it', 'Clear it']);
      // The person's own message is kept, not lost to the refusal.
      expect(await scene.page.locator('.fy-composer textarea').inputValue()).toBe('ship the fix');
    } finally {
      await scene.close();
    }
  }, 60_000);

  test('Send it presses Enter on exactly that text, then sends the person’s message by itself', async () => {
    const scene = await open('studio-light');
    try {
      await refused(scene.page);

      await scene.page.locator('[data-occupied-action="submit"]').click();
      await scene.page.waitForSelector(NOTICE, { state: 'detached' });

      expect(await recorded(scene.page, '__drafts')).toEqual([{ action: 'submit', draft: STUCK }]);
      expect(await recorded(scene.page, '__sent')).toMatchObject([{ message: 'ship the fix' }]);
      expect(await scene.page.locator('.fy-composer textarea').inputValue()).toBe('');
    } finally {
      await scene.close();
    }
  }, 60_000);

  test('Clear it erases exactly that text, then sends the person’s message by itself', async () => {
    const scene = await open('studio-dark', true);
    try {
      await refused(scene.page);

      await scene.page.locator('[data-occupied-action="clear"]').tap();
      await scene.page.waitForSelector(NOTICE, { state: 'detached' });

      expect(await recorded(scene.page, '__drafts')).toEqual([{ action: 'clear', draft: STUCK }]);
      expect(await recorded(scene.page, '__sent')).toMatchObject([{ message: 'ship the fix' }]);
    } finally {
      await scene.close();
    }
  }, 60_000);

  test('evidence: the notice at desktop and phone width, light and dark', async () => {
    if (evidenceDir === null) return;
    await mkdir(evidenceDir, { recursive: true });
    for (const theme of ['studio-light', 'studio-dark'])
      for (const phone of [false, true]) {
        const scene = await open(theme, phone);
        try {
          await refused(scene.page);
          await scene.page.waitForTimeout(50);
          await scene.page
            .locator('.fy-composer')
            .screenshot({ path: join(evidenceDir, `occupied-composer-${theme}-${phone ? 'phone' : 'desktop'}.png`) });
        } finally {
          await scene.close();
        }
      }
  }, 180_000);
});
