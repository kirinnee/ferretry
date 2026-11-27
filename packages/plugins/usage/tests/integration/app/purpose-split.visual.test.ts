/**
 * W-09: THE "BY PURPOSE" PANEL ON INSIGHTS, in a real browser over the fake machine (`mobile-scene.tsx`, no daemon) at a
 * phone and a desktop width, light and dark, in the default style (Studio) and the roundest ones (Gen Z, Neumorphism).
 *
 * The panel lists every purpose a ferret was started for plus "Unlabelled" for the ones that named none, each with its
 * session count, so the groups account for every session; it stays inside the page and round-safe in every look.
 *
 * Set `FY_VB4_SHOTS_DIR` to keep `<style>-<width>-<scheme>.png` of the panel.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { describeRoundMisses, roundSafeMisses, sceneServer, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(120_000);

const scene = new URL('../../../../../app/tests/integration/fixtures/mobile-scene.tsx', import.meta.url).pathname;
const shotsDir = process.env.FY_VB4_SHOTS_DIR ?? '';

let browser: Browser;
let server: ReturnType<typeof Bun.spawn> | undefined;
let origin = '';

beforeAll(async () => {
  browser = await sharedChromium();
  server = Bun.spawn([process.execPath, sceneServer, '--entry', scene], { stderr: 'inherit', stdout: 'pipe' });
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
  const first = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the scene server did not start')), 90_000)),
  ]);
  origin = (JSON.parse(new TextDecoder().decode(first.value).trim().split('\n')[0] as string) as { origin: string })
    .origin;
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 120_000);

afterAll(() => {
  server?.kill();
});

const LOOKS = [
  { style: 'studio', palette: 'studio' },
  { style: 'genz', palette: 'vaporwave' },
  { style: 'neumorphism', palette: 'afterglow' },
] as const;
const WIDTHS = [
  { width: 390, height: 844, phone: true },
  { width: 1440, height: 1000, phone: false },
] as const;

for (const look of LOOKS) {
  for (const size of WIDTHS) {
    for (const scheme of ['light', 'dark'] as const) {
      describe(`insights by purpose: ${look.style} ${size.width} ${scheme}`, () => {
        it('lists every purpose and Unlabelled, inside the page and round-safe', async () => {
          const context = await browser.newContext({
            viewport: { width: size.width, height: size.height },
            deviceScaleFactor: 2,
            hasTouch: size.phone,
            isMobile: size.phone,
            colorScheme: scheme,
            timezoneId: 'America/Los_Angeles',
            locale: 'en-US',
            reducedMotion: 'reduce',
          });
          try {
            const page = await context.newPage();
            await page.goto(
              `${origin}/d/ws/insights?theme=${look.palette}-${scheme}&style=${look.style}&palette=${look.palette}&mode=${scheme}`,
            );
            const panel = page.locator('[data-analytics-split="purpose"]');
            await panel.waitFor({ timeout: 30_000 });
            await page.evaluate(async () => await document.fonts.ready);
            await page.waitForFunction(
              () =>
                (document.querySelector('[data-analytics-split="purpose"]') as HTMLElement | null)?.innerText.includes(
                  'implementation',
                ),
              undefined,
              { timeout: 30_000 },
            );
            const text = (await panel.innerText()).toLowerCase();
            expect(text).toContain('by purpose');
            for (const word of ['implementation', 'review', 'comms', 'planning', 'other', 'unlabelled'])
              expect(text, `the panel names ${word}`).toContain(word);
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
              'the page does not scroll sideways',
            ).toBeLessThanOrEqual(0);
            const misses = await roundSafeMisses(page);
            expect(misses, describeRoundMisses(misses)).toEqual([]);
            if (shotsDir !== '') {
              await panel.scrollIntoViewIfNeeded();
              await panel.screenshot({ path: join(shotsDir, `${look.style}-${size.width}-${scheme}.png`) });
            }
          } finally {
            await context.close();
          }
        });
      });
    }
  }
}
