/**
 * GLASSMORPHISM, in the real engine: WHERE the blur is drawn, and that the OS "reduce transparency" setting turns every
 * glass surface opaque. The blur belongs to group surfaces and what floats; a repeated row (a list item, an article, a
 * panel inside a panel: Lessons rows, Catalogs member rows, voice log entries) keeps the translucent paint but never blurs.
 * `prefers-reduced-transparency: reduce` is emulated through the DevTools protocol (Playwright has no switch for it).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { join } from 'node:path';
import type { CDPSession, Page } from 'playwright-core';
import { sharedChromium } from '../support/browser/index.ts';
import { readCssWithImports, readThemeCss, themeStylesDir } from '../../src/testing/theme-css.ts';

setDefaultTimeout(60_000);

const MARKUP = `
<section class="kt-panel" id="group"><ul id="rows"><li class="kt-panel" id="row">row</li></ul>
  <article class="kt-panel" id="nested">entry</article></section>
<article class="kt-panel" id="loose-article">entry</article>
<div class="kt-panel" id="dialog" role="dialog" aria-modal="true">dialog</div>
<div class="kt-popover" id="menu">menu</div>
<div class="kt-sheet kt-panel" id="sheet">sheet</div>`;

const paint = (page: Page, id: string) =>
  page.evaluate((target: string) => {
    const style = getComputedStyle(document.getElementById(target) as HTMLElement);
    const bg = style.backgroundColor;
    const alpha = /(?:rgba\(.*,|\/)\s*([\d.]+)\)$/.exec(bg)?.[1];
    return { blur: style.backdropFilter, alpha: alpha === undefined ? 1 : Number(alpha) };
  }, id);

let page: Page;
let cdp: CDPSession;
beforeAll(async () => {
  const browser = await sharedChromium();
  const context = await browser.newContext();
  page = await context.newPage();
  cdp = await context.newCDPSession(page);
  const design = readCssWithImports(join(themeStylesDir, '../ui/design-system.css'));
  await page.setContent(
    `<!doctype html><html data-style="glass" data-palette="studio" data-mode="light"><head><style>${readThemeCss()}\n${design}</style></head><body>${MARKUP}</body></html>`,
  );
}, 120_000);

afterAll(async () => {
  await page.context().close();
});

const setReduced = (value: 'reduce' | 'no-preference') =>
  cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value }] });

describe('glassmorphism blur scope', () => {
  for (const mode of ['light', 'dark']) {
    it(`${mode}: blurs a group surface and what floats, never a repeated row`, async () => {
      await setReduced('no-preference');
      await page.evaluate((tone: string) => document.documentElement.setAttribute('data-mode', tone), mode);
      for (const id of ['group', 'dialog', 'menu', 'sheet']) expect((await paint(page, id)).blur).toContain('blur(');
      for (const id of ['row', 'nested', 'loose-article']) {
        const { blur } = await paint(page, id);
        // A row is nested, or is a list item / article: no blur. (`loose-article` is a lone article: also a row.)
        expect([id, blur]).toEqual([id, 'none']);
      }
      expect((await paint(page, 'row')).alpha).toBeLessThan(1);
    });

    it(`${mode}: reduce transparency makes every surface opaque with no blur`, async () => {
      await setReduced('reduce');
      expect(await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches)).toBe(true);
      await page.evaluate((tone: string) => document.documentElement.setAttribute('data-mode', tone), mode);
      for (const id of ['group', 'row', 'nested', 'loose-article', 'dialog', 'menu', 'sheet']) {
        const now = await paint(page, id);
        expect([id, now.blur, now.alpha]).toEqual([id, 'none', 1]);
      }
      await setReduced('no-preference');
    });
  }
});
