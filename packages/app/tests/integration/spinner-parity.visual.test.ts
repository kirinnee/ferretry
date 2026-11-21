/**
 * THE REAL BUSY MARK, drawn by the real stylesheet, in the real engine. `theme-parity` proves the token declarations; this
 * proves the drawing: the shared `.fy-spinner` rules, its turn / pulse keyframes, the reduced-motion answer and the
 * on-accent state all live in `ui/spinner.css`, and a stylesheet that kept the tokens but lost them leaves an arc with
 * `stroke: none` and `animation: none` (the r10 T1 regression). So this renders the actual `<Spinner>` markup under
 * `themes.css` + `spinner.css` and reads the computed style back, for the real ring styles in both modes (Geist draws four spokes instead, asserted in style-kit-studio-geist).
 */
import { beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Page } from 'playwright-core';
import { sharedChromium } from '../support/browser/index.ts';
import { readCssWithImports, readThemeCss, themeStylesDir } from '../../src/testing/theme-css.ts';
import { Spinner } from '../../src/ui/spinner.tsx';

setDefaultTimeout(60_000);

/** What each style draws, from the busy mark's own table (stroke, cap, sweep, one turn, easing, ticked track). */
const HAND = {
  studio: {
    stroke: '2px',
    cap: 'round',
    sweep: '32px, 100px',
    speed: '0.9s',
    timing: 'cubic-bezier(0.45, 0.15, 0.55, 0.85)',
    dash: 'none',
  },
  // Mission, HUD, Neo and Raw draw their own marks from the generic parts (corner brackets; a radar; a hopping square; a jumping corner marker): `mission-hud-kit.visual.test.ts`, `neo-raw-kit.visual.test.ts`.
} as const;

const read = (page: Page, style: string, mode: string) =>
  page.evaluate(
    ([styleId, tone]) => {
      const root = document.documentElement;
      root.setAttribute('data-style', styleId as string);
      root.setAttribute('data-palette', styleId as string);
      root.setAttribute('data-mode', tone as string);
      const svg = document.querySelector('.fy-spinner') as SVGElement;
      const arc = svg.querySelector('.fy-spinner-arc') as SVGElement;
      const track = svg.querySelector('.fy-spinner-track') as SVGElement;
      const [spin, arcStyle, trackStyle] = [svg, arc, track].map(element => getComputedStyle(element));
      return {
        animationName: spin?.animationName,
        animationDuration: spin?.animationDuration,
        animationTimingFunction: spin?.animationTimingFunction,
        animationIterationCount: spin?.animationIterationCount,
        arcStroke: arcStyle?.stroke,
        arcWidth: arcStyle?.strokeWidth,
        arcCap: arcStyle?.strokeLinecap,
        arcDash: arcStyle?.strokeDasharray,
        trackStroke: trackStyle?.stroke,
        trackDash: trackStyle?.strokeDasharray,
        filter: spin?.filter,
      };
    },
    [style, mode] as const,
  );

let page: Page;
beforeAll(async () => {
  const browser = await sharedChromium();
  page = await (await browser.newContext()).newPage();
  const spinnerCss = readCssWithImports(join(themeStylesDir, '../ui/spinner.css'));
  const markup = renderToStaticMarkup(createElement(Spinner, {}));
  const onAccent = renderToStaticMarkup(createElement(Spinner, { className: 'fy-spinner--on-accent' }));
  await page.setContent(
    `<!doctype html><html><head><style>${readThemeCss()}\n${spinnerCss}</style></head><body>${markup}<div id="accent">${onAccent}</div></body></html>`,
  );
}, 120_000);

