/**
 * SETTINGS › BROWSER › IDENTITIES in a real browser. The real Browser tab (`fixtures/browser-identities-settings-scene.tsx`, a
 * scripted client, synthetic identities and proxy names, no network): the daemon's identities (one running with a proxy of its
 * own, one stopped, one never opened), the one the owner has yet to confirm, and the add form — with a bad name typed, so the
 * problem line and the disabled button are drawn too. At a phone (390) and a desktop (1440), light and dark, in the default look
 * (Studio), Studio with every radius at its highest, and Gen Z: nothing scrolls sideways and no content leaves the inner rounded
 * rectangle of the box it sits in (`round-safe.ts`).
 *
 * Set `FY_BROWSER_IDENTITIES_SETTINGS_SHOTS_DIR` to keep `<look>-<viewport>-<scheme>.png` (they are not committed).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describeRoundMisses, roundSafeMisses, sharedChromium } from '@ferretry/app/testing/browser';
import type { Browser } from 'playwright-core';
import { type ServedScene, serveScene } from '../../support/app/scene-page.ts';

setDefaultTimeout(120_000);
const shotsDir = process.env.FY_BROWSER_IDENTITIES_SETTINGS_SHOTS_DIR ?? '';

let browser: Browser;
let served: ServedScene;

beforeAll(async () => {
  served = await serveScene(
    import.meta.dir,
    'fixtures/browser-identities-settings-scene.tsx',
    'browser-identities-settings',
  );
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
  { name: '390', width: 390, height: 2400, phone: true },
  { name: '1440', width: 1_440, height: 1500, phone: false },
] as const;

for (const look of LOOKS)
  for (const viewport of VIEWPORTS)
    for (const scheme of ['light', 'dark'] as const)
      describe(`identities settings: ${look.name} ${viewport.name} ${scheme}`, () => {
        it('draws every identity and the add form, round-safe, with nothing scrolling sideways', async () => {
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
            await page.waitForSelector('[data-browser-identities] [data-browser-identity]');
            await page.evaluate(async () => await document.fonts.ready);
            await page.waitForTimeout(300);

            const listed = await page
              .locator('[data-browser-identity]')
              .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-browser-identity')));
            expect(listed).toEqual(['agent', 'work', 'docs', 'partner']);
            expect(await page.locator('[data-browser-identity-waits]').textContent()).toContain('Waits for you');
            expect(await page.locator('[data-browser-identity="work"]').textContent()).toContain(
              'Via work-proxy.example.test:8080',
            );
            // A bad name: the problem is said under the field and Add stays off.
            await page.locator('[data-browser-identity-key]').fill('Bad Name');
            await page.waitForSelector('[data-browser-identity-problem]');
            expect(await page.locator('[data-browser-identity-submit]').isDisabled()).toBe(true);
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
