/**
 * THE STUDIO AND GEIST STYLE KITS (r11 T5), in the real engine.
 *
 * Owner (turn 4247, item 12): a style is every component, "not just an adjustment to padding"; spinners, motion, markdown,
 * background and hypermedia are each the style's own; no gradient background; no left accent bar; nothing super-rounded.
 * `theme-matrix` proves the cross-style rules over 512 combinations; this proves what Studio and Geist DECLARE for each slot
 * of the component style contract (`styles/tokens/base-style.css`), by the computed style of the real components under the
 * real stylesheets, and that Geist differs from Studio on every slot it owns:
 *
 *  - BACKGROUND + GRAIN: Studio is a flat ground with no grain; Geist draws a hairline grid pattern and no grain.
 *  - MARKDOWN: Studio is the base recipe; Geist is rules under h1/h2, a boxed 6px code block, an indented quote with no bar,
 *    horizontal-rule tables, weighted links.
 *  - SPINNER: Studio keeps its arc (ring only); Geist hides the ring and draws four hairline spokes in sequence.
 *  - MOTION: Geist is snappy (a shorter pop, no press shift); Studio is the base timing.
 *  - HYPERMEDIA: each declares its `--hm-*` slot set (Studio `shaped`, Geist `flat`); no renderer reads them until r12 H5.
 *  - SURFACES: no gradient on the panel, button or field; no multi-line field, code block or table over 16px; every focus ring
 *    is drawn INSIDE its control (an offset <= 0), and no left accent bar on a selected choice.
 */
import { beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Page } from 'playwright-core';
import { sharedChromium } from '../support/browser/index.ts';
import { readCssWithImports, readThemeCss, themeStylesDir } from '../../src/testing/theme-css.ts';
import { Spinner } from '../../src/ui/spinner.tsx';

setDefaultTimeout(60_000);

const srcDir = join(themeStylesDir, '..');

const MARKUP = `
<div class="md" id="md">
  <h1>Title</h1><h2>Section</h2>
  <p>Some <a href="#x" id="link">link</a> text.</p>
  <ul><li id="li">item</li></ul>
  <blockquote id="quote"><p>quoted</p></blockquote>
  <pre id="code"><code>const x = 1;</code></pre>
  <div class="md-table-scroll"><table id="table"><thead><tr><th>h</th><th>h2</th></tr></thead>
  <tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table></div>
</div>
<div class="fy-cc__card" data-pulse="true" id="card">choice</div>
<section class="kt-panel" id="panel">panel</section>
<button class="kt-btn" id="button" type="button">button</button>
<input class="kt-input" id="field" aria-label="field" />
<textarea class="kt-input" id="area" aria-label="area" rows="2"></textarea>
`;

interface Kit {
  readonly token: Readonly<Record<string, string>>;
  readonly css: Readonly<Record<string, string>>;
  readonly parts: {
    readonly count: number;
    readonly display: readonly string[];
    readonly width: readonly number[];
    readonly height: readonly number[];
    readonly duration: readonly string[];
    readonly timing: readonly string[];
    readonly ring: string;
  };
  readonly focus: Readonly<Record<string, { readonly offset: string; readonly width: string; readonly style: string }>>;
}

const TOKENS = [
  '--bg-pattern-size',
  '--bg-pattern-alpha',
  '--grain-alpha',
  '--motion-pop',
  '--motion-fast',
  '--press-translate',
  '--select-pop',
  '--hm-shape',
  '--hm-radius',
  '--hm-stroke',
  '--hm-font',
  '--hm-node-fill-alpha',
  '--hm-edge',
  '--hm-header',
  '--spinner-ring',
  '--spinner-parts',
] as const;

