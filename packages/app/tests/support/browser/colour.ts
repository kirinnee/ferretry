/**
 * Colour arithmetic for a real-browser test: the contrast of what is drawn, measured in the page.
 *
 * A page function cannot close over a test file, so the maths is a script (`COLOUR_TOOLS`) installed once per page as
 * `window.__colour`, and every check reads it back. `rgba` goes through a canvas so ANY colour the engine can compute
 * (`color-mix`, `oklch`, a translucent fill) reads as sRGB; `backdrop` composites the fills behind an element.
 */
import type { Page } from 'playwright-core';
import { PALETTE_IDS } from '../../../src/theme/catalog.ts';

/** Every palette id, in catalogue order: what "every palette" means to a test. */
export const ALL_PALETTE_IDS: readonly string[] = PALETTE_IDS;

export interface ColourTools {
  rgba: (css: string) => [number, number, number, number];
  over: (top: readonly number[], below: readonly number[]) => [number, number, number];
  backdrop: (element: HTMLElement) => [number, number, number];
  ratio: (a: readonly number[], b: readonly number[]) => number;
}

export const COLOUR_TOOLS = `(() => {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = css => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const over = (top, below) => [0, 1, 2].map(i => top[i] * top[3] + below[i] * (1 - top[3]));
  const backdrop = element => {
    const layers = [];
    for (let node = element; node !== null; node = node.parentElement) {
      const fill = rgba(getComputedStyle(node).backgroundColor);
      if (fill[3] > 0) layers.push(fill);
      if (fill[3] === 1) break;
    }
    let base = [255, 255, 255];
    for (const layer of layers.reverse()) base = over(layer, [...base, 1]);
    return base;
  };
  const luminance = c => {
    const [r, g, b] = c.map(v => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  window.__colour = { rgba, over, backdrop, ratio };
})()`;

export interface TextContrastReport {
  /** How many text elements were measured. */
  readonly checked: number;
  /** One line per element under the floor: its tag, classes, first words and ratio. */
  readonly failures: readonly string[];
  /** The lowest ratio found for each named probe (a probe nobody matched is absent). */
  readonly probes: Readonly<Record<string, number>>;
}

export interface TextContrastOptions {
  /** CSS selector of the elements whose descendants are measured. */
  readonly within: string;
  /** Floor, default 4.5 (WCAG AA for body text). */
  readonly floor?: number;
  /** Named selectors; each element it matches adds to that name's lowest ratio, so a test can prove the sample holds it. */
  readonly probes?: Readonly<Record<string, string>>;
}

/**
 * The contrast of every visible text element under `within`: its ink (opacity applied) against the fills actually behind
 * it. A disabled control is exempt (WCAG), as is anything 1px square (`sr-only`).
 */
export async function textContrast(tab: Page, options: TextContrastOptions): Promise<TextContrastReport> {
  await tab.evaluate(COLOUR_TOOLS);
  return await tab.evaluate(
    ({ within, floor, probes }) => {
      const { backdrop, over, ratio, rgba } = (window as unknown as { __colour: ColourTools }).__colour;
      const failures: string[] = [];
      const lowest: Record<string, number> = {};
      let checked = 0;
      for (const element of document.querySelectorAll<HTMLElement>(`${within} *`)) {
        const own = [...element.childNodes].some(
          node => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
        );
        if (!own) continue;
        const box = element.getBoundingClientRect();
        if (box.width <= 1 || box.height <= 1) continue;
        if (element.closest('[disabled], [aria-disabled="true"]') !== null) continue;
        let opacity = 1;
        for (let node: HTMLElement | null = element; node !== null; node = node.parentElement)
          opacity *= Number.parseFloat(getComputedStyle(node).opacity);
        const bg = backdrop(element);
        const ink = rgba(getComputedStyle(element).color);
        const value = ratio(over([ink[0], ink[1], ink[2], ink[3] * opacity], [...bg, 1]), bg);
        checked += 1;
        for (const [name, selector] of Object.entries(probes))
          if (element.matches(selector)) lowest[name] = Math.min(lowest[name] ?? 99, value);
        if (value < floor)
          failures.push(
            `${element.tagName.toLowerCase()}.${element.className} "${(element.textContent ?? '').trim().slice(0, 30)}" ${value.toFixed(2)}:1`,
          );
      }
      return { checked, failures, probes: lowest };
    },
    { within: options.within, floor: options.floor ?? 4.5, probes: options.probes ?? {} },
  );
}
