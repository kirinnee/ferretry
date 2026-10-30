/**
 * THE MODEL AND EFFORT SWITCHER ON A PHONE, IN A REAL BROWSER (#525).
 *
 * The owner, on an Android phone: tapping "claude-opus-5-5 ⌃" or "default ⌃" under the composer did
 * nothing. The cause was not the sheet. Every send that starts a turn stores `promptReady: false`, and
 * nothing writes it back when the turn ends — the daemon's turn watcher owns `turnState` and leaves
 * `promptReady` alone. The chips read only the stored `false`, so after the first message of a session
 * they were disabled for good, and a disabled button on a phone has no tooltip to say why.
 * `isPromptKnownBusy` (runtime-controls.tsx) now reads `turnState` first.
 *
 * WHY THIS TIER. A disabled button and an off-screen sheet both look like "nothing happened", and only a
 * real engine with a real tap can tell the reader's two complaints apart: here the chip is TAPPED with a
 * touch context, the sheet's box is measured against the 390×844 viewport, and the choice inside it
 * really sends. The scene is the shipped `Composer`, `ComposerRuntime` and `RuntimeModelControls`, with
 * `busy` from the same predicate `SessionChatPage` hands them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { sharedChromium } from './support/chromium.ts';
import { type ComposerSceneServer, serveComposerScene } from './support/composer-scene.ts';

const PHONE = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
} as const;

let browser: Browser;
let server: ComposerSceneServer;

beforeAll(async () => {
  server = await serveComposerScene();
  browser = await sharedChromium();
}, 180_000);

afterAll(async () => {
  await server?.stop();
});

const open = async (turn: 'your-turn' | 'working'): Promise<{ context: BrowserContext; page: Page }> => {
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  await page.route(/^(?!http:\/\/127\.0\.0\.1:)/u, route => route.abort());
  await page.goto(`${server.url}?compact=1&runtime=${turn}`);
  await page.waitForSelector('.fy-composer__runtime');
  return { context, page };
};

/** The open bottom sheet's box, or null when none is showing. */
const openSheet = (page: Page) =>
  page.evaluate(() => {
    const dialog = [...document.querySelectorAll<HTMLElement>('[data-bottom-sheet] [role="dialog"]')].find(
      element => element.getAttribute('aria-labelledby') !== null || element.getAttribute('aria-label') !== null,
    );
    if (dialog === undefined) return null;
    const box = dialog.getBoundingClientRect();
    return {
      top: box.top,
      bottom: box.bottom,
      left: box.left,
      right: box.right,
      visibility: getComputedStyle(dialog).visibility,
      text: dialog.textContent ?? '',
    };
  });

describe('the composer runtime chips on a phone', () => {
  test('after a turn has ended, tapping the model chip opens its sheet on screen and a choice sends', async () => {
    const { context, page } = await open('your-turn');
    try {
      const chip = page.locator('.fy-composer__runtime').first();
      expect(await chip.isDisabled()).toBe(false);
      await chip.tap();
      await page.waitForFunction(() => document.querySelector('[data-bottom-sheet] [role="dialog"]') !== null);
      await page.getByRole('menuitemradio', { name: /Sonnet 5/u }).waitFor({ state: 'visible' });
      // The sheet slides up over 200ms from a transform set on the frame AFTER it mounts, so wait for that
      // target first: `getAnimations()` is empty until the transition has started, and waiting on it alone
      // measured the sheet still parked below the phone (bottom 1220 of 844) whenever that frame was late.
      await page.waitForFunction(() =>
        [...document.querySelectorAll<HTMLElement>('[data-bottom-sheet] [role="dialog"]')].some(
          dialog => dialog.style.transform === 'translateY(0)',
        ),
      );
      await page.evaluate(async () => {
        await Promise.all(document.getAnimations().map(animation => animation.finished));
      });
      const sheet = await openSheet(page);
      expect(sheet).not.toBeNull();
      if (sheet === null) return;
      expect(sheet.visibility).toBe('visible');
      // Inside the phone, not opened off-screen.
      expect(sheet.top).toBeGreaterThanOrEqual(0);
      expect(sheet.bottom).toBeLessThanOrEqual(844 + 0.5);
      expect(sheet.left).toBeGreaterThanOrEqual(-0.5);
      expect(sheet.right).toBeLessThanOrEqual(390 + 0.5);
      expect(sheet.text).toContain('Switch model');
      await page.getByRole('menuitemradio', { name: /Sonnet 5/u }).tap();
      await page.waitForFunction(() => (window as unknown as { __runtime: unknown[] }).__runtime.length > 0);
      const sent = await page.evaluate(() => JSON.stringify((window as unknown as { __runtime: unknown[] }).__runtime));
      expect(sent).toContain('claude-sonnet-5');
    } finally {
      await context.close();
    }
  }, 60_000);

  test('while the agent is working the chips stay closed, because a switch can only land at a prompt', async () => {
    const { context, page } = await open('working');
    try {
      const chip = page.locator('.fy-composer__runtime').first();
      expect(await chip.isDisabled()).toBe(true);
      await chip.tap({ force: true });
      await page.waitForTimeout(200);
      expect(await openSheet(page)).toBeNull();
    } finally {
      await context.close();
    }
  }, 60_000);
});
