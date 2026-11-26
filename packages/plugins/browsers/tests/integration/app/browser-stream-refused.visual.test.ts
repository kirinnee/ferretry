/**
 * A DISPLAY REFUSED FOR WANT OF THE PASSKEY OFFERS THE PRESS THAT ANSWERS IT (G18 D-87), in a real browser. The real
 * `RemoteBrowserViewer` (`fixtures/browser-stream-refused-scene.tsx`, a fake refused socket, no daemon) at a phone (390) and a
 * desktop (1440), light and dark, in the default look (Studio) and the two roundest (Gen Z, Neumorphism): "Retry display" and
 * "Confirm with passkey" are both on screen, nothing scrolls sideways, no content leaves the inner rounded rectangle of the box
 * it sits in (`round-safe.ts`), and pressing the confirmation asks for a fresh stream.
 *
 * Set `FY_BROWSER_STREAM_REFUSED_SHOTS_DIR` to keep `<look>-<viewport>-<scheme>.png` (they are not committed).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describeRoundMisses, roundSafeMisses, sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser } from 'playwright-core';
import { type ServedScene, serveScene } from '../../support/app/scene-page.ts';

setDefaultTimeout(120_000);
const shotsDir = process.env.FY_BROWSER_STREAM_REFUSED_SHOTS_DIR ?? '';

let browser: Browser;
let served: ServedScene;

beforeAll(async () => {
  served = await serveScene(import.meta.dir, 'fixtures/browser-stream-refused-scene.tsx', 'browser-stream-refused');
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  await served?.stop();
});

const LOOKS = [
  { style: 'studio', palette: 'studio' },
  { style: 'genz', palette: 'vaporwave' },
  { style: 'neumorphism', palette: 'afterglow' },
] as const;
const VIEWPORTS = [
  { name: '390', width: 390, height: 844, phone: true },
  { name: '1440', width: 1_440, height: 900, phone: false },
] as const;

for (const look of LOOKS) {
  for (const viewport of VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      describe(`refused display: ${look.style} ${viewport.name} ${scheme}`, () => {
        it('offers Retry display and Confirm with passkey, round-safe, and the press asks for a fresh stream', async () => {
          const context = await browser.newContext({
            viewport: { width: viewport.width, height: viewport.height },
            deviceScaleFactor: viewport.phone ? 2 : 1,
            hasTouch: viewport.phone,
            isMobile: viewport.phone,
            colorScheme: scheme,
            reducedMotion: 'reduce',
          });
          try {
            await context.route('**/*', async route =>
              new URL(route.request().url()).origin === served.origin ? await route.continue() : await route.abort(),
            );
            const page = await context.newPage();
            await page.goto(`${served.origin}/?theme=${look.palette}-${scheme}`);
            await page.evaluate(style => document.documentElement.setAttribute('data-style', style), look.style);
            await page.waitForSelector('[data-remote-browser-confirm]');
            await page.evaluate(async () => await document.fonts.ready);
            await page.waitForTimeout(300);

            const words = await page.locator('.fy-remote-browser-error').textContent();
            expect(words ?? '').toContain('the daemon refused this stream: 403');
            expect(await page.getByRole('button', { name: 'Retry display' }).isVisible()).toBe(true);
            expect(await page.getByRole('button', { name: 'Confirm with passkey' }).isVisible()).toBe(true);
            const overflow = await page.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            );
            expect(overflow).toBeLessThanOrEqual(0);
            if (shotsDir !== '')
              await page.screenshot({
                path: join(shotsDir, `${look.style}-${viewport.name}-${scheme}.png`),
                fullPage: true,
              });
            const misses = await roundSafeMisses(page);
            expect(misses, `\n${describeRoundMisses(misses)}`).toEqual([]);

            const before = await page.evaluate(() => window.__streams);
            await page.getByRole('button', { name: 'Confirm with passkey' }).click();
            await page.waitForFunction(count => window.__streams > count, before);
            expect(await page.evaluate(() => window.__confirmed)).toBe(1);
          } finally {
            await context.close();
          }
        });
      });
    }
  }
}