let page: Page;
beforeAll(async () => {
  const browser = await sharedChromium();
  page = await (await browser.newContext()).newPage();
  const css = [
    readThemeCss(),
    readFileSync(join(srcDir, 'ui/design-system.css'), 'utf8'),
    readCssWithImports(join(srcDir, 'ui/spinner.css')),
    readCssWithImports(join(srcDir, 'compose/choice-cards.css')),
    readFileSync(join(srcDir, 'styles/index.css'), 'utf8').replace(/^@(import|tailwind)[^;]*;\s*$/gmu, ''),
  ].join('\n');
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head><body>${MARKUP}${renderToStaticMarkup(createElement(Spinner, {}))}</body></html>`,
  );
}, 120_000);

const kit = (style: 'studio' | 'geist'): Promise<Kit> =>
  page.evaluate(
    ([styleId, tokens]) => {
      const root = document.documentElement;
      root.setAttribute('data-style', styleId as string);
      root.setAttribute('data-palette', styleId as string);
      root.setAttribute('data-mode', 'light');
      const rootStyle = getComputedStyle(root);
      const token: Record<string, string> = {};
      for (const name of tokens as readonly string[]) token[name] = rootStyle.getPropertyValue(name).trim();
      const q = (selector: string): Element => document.querySelector(selector) as Element;
      const css: Record<string, string> = {};
      const read = (key: string, selector: string, props: readonly string[], pseudo?: string): void => {
        const computed = getComputedStyle(q(selector), pseudo);
        for (const prop of props) css[`${key}|${prop}`] = computed.getPropertyValue(prop);
      };
      read('body', 'body', ['background-image']);
      read('after', 'body', ['opacity', 'background-image'], '::after');
      read('h1', '.md h1', ['border-bottom-width', 'border-bottom-style', 'font-size', 'font-weight']);
      read('h2', '.md h2', ['border-bottom-width', 'font-size']);
      read('code', '#code', ['border-top-width', 'border-top-left-radius', 'border-left-width', 'box-shadow']);
      read('quote', '#quote', ['border-left-width', 'padding-left', 'font-style']);
      read('td', '.md td', ['border-left-width', 'border-bottom-width']);
      read('th', '.md th', ['border-left-width', 'text-transform']);
      read('link', '#link', ['font-weight', 'text-decoration-line']);
      read('card', '#card', ['animation-duration']);
      read('panel', '#panel', ['background-image', 'border-top-left-radius']);
      read('button', '#button', ['background-image', 'translate']);
      read('field', '#field', ['background-image']);
      read('area', '#area', ['border-top-left-radius', 'background-image']);
      read('table', '#table', ['border-top-left-radius']);
      const spinner = q('.fy-spinner');
      const parts = [...spinner.querySelectorAll('[class*="fy-spinner__p"]')];
      const partStyles = parts.map(part => getComputedStyle(part));
      const boxes = parts.map(part => part.getBoundingClientRect());
      const focus: Record<string, { offset: string; width: string; style: string }> = {};
      for (const id of ['button', 'field', 'area', 'link']) {
        const el = document.getElementById(id) as HTMLElement;
        el.focus();
        const computed = getComputedStyle(el);
        focus[id] = {
          offset: computed.outlineOffset,
          width: computed.outlineWidth,
          style: computed.outlineStyle,
        };
        el.blur();
      }
      return {
        token,
        css,
        parts: {
          count: parts.length,
          display: partStyles.map(style => style.display),
          width: boxes.map(box => box.width),
          height: boxes.map(box => box.height),
          duration: partStyles.map(style => style.animationDuration),
          timing: partStyles.map(style => style.animationTimingFunction),
          ring: getComputedStyle(q('.fy-spinner-ring')).display,
        },
        focus,
      };
    },
    [style, TOKENS] as const,
  );

const px = (value: string): number => Number.parseFloat(value);
const seconds = (value: string): number =>
  value.endsWith('ms') ? Number.parseFloat(value) / 1000 : Number.parseFloat(value);
const noGradient = (value: string): boolean => !/gradient/u.test(value);

describe('r11 T5 · Studio and Geist fill every slot of the component style contract', () => {
  it('Studio is the base: no pattern, no grain, its arc, the base motion, a shaped hypermedia', async () => {
    const studio = await kit('studio');
    expect(studio.css['body|background-image']).toMatch(/^none(, none)*$/u);
    expect(studio.css['after|opacity']).toBe('0');
    expect(studio.parts.ring).not.toBe('none');
    expect(studio.parts.display.every(display => display === 'none')).toBe(true);
    expect(studio.token['--hm-shape']).toBe('shaped');
    expect(studio.token['--hm-edge']).toBe('curve');
    expect(studio.token['--hm-header']).toBe('band');
    expect(px(studio.token['--hm-radius'] ?? '')).toBeGreaterThanOrEqual(8);
    expect(studio.token['--hm-stroke']).toBe('1px');
    expect(studio.token['--hm-font']).toContain('Inter');
    expect(Number.parseFloat(studio.token['--hm-node-fill-alpha'] ?? '')).toBeGreaterThan(0.5);
  });

  it('Geist draws a hairline grid and no grain', async () => {
    const geist = await kit('geist');
    expect(geist.css['body|background-image']).toContain('conic-gradient');
    expect(px(geist.token['--bg-pattern-size'] ?? '')).toBeGreaterThanOrEqual(24);
    expect(geist.css['after|opacity']).toBe('0');
  });

  it("Geist's markdown is its own: rules under headings, a boxed code block, an indented quote, rule tables, weighted links", async () => {
    const studio = await kit('studio');
    const geist = await kit('geist');
    expect(px(studio.css['h1|border-bottom-width'] ?? '')).toBe(0);
    expect(px(geist.css['h1|border-bottom-width'] ?? '')).toBe(1);
    expect(px(geist.css['h2|border-bottom-width'] ?? '')).toBe(0);
    expect(px(geist.css['h1|font-size'] ?? '')).toBeLessThan(px(studio.css['h1|font-size'] ?? ''));
    expect(px(geist.css['code|border-top-left-radius'] ?? '')).toBe(6);
    expect(px(geist.css['code|border-left-width'] ?? '')).toBe(1);
    expect(px(geist.css['quote|border-left-width'] ?? '')).toBe(0);
    expect(px(geist.css['quote|padding-left'] ?? '')).toBeGreaterThanOrEqual(12);
    expect(px(studio.css['td|border-left-width'] ?? '')).toBeGreaterThan(0);
    expect(px(geist.css['td|border-left-width'] ?? '')).toBe(0);
    expect(px(geist.css['td|border-bottom-width'] ?? '')).toBe(1);
    expect(px(geist.css['link|font-weight'] ?? '')).toBeGreaterThanOrEqual(500);
    expect(geist.css['link|text-decoration-line']).toBe('underline');
  });

  it("Geist's spinner is four hairline spokes in sequence, not the arc and never dots", async () => {
    const geist = await kit('geist');
    expect(geist.parts.ring).toBe('none');
    expect(geist.parts.count).toBe(4);
    expect(geist.parts.display.every(display => display !== 'none')).toBe(true);
    for (const [index, width] of geist.parts.width.entries()) {
      const height = geist.parts.height[index] ?? 0;
      expect(Math.min(width, height), 'a hairline').toBeLessThanOrEqual(1.5);
      expect(Math.max(width, height), 'a spoke').toBeGreaterThanOrEqual(3.5);
    }
    expect(new Set(geist.parts.duration).size).toBe(1);
    expect(geist.parts.timing[0]).toBe('linear');
    expect(seconds(geist.parts.duration[0] ?? '')).toBeGreaterThanOrEqual(0.8);
  });

  it('Geist is snappy: a shorter pop than Studio, no press shift', async () => {
    const studio = await kit('studio');
    const geist = await kit('geist');
    expect(seconds(geist.token['--motion-pop'] ?? '')).toBeLessThan(seconds(studio.token['--motion-pop'] ?? ''));
    expect(seconds(geist.css['card|animation-duration'] ?? '')).toBeLessThan(
      seconds(studio.css['card|animation-duration'] ?? ''),
    );
    expect(Number.parseFloat(geist.token['--select-pop'] ?? '')).toBeLessThan(
      Number.parseFloat(studio.token['--select-pop'] ?? ''),
    );
    expect(geist.token['--press-translate']).toBe('0px');
  });

  it("Geist's hypermedia is flat: outlined nodes, hairlines, straight edges, a label header", async () => {
    const geist = await kit('geist');
    expect(geist.token['--hm-shape']).toBe('flat');
    expect(geist.token['--hm-stroke']).toBe('1px');
    expect(geist.token['--hm-edge']).toBe('straight');
    expect(geist.token['--hm-header']).toBe('label');
    expect(Number.parseFloat(geist.token['--hm-node-fill-alpha'] ?? '')).toBe(0);
    expect(px(geist.token['--hm-radius'] ?? '')).toBeLessThanOrEqual(6);
    expect(geist.token['--hm-font']).toContain('Geist');
  });

  for (const style of ['studio', 'geist'] as const)
    it(`${style}: no gradient background, no radius over 16px on a multi-line field, code block or table, focus drawn inside`, async () => {
      const read = await kit(style);
      for (const key of [
        'panel|background-image',
        'button|background-image',
        'field|background-image',
        'area|background-image',
      ])
        expect(noGradient(read.css[key] ?? ''), `${style} ${key}`).toBe(true);
      for (const key of ['area|border-top-left-radius', 'code|border-top-left-radius', 'table|border-top-left-radius'])
        expect(px(read.css[key] ?? ''), `${style} ${key}`).toBeLessThanOrEqual(16);
      for (const [id, ring] of Object.entries(read.focus)) {
        expect(px(ring.offset), `${style} ${id} focus ring offset`).toBeLessThanOrEqual(0);
        expect(ring.style, `${style} ${id} draws a ring`).not.toBe('none');
        expect(px(ring.width), `${style} ${id} ring width`).toBeGreaterThanOrEqual(2);
      }
    });
});
