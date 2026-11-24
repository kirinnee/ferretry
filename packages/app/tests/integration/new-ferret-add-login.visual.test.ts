/**
 * "Add a login" on New ferret (a machine with no runtime yet) lands on the REAL Logins settings tab — not on the page that
 * says "There is no settings tab called ...". In a real browser, over the REAL app and its real settings tabs, on a fake
 * machine only (no daemon, no network).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneServer, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(120_000);

/** Set `FY_B3_SHOTS_DIR` to keep `<viewport>-<case>-<mode>.png` of the Runtime well. */
const shotsDir = process.env.FY_B3_SHOTS_DIR ?? '';

const appScene = new URL('./fixtures/mobile-scene.tsx', import.meta.url).pathname;
let browser: Browser;
let server: { kill: () => void } | undefined;
let origin = '';

beforeAll(async () => {
  browser = await sharedChromium();
  const child = Bun.spawn([process.execPath, sceneServer, '--entry', appScene], { stderr: 'inherit', stdout: 'pipe' });
  server = child;
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const first = await reader.read();
  origin = (JSON.parse(new TextDecoder().decode(first.value).trim().split('\n')[0] as string) as { origin: string })
    .origin;
}, 200_000);

afterAll(() => server?.kill());

describe('New ferret › Add a login', () => {
  for (const viewport of [
    { name: '1440', width: 1_440, height: 900, phone: false },
    { name: '390', width: 390, height: 844, phone: true },
  ] as const)
    it(`opens the Logins tab of this machine's settings at ${viewport.name}`, async () => {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        hasTouch: viewport.phone,
        isMobile: viewport.phone,
      });
      const tab = await context.newPage();
      tab.setDefaultTimeout(30_000);
      try {
        await tab.goto(`${origin}/d/ws/new?noRuntimes=1&theme=studio-light`);
        await tab.getByRole('button', { name: 'Add a login' }).click();
        await tab.waitForURL(/\/settings\//u);
        // The Settings page draws the tab, or says there is no such tab; it must be the tab.
        await tab.locator('.fy-page, .fy-main').first().waitFor({ state: 'visible' });
        await tab.waitForTimeout(800);
        const body = (await tab.locator('body').innerText()).replace(/\s+/gu, ' ');
        expect(body, 'the address names a tab that does not exist').not.toContain('There is no settings tab called');
        expect(new URL(tab.url()).pathname).toBe('/d/ws/settings/logins/logins');
        expect(body, 'the Logins tab is what opened').toContain('Logins');
      } finally {
        await context.close();
      }
    });
});

describe('New ferret › the Runtime well', () => {
  for (const viewport of [
    { name: '1440', width: 1_440, height: 900, phone: false },
    { name: '390', width: 390, height: 844, phone: true },
  ] as const)
    for (const [label, query] of [
      ['a short roster', ''],
      ['no runtime yet', '&noRuntimes=1'],
    ] as const)
      it(`fits what it holds, with no empty band under it, for ${label} at ${viewport.name}`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          hasTouch: viewport.phone,
          isMobile: viewport.phone,
        });
        const tab = await context.newPage();
        tab.setDefaultTimeout(30_000);
        try {
          await tab.goto(`${origin}/d/ws/new?theme=studio-light${query}`);
          await tab.locator('[data-runtime-slot]').waitFor({ state: 'visible' });
          await tab.locator('[data-new-ferret-form="drawn"]').waitFor();
          await tab.waitForTimeout(500);
          if (shotsDir !== '') {
            await mkdir(shotsDir, { recursive: true });
            await tab.screenshot({
              path: join(shotsDir, `${viewport.name}-runtime-well-${label.replaceAll(' ', '-')}-light.png`),
              fullPage: true,
            });
          }
          const gap = await tab.evaluate(() => {
            const well = document.querySelector<HTMLElement>('[data-runtime-slot]') as HTMLElement;
            const box = well.getBoundingClientRect();
            const inner = [...well.querySelectorAll<HTMLElement>('*')].filter(node => node.offsetHeight > 0);
            const lowest = Math.max(...inner.map(node => node.getBoundingClientRect().bottom));
            return { below: box.bottom - lowest, height: box.height };
          });
          // Its own 8 px padding (and a border) is all the room under the last line; a reserved block would be far more.
          expect(
            gap.below,
            `a ${Math.round(gap.below)} px empty band under the last thing in the well`,
          ).toBeLessThanOrEqual(12);
        } finally {
          await context.close();
        }
      });
});
