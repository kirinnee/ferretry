/**
 * NOTHING A PERSON TYPES OVER ONE IDENTITY'S PAGE LANDS IN ANOTHER'S, in a real browser. One display stream is handed from a
 * page of identity `agent` to a page of identity `work` (`fixtures/browser-identity-switch-scene.tsx`: the real viewer, a fake
 * stream, synthetic pages). The new page's first frame has ARRIVED, but its image request is held, so the previous page is
 * still what the person sees: pointer and keyboard input in that gap must reach nothing; once the new frame has painted, input
 * names the new page.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser, Page } from 'playwright-core';
import { type ServedScene, serveScene } from '../../support/app/scene-page.ts';

setDefaultTimeout(120_000);

let browser: Browser;
let served: ServedScene;

beforeAll(async () => {
  served = await serveScene(import.meta.dir, 'fixtures/browser-identity-switch-scene.tsx', 'browser-identity-switch');
  browser = await sharedChromium();
}, 180_000);

afterAll(async () => {
  await served?.stop();
});

/** A frame the size of the display (400 x 300): a real image for the browser to load and paint. */
const FRAME =
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#789"/></svg>';

const sentCount = async (page: Page): Promise<number> =>
  await page.evaluate(() => (window as unknown as { fixture: { sent: unknown[] } }).fixture.sent.length);
const sentPages = async (page: Page): Promise<unknown[]> =>
  await page.evaluate(() =>
    (window as unknown as { fixture: { sent: { pageId?: string }[] } }).fixture.sent.map(message => message.pageId),
  );
const painted = async (page: Page): Promise<boolean> =>
  await page.evaluate(() => {
    const image = document.querySelector<HTMLImageElement>('img[alt="Live remote browser frame"]');
    return image?.complete === true && image.naturalWidth > 0;
  });

describe('a display handed from one identity’s page to another’s', () => {
  it('sends no input to the new page until its frame is painted, then names it', async () => {
    // Arrange
    const context = await browser.newContext({ viewport: { width: 700, height: 600 } });
    try {
      let release: () => void = () => undefined;
      const held = new Promise<void>(resolve => {
        release = resolve;
      });
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== served.origin) return await route.abort();
        if (url.pathname === '/frames/a.svg') return await route.fulfill({ body: FRAME, contentType: 'image/svg+xml' });
        if (url.pathname === '/frames/b.svg') {
          await held;
          return await route.fulfill({ body: FRAME, contentType: 'image/svg+xml' });
        }
        return await route.continue();
      });
      const page = await context.newPage();
      await page.goto(`${served.origin}/`);
      await page.waitForSelector('.fy-remote-browser-canvas', { state: 'attached' });
      await page.evaluate(() =>
        (window as unknown as { fixture: { frame(p: string, n: string): void } }).fixture.frame('p1', 'a'),
      );
      await page.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>('img[alt="Live remote browser frame"]');
        return image?.complete === true && image.naturalWidth > 0;
      });
      const box = (await page.locator('.fy-remote-browser-canvas').boundingBox()) ?? { x: 0, y: 0 };
      const at = { x: box.x + 40, y: box.y + 40 };
      await page.mouse.click(at.x, at.y);
      const whileA = await sentPages(page);

      // Act — the session moves to the other identity's page; its first frame arrives but its image is held
      await page.evaluate(() => (window as unknown as { fixture: { show(p: string): void } }).fixture.show('work-p1'));
      // The status commits before the first frame of the new page arrives, as it does on the wire.
      await page.evaluate(
        async () => await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      await page.evaluate(() =>
        (window as unknown as { fixture: { frame(p: string, n: string): void } }).fixture.frame('work-p1', 'b'),
      );
      await page.waitForSelector('.fy-remote-browser-input', { state: 'attached' });
      const arrivedNotPainted = !(await painted(page));
      const before = await sentCount(page);
      await page.mouse.click(at.x, at.y);
      await page.locator('.fy-remote-browser-sink').focus();
      await page.keyboard.type('hello');
      await page.waitForTimeout(150);
      const during = await sentCount(page);
      release();
      await page.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>('img[alt="Live remote browser frame"]');
        return image?.complete === true && image.naturalWidth > 0;
      });
      await page.mouse.click(at.x, at.y);
      const after = await sentPages(page);

      // Assert — the held image was really unpainted, nothing was sent in the gap, and input after painting names the new page
      expect(whileA.length).toBeGreaterThan(0);
      expect(new Set(whileA)).toEqual(new Set(['p1']));
      expect(arrivedNotPainted).toBe(true);
      expect(during).toBe(before);
      expect(after.length).toBeGreaterThan(before);
      expect(new Set(after.slice(before))).toEqual(new Set(['work-p1']));
    } finally {
      await context.close();
    }
  });
});
