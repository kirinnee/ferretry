/**
 * EXAGGERATED MINIMALISM'S ENORMOUS TITLE NEVER PUSHES A REAL PAGE SIDEWAYS (r10 T14, review of #2160): the project page's
 * `<h1>` draws at the style's display size, and a project called `CustomerNotificationsService` is ONE unbroken word wider than
 * a phone (627px of heading in a 358px column at 390). It is judged on the REAL app and the REAL project page
 * (`fixtures/mobile-scene.tsx`, a fake machine with that one long-named project, `?longProject=1`), at 390 and 1280, light and
 * dark: the heading ends inside the screen, neither the page nor the page's own scroller is wider than its box, and the
 * word is broken across lines (the heading is taller than one line of it).
 *
 * Set `FY_EXAGGERATED_SHOTS_DIR` to keep `<width>-<mode>-long-title.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneServer, sharedChromium } from '../support/browser/index.ts';
import { LONG_NAME_PROJECT_ID } from './fixtures/mobile-fake-daemon.ts';

setDefaultTimeout(90_000);

const shotsDir = process.env.FY_EXAGGERATED_SHOTS_DIR ?? '';
const scene = new URL('./fixtures/mobile-scene.tsx', import.meta.url).pathname;

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

const WIDTHS = [
  { width: 390, height: 844, phone: true },
  { width: 1_280, height: 900, phone: false },
] as const;
const MODES = ['light', 'dark'] as const;

describe('the project page under Exaggerated Minimalism, named by one long unbroken word', () => {
  for (const { width, height, phone } of WIDTHS)
    for (const mode of MODES)
      it(`at ${width}, ${mode}: the heading wraps inside the screen and nothing scrolls sideways`, async () => {
        const context = await browser.newContext({
          viewport: { width, height },
          deviceScaleFactor: 2,
          hasTouch: phone,
          isMobile: phone,
          colorScheme: mode,
        });
        const tab = await context.newPage();
        tab.setDefaultTimeout(20_000);
        const problems: string[] = [];
        tab.on('pageerror', error => problems.push(error.message));
        try {
          await tab.goto(
            `${origin}/d/ws/projects/${LONG_NAME_PROJECT_ID}?style=exaggerated&palette=studio&mode=${mode}&longProject=1`,
          );
          try {
            await tab.waitForSelector(`[data-project-detail="${LONG_NAME_PROJECT_ID}"] h1`, { timeout: 30_000 });
          } catch (error) {
            throw new Error(`the project page did not draw: ${String(error)}\n${problems.join('\n')}`);
          }
          await tab.waitForTimeout(1_500);
          if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${width}-${mode}-long-title.png`) });
          const report = await tab.evaluate(() => {
            const page = document.querySelector<HTMLElement>('[data-project-detail]');
            const title = page?.querySelector<HTMLElement>('h1') ?? null;
            const box = title?.getBoundingClientRect();
            const style = title === null ? null : getComputedStyle(title);
            return {
              style: document.documentElement.dataset.style ?? '',
              text: title?.textContent ?? '',
              right: box?.right ?? Number.POSITIVE_INFINITY,
              height: box?.height ?? 0,
              lineHeight:
                Number.parseFloat(style?.lineHeight ?? '0') || Number.parseFloat(style?.fontSize ?? '0') * 1.2,
              page: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
              scroller: [page?.scrollWidth ?? 0, page?.clientWidth ?? 0],
            };
          });
          expect(report.style, 'the page wears Exaggerated Minimalism').toBe('exaggerated');
          expect(report.text).toBe('CustomerNotificationsService');
          expect(report.right, 'the heading ends inside the screen').toBeLessThanOrEqual(width);
          expect(report.page[0], 'the page is no wider than the screen').toBeLessThanOrEqual(report.page[1] ?? 0);
          expect(report.scroller[0], 'the page’s own scroller is no wider than its box').toBeLessThanOrEqual(
            report.scroller[1] ?? 0,
          );
          if (phone) expect(report.height, 'the one word breaks across lines').toBeGreaterThan(report.lineHeight * 1.5);
          expect(problems, 'the page threw').toEqual([]);
        } finally {
          await context.close();
        }
      });
});