describe('the real spinner under the real stylesheet', () => {
  for (const [style, hand] of Object.entries(HAND)) {
    for (const mode of ['light', 'dark']) {
      it(`${style}-${mode}: turns, draws a visible arc and track, in its own hand`, async () => {
        const now = await read(page, style, mode);
        expect(now.animationName).toBe('fy-spinner-turn');
        expect(now.animationIterationCount).toBe('infinite');
        expect(now.animationDuration).toBe(hand.speed);
        expect(now.animationTimingFunction).toBe(hand.timing);
        expect(now.arcStroke).not.toBe('none');
        expect(now.trackStroke).not.toBe('none');
        expect(now.arcWidth).toBe(hand.stroke);
        expect(now.arcCap).toBe(hand.cap);
        expect(now.arcDash).toBe(hand.sweep);
        expect(now.trackDash).toBe(hand.dash);
        expect(now.filter).toBe('none');
      });
    }
  }

  /** Pixel's own hand: no ring, four blocks lit in turn (clockwise p1, p2, p4, p3), a quarter of the 1s cycle apart. */
  const pixelHand = (palette: string | null) =>
    page.evaluate(paletteId => {
      const root = document.documentElement;
      root.setAttribute('data-style', 'pixel');
      if (paletteId === null) root.removeAttribute('data-palette');
      else root.setAttribute('data-palette', paletteId);
      root.setAttribute('data-mode', 'dark');
      const svg = document.querySelector('.fy-spinner') as SVGElement;
      const parts = [1, 2, 4, 3].map(n => getComputedStyle(svg.querySelector(`.fy-spinner__p${n}`) as SVGElement));
      return {
        figureAnimation: getComputedStyle(svg).animationName,
        ringDisplay: getComputedStyle(svg.querySelector('.fy-spinner-ring') as SVGElement).display,
        partDisplays: parts.map(part => part.display),
        partAnimations: parts.map(part => part.animationName),
        partDurations: parts.map(part => part.animationDuration),
        partDelays: parts.map(part => part.animationDelay),
        partTimings: parts.map(part => part.animationTimingFunction),
        partEdges: parts.map(part => part.shapeRendering),
        partFills: parts.map(part => part.fill),
      };
    }, palette);

  it('a swapped pair keeps the style’s hand: Pixel style on the Magenta palette still draws its own four chasing blocks', async () => {
    const own = await pixelHand(null);
    const swapped = await pixelHand('vaporwave');
    // Pixel's own mark (r11 T10), not the ring: the ring is hidden and four crisp blocks step round in 1s, a quarter apart.
    expect(swapped.ringDisplay).toBe('none');
    expect(swapped.figureAnimation).toBe('none');
    expect(swapped.partDisplays).toEqual(['inline', 'inline', 'inline', 'inline']);
    expect(swapped.partAnimations).toEqual(['fy-pixel-chase', 'fy-pixel-chase', 'fy-pixel-chase', 'fy-pixel-chase']);
    expect(swapped.partDurations).toEqual(['1s', '1s', '1s', '1s']);
    expect(swapped.partDelays).toEqual(['0s', '0.25s', '0.5s', '0.75s']);
    expect(swapped.partTimings).toEqual(['steps(1)', 'steps(1)', 'steps(1)', 'steps(1)']);
    expect(swapped.partEdges).toEqual(['crispedges', 'crispedges', 'crispedges', 'crispedges']);
    for (const fill of swapped.partFills) expect(fill).not.toBe('none');
    // The palette may recolour the blocks, never reshape or re-time the style's mark.
    const { partFills: ownFills, ...ownHand } = own;
    const { partFills: swappedFills, ...swappedHand } = swapped;
    expect(swappedHand).toEqual(ownHand);
    expect(swappedFills).not.toEqual(ownFills);
  });

  it('reduced motion (the OS setting) pulses the whole ring and draws the arc as a full ring', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // A ring style: Mission draws no ring (its brackets pulse; `mission-hud-kit.visual.test.ts` reads that live).
    const now = await read(page, 'studio', 'dark');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect(now.animationName).toBe('fy-spinner-pulse');
    expect(now.arcDash).toBe('100px, 0px');
    expect(now.filter).toBe('none');
  });

  it('reduced motion (Settings › Appearance › Motion) answers the same way', async () => {
    await page.evaluate(() => document.documentElement.setAttribute('data-motion', 'reduced'));
    const now = await read(page, 'pixel', 'light');
    await page.evaluate(() => document.documentElement.removeAttribute('data-motion'));
    expect(now.animationName).toBe('fy-spinner-pulse');
    expect(now.arcDash).toBe('100px, 0px');
  });

  it('on an accent fill the arc is the button’s own ink', async () => {
    const [onAccent, plain] = await page.evaluate(() => {
      const arcs = [document.querySelector('#accent .fy-spinner-arc'), document.querySelector('.fy-spinner-arc')];
      return arcs.map(arc => getComputedStyle(arc as SVGElement).stroke);
    });
    expect(onAccent).not.toBe('none');
    expect(onAccent).not.toBe(plain);
  });
});
