/**
 * THE INSIGHTS "MEASURE" AND "PERIOD" CONTROLS AT A PHONE (owner ask &B210, PR 2559 re-check). The real Insights page in a real
 * browser over the fake machine (`mobile-scene.tsx`, no daemon) at 390 wide, light and dark:
 *
 *  - in the DEFAULT look (Studio) the four Measure segments (Cost, Tokens, Turns, Active time) stay on ONE row: round-safe
 *    padding must not push "Active time" onto a second row and the chart 48px down;
 *  - in the ROUNDEST looks (Gen Z, Neumorphism) the segments may wrap, but every one stays inside the box that holds them;
 *  - the Period segments (7d, 14d, 30d) keep their words (nothing cut) in every look.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import type { Browser } from 'playwright-core';
import { sceneServer, sharedChromium } from '@ferretry/app/testing/browser';

setDefaultTimeout(120_000);

const scene = new URL('../../../../../app/tests/integration/fixtures/mobile-scene.tsx', import.meta.url).pathname;

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
}, 120_000);

afterAll(() => {
  server?.kill();
});

const LOOKS = [
  { style: 'studio', palette: 'studio', oneRow: true },
  { style: 'genz', palette: 'vaporwave', oneRow: false },
  { style: 'neumorphism', palette: 'afterglow', oneRow: false },
] as const;

for (const look of LOOKS) {
  for (const scheme of ['light', 'dark'] as const) {
    describe(`insights controls: ${look.style} 390 ${scheme}`, () => {
      it(
        look.oneRow ? 'the Measure segments stay on one row' : 'the Measure segments stay inside their box',
        async () => {
          const context = await browser.newContext({
            viewport: { width: 390, height: 844 },
            deviceScaleFactor: 2,
            hasTouch: true,
            isMobile: true,
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
            await page.waitForSelector('[data-segmented="analytics-metric"]', { timeout: 30_000 });
            await page.evaluate(async () => await document.fonts.ready);
            const read = await page.evaluate(() => {
              const box = (
                document.querySelector('[data-segmented="analytics-metric"]') as HTMLElement
              ).getBoundingClientRect();
              const segments = Array.from(
                document.querySelectorAll('[data-segmented="analytics-metric"] button'),
                button => button.getBoundingClientRect(),
              );
              const period = Array.from(
                document.querySelectorAll('[data-segmented="analytics-range"] button'),
                button => ({ cut: button.scrollWidth - button.clientWidth }),
              );
              return {
                rows: new Set(segments.map(s => Math.round(s.top))).size,
                names: segments.length,
                inside: segments.every(
                  s =>
                    s.left >= box.left - 1 &&
                    s.right <= box.right + 1 &&
                    s.top >= box.top - 1 &&
                    s.bottom <= box.bottom + 1,
                ),
                period,
                sideways: document.documentElement.scrollWidth - window.innerWidth,
              };
            });
            expect(read.names).toBe(4);
            if (look.oneRow) expect(read.rows, 'Cost, Tokens, Turns and Active time share one row').toBe(1);
            expect(read.inside, 'every segment is inside the control that holds it').toBe(true);
            expect(
              read.period.every(p => p.cut <= 0),
              'the Period words are not cut',
            ).toBe(true);
            expect(read.sideways, 'the page does not scroll sideways').toBeLessThanOrEqual(0);
          } finally {
            await context.close();
          }
        },
      );
    });
  }
}
