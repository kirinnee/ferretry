/**
 * THE BROWSER SIDE PANEL NAMES THE IDENTITY OF EACH PAGE, in a real browser. The real page strip, header and remote pane
 * (`fixtures/browser-identities-scene.tsx`, a fake transport and display, synthetic sites, no network) with pages in two
 * identities (`agent` and `work`), at a phone (390) and a desktop (1440), light and dark, in the default look (Studio), Studio with
 * every radius at its highest, and Gen Z: each page's chip says which Chrome it is in, nothing scrolls sideways, and no content
 * leaves the inner rounded rectangle of the box it sits in (`round-safe.ts`).
 *
 * Set `FY_BROWSER_IDENTITIES_SHOTS_DIR` to keep `<look>-<viewport>-<scheme>.png` (they are not committed).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describeRoundMisses, roundSafeMisses, sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser } from 'playwright-core';
import { type ServedScene, serveScene } from '../../support/app/scene-page.ts';

setDefaultTimeout(120_000);
const shotsDir = process.env.FY_BROWSER_IDENTITIES_SHOTS_DIR ?? '';

let browser: Browser;
let served: ServedScene;

beforeAll(async () => {
  served = await serveScene(import.meta.dir, 'fixtures/browser-identities-scene.tsx', 'browser-identities');
  browser = await sharedChromium();
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  await served?.stop();
});

/** Every radius token at the roundest a style can ask for: the highest rounding, whatever the style. */
const HIGHEST_ROUNDING = [
  '--radius-xs',
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
  '--radius-control',
  '--radius-panel',
  '--radius-badge',
  '--radius-tab',
  '--radius-input',
];

const LOOKS = [
  { name: 'studio', style: 'studio', palette: 'studio', highest: false },
  { name: 'studio-highest', style: 'studio', palette: 'studio', highest: true },
  { name: 'genz', style: 'genz', palette: 'vaporwave', highest: false },
] as const;
const VIEWPORTS = [
  { name: '390', width: 390, height: 844, phone: true },
  { name: '1440', width: 1_440, height: 900, phone: false },
] as const;

for (const look of LOOKS)
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      describe(`identity chips: ${look.name} ${viewport.name} ${scheme}`, () => {
        it('names the identity on every page of the list, round-safe, with nothing scrolling sideways', async () => {
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
            await page.evaluate(
              ({ style, highest, tokens }) => {
                document.documentElement.setAttribute('data-style', style);
                if (highest)
                  for (const token of tokens) document.documentElement.style.setProperty(token, 'var(--radius-round)');
              },
              { style: look.style, highest: look.highest, tokens: HIGHEST_ROUNDING },
            );
            await page.waitForSelector('[data-workspace-browser]');
            await page.waitForSelector('[aria-label="Shared remote browser"]');
            await page.locator('[data-browser-trigger="pages"]').click();
            await page.waitForSelector('[data-browser-identity]');
            await page.evaluate(async () => await document.fonts.ready);
            await page.waitForTimeout(300);

            const chips = await page
              .locator('[data-browser-identity]')
              .evaluateAll(nodes =>
                nodes.map(node => [
                  node.getAttribute('data-browser-identity'),
                  node.closest('[data-browser-page]')?.getAttribute('data-browser-page'),
                ]),
              );
            expect(chips).toEqual([
              ['agent', 'p1'],
              ['work', 'work-p1'],
              ['work', 'work-p2'],
            ]);
            const overflow = await page.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            );
            expect(overflow).toBeLessThanOrEqual(0);
            if (shotsDir !== '')
              await page.screenshot({
                path: join(shotsDir, `${look.name}-${viewport.name}-${scheme}.png`),
                fullPage: true,
              });
            const misses = await roundSafeMisses(page);
            expect(misses, `\n${describeRoundMisses(misses)}`).toEqual([]);
          } finally {
            await context.close();
          }
        });
      });
