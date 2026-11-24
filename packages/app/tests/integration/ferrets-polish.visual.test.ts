/**
 * THE FERRETS PLUGIN'S POLISH (B3 rows L291e, L281c, E36), in a real browser over the REAL app and its REAL ferret list
 * (`fixtures/mobile-scene.tsx`: every shipped plugin's own app half), on a fake machine only (no daemon, no network).
 *
 *  - "+ New ferret" is a button the width of its words at a finger's height, not a bar across the whole drawer;
 *  - the open Mine | All | Agents filter shows ONE selected cue (the shared neutral fill, ordinary text), and the keyboard's
 *    ring is kept for the keyboard;
 *  - Info › Project names the project the machine registered, never its id.
 *
 * Set `FY_B3_SHOTS_DIR` to keep `<viewport>-<mode>-<name>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { sceneServer, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(90_000);

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
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 200_000);

afterAll(() => server?.kill());

const VIEWPORTS = [
  { name: '1440', width: 1_440, height: 900, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

describe('the drawer’s ferret list', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const)
      it(`${viewport.name} ${mode}: + New ferret hugs its words at a finger's height, and the selected filter has one cue`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: mode,
          deviceScaleFactor: viewport.phone ? 2 : 1,
          hasTouch: viewport.phone,
          isMobile: viewport.phone,
        });
        const tab = await context.newPage();
        tab.setDefaultTimeout(30_000);
        try {
          await tab.goto(`${origin}/d/ws/board?theme=studio-${mode}`);
          if (viewport.phone) {
            await tab.click('button[aria-label="Menu"]');
            await tab.waitForSelector('.fy-drawer--overlay');
          }
          await tab.waitForSelector('.fy-drawer [data-ferret-new]');
          await tab.waitForSelector('.fy-drawer [data-sbar-filter][aria-pressed="true"]');
          await tab.waitForTimeout(800);
          const read = await tab.evaluate(() => {
            const colour = (property: 'color' | 'background', value: string): string => {
              const probe = document.createElement('span');
              probe.style[property] = value;
              document.body.append(probe);
              const resolved = getComputedStyle(probe)[property === 'color' ? 'color' : 'backgroundColor'];
              probe.remove();
              return resolved;
            };
            const button = document.querySelector<HTMLElement>('.fy-drawer [data-ferret-new]') as HTMLElement;
            const footer = button.parentElement as HTMLElement;
            const footerStyle = getComputedStyle(footer);
            const room =
              footer.getBoundingClientRect().width -
              Number.parseFloat(footerStyle.paddingLeft) -
              Number.parseFloat(footerStyle.paddingRight);
            const box = button.getBoundingClientRect();
            const on = getComputedStyle(
              document.querySelector('.fy-drawer [data-sbar-filter][aria-pressed="true"]') as Element,
            );
            const off = getComputedStyle(
              document.querySelector('.fy-drawer [data-sbar-filter][aria-pressed="false"]') as Element,
            );
            return {
              room,
              width: box.width,
              height: box.height,
              fill: colour('background', 'var(--select-fill)'),
              ink: colour('color', 'var(--fg)'),
              onBackground: on.backgroundColor,
              onBorder: on.borderTopColor,
              onInk: on.color,
              onWeight: on.fontWeight,
              offWeight: off.fontWeight,
              onOutline: on.outlineStyle,
            };
          });
          expect(read.height, 'a finger-sized target').toBeGreaterThanOrEqual(44);
          expect(read.width, 'the button is its words, not the whole footer').toBeLessThan(read.room - 40);
          expect(read.onBackground, 'the shared selected fill').toBe(read.fill);
          expect(read.onBorder, 'no accent edge on top of the fill').toBe('rgba(0, 0, 0, 0)');
          expect(read.onInk, 'the ordinary text colour, not an accent').toBe(read.ink);
          expect(read.onWeight, 'regular weight, like the others').toBe(read.offWeight);
          expect(read.onOutline, 'no ring until the keyboard is on it').toBe('none');
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${mode}-drawer-list.png`) });

          // The keyboard still gets its ring on the selected filter.
          await tab.locator('.fy-drawer [data-sbar-filter][aria-pressed="true"]').focus();
          await tab.keyboard.press('Shift+Tab');
          await tab.keyboard.press('Tab');
          const ring = await tab.evaluate(() => {
            const style = getComputedStyle(document.activeElement as Element);
            return {
              onFilter: document.activeElement?.hasAttribute('data-sbar-filter') ?? false,
              style: style.outlineStyle,
              width: Number.parseFloat(style.outlineWidth),
            };
          });
          expect(ring.onFilter, 'the keyboard is on a filter').toBe(true);
          expect(ring.style, 'the keyboard ring is drawn').not.toBe('none');
          expect(ring.width).toBeGreaterThan(0);
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${mode}-drawer-focus.png`) });
        } finally {
          await context.close();
        }
      });
});

const PROJECT_ID = '9f3c2a54-7b1e-4d6a-9c11-2f8e77d3b901';

describe('Info › Project', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const)
      it(`${viewport.name} ${mode}: names the registered project, not its id`, async () => {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: mode,
          deviceScaleFactor: viewport.phone ? 2 : 1,
          hasTouch: viewport.phone,
          isMobile: viewport.phone,
        });
        const tab = await context.newPage();
        tab.setDefaultTimeout(30_000);
        try {
          await tab.goto(`${origin}/d/ws/ferrets/zoe/chat?project=1&theme=studio-${mode}`);
          await tab.getByRole('button', { name: 'Modes' }).click();
          await tab.locator('[data-info-toggle]').click();
          const row = tab.locator('[data-info-row="Project"] dd');
          await row.waitFor();
          // The project's name arrives from the machine's list; wait for it rather than for a fixed time.
          await tab
            .waitForFunction(
              () => document.querySelector('[data-info-row="Project"] dd')?.textContent?.includes('lighthouse-billing'),
              undefined,
              { timeout: 8_000 },
            )
            .catch(() => undefined);
          const text = (await row.textContent()) ?? '';
          expect(text, 'the project the machine registered').toContain('lighthouse-billing');
          expect(text, 'not its id').not.toContain(PROJECT_ID);
          if (shotsDir !== '') {
            // A phone's sheet opens half-height: bring the row into the shot.
            await row.scrollIntoViewIfNeeded();
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${mode}-info-project.png`) });
          }
        } finally {
          await context.close();
        }
      });
});
