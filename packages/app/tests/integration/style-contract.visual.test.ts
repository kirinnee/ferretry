/**
 * THE COMPONENT STYLE CONTRACT, IN THE REAL ENGINE (r11 T2).
 *
 * A style is "every component", so the base defines named slots (`styles/tokens/base-style.css`) that a style fills and
 * the components read: a background pattern and grain, the markdown recipe, the spinner's parts, motion timing. This
 * proves the two halves of that contract with the real stylesheets, in Chromium, on computed values (never a snapshot of
 * pixels alone):
 *
 *  1. STUDIO IS UNCHANGED. Every probe below, resolved under Studio, equals the capture taken from the base commit
 *     (`fixtures/style-contract-studio.json`): the new slots default to exactly the values the components hard-coded.
 *  2. A STYLE THAT FILLS THE SLOTS CHANGES EVERY COMPONENT. A probe style sets every new token; it must change the
 *     computed style of the page background, `.md h1`, `.md pre`, `.md blockquote`, `.md table`, `.md a`, the list
 *     marker, the spinner's parts and a choice card's select animation.
 *  3. THE GRAIN COSTS NO REQUEST. It is an inline SVG data URI; the page's request log stays empty.
 *
 * `CAPTURE_STUDIO=1` rewrites the fixture (run it on the base commit, never after a change).
 */
import { beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Page } from 'playwright-core';
import { sharedChromium } from '../support/browser/index.ts';
import { readCssWithImports, readThemeCss, themeStylesDir } from '../../src/testing/theme-css.ts';
import { Spinner } from '../../src/ui/spinner.tsx';

setDefaultTimeout(60_000);

const FIXTURE = join(import.meta.dir, 'fixtures/style-contract-studio.json');
const srcDir = join(themeStylesDir, '..');

/** Every new token, set to something no style has today. */
const PROBE_STYLE = `
:root[data-style='probe'] {
  --bg-pattern: var(--bg-pattern-dots);
  --bg-pattern-size: 14px;
  --bg-pattern-alpha: 100%;
  --grain-image: var(--grain-noise);
  --grain-alpha: 0.08;
  --grain-scale: 1.5;
  --grain-blend: overlay;

  --md-h1-size: 2em;
  --md-h1-weight: 900;
  --md-h1-case: uppercase;
  --md-h1-rule: 3px solid currentColor;
  --md-h1-rule-pad: 0.2em;
  --md-h2-size: 1.5em;
  --md-h2-weight: 300;
  --md-h2-case: capitalize;
  --md-h2-rule: 1px dashed currentColor;
  --md-h2-rule-pad: 0.1em;
  --md-code-border: 0 solid transparent;
  --md-code-bar: 4px solid var(--accent);
  --md-code-radius: 0px;
  --md-code-shadow: 3px 3px 0 var(--fg);
  --md-quote-bar: 0 solid transparent;
  --md-quote-pad: 1.5em;
  --md-quote-bg: color-mix(in srgb, var(--accent) 14%, transparent);
  --md-quote-radius: 8px;
  --md-quote-font-style: italic;
  --md-cell-border-x: 0 solid transparent;
  --md-cell-border-y: 2px solid var(--fg);
  --md-th-bg: transparent;
  --md-th-case: uppercase;
  --md-th-weight: 800;
  --md-zebra: color-mix(in srgb, var(--accent) 20%, transparent);
  --md-link-decoration: none;
  --md-link-weight: 700;
  --md-link-bg: color-mix(in srgb, var(--accent) 16%, transparent);
  --md-link-pad: 0 0.3em;
  --md-link-radius: 4px;
  --md-ul-marker: square;
  --md-ol-marker: upper-roman;
  --md-list-marker-color: var(--accent);

  --spinner-ring: none;
  --spinner-parts: inline;
  --spinner-parts-speed: 0.6s;
  --spinner-parts-timing: steps(4, end);

  --motion-pop: 420ms;
  --ease-out: cubic-bezier(0.1, 0.9, 0.2, 1);
  --ease-in: cubic-bezier(0.9, 0.1, 0.8, 0.2);
  --ease-spring: cubic-bezier(0.3, 0, 0.2, 1.5);
  --focus-line: dashed;
  --panel-edge-line: dashed;
}
`;

const MARKDOWN = `
<div class="md" id="md">
  <h1>Title</h1><h2>Section</h2>
  <p>Some <a href="#x" id="link">link</a> text.</p>
  <ul><li id="li">item</li></ul><ol><li>one</li></ol>
  <blockquote><p>quoted</p></blockquote>
  <pre><code>const x = 1;</code></pre>
  <div class="md-table-scroll"><table><thead><tr><th>h</th><th>h2</th></tr></thead>
  <tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table></div>
</div>
<div class="fy-cc__card" data-pulse="true" id="card">choice</div>
<button class="kt-input-probe" id="focusme">focus</button>
`;

type Probe = Readonly<Record<string, string>>;

const measure = (page: Page, style: string): Promise<Probe> =>
  page.evaluate((styleId: string) => {
    const root = document.documentElement;
    root.setAttribute('data-style', styleId);
    root.setAttribute('data-palette', 'studio');
    root.setAttribute('data-mode', 'light');
    const q = (selector: string): Element => document.querySelector(selector) as Element;
    const css = (selector: string, props: readonly string[], pseudo?: string): Record<string, string> => {
      const computed = getComputedStyle(q(selector), pseudo);
      const out: Record<string, string> = {};
      for (const prop of props) out[`${selector}${pseudo ?? ''}|${prop}`] = computed.getPropertyValue(prop);
      return out;
    };
    const rows: Record<string, string>[] = [
      css('body', ['background-image']),
      css('body', ['background-image', 'opacity', 'mix-blend-mode', 'background-size'], '::after'),
      css('.md h1', ['font-size', 'font-weight', 'text-transform', 'border-bottom-width', 'padding-bottom']),
      css('.md h2', ['font-size', 'font-weight', 'text-transform', 'border-bottom-style', 'padding-bottom']),
      css('.md pre', [
        'border-top-width',
        'border-left-width',
        'border-left-color',
        'border-top-left-radius',
        'box-shadow',
      ]),
      css('.md blockquote', [
        'border-left-width',
        'padding-left',
        'background-color',
        'border-top-left-radius',
        'font-style',
      ]),
      css('.md td', ['border-left-width', 'border-bottom-width', 'border-bottom-color']),
      css('.md th', ['background-color', 'text-transform', 'font-weight']),
      css('.md tbody tr:nth-child(even) td', ['background-color']),
      css('.md a', [
        'text-decoration-line',
        'font-weight',
        'background-color',
        'padding-left',
        'border-top-left-radius',
      ]),
      css('.md ul', ['list-style-type']),
      css('.md ol', ['list-style-type']),
      css('#li', ['color'], '::marker'),
      css('#card', ['animation-duration', 'animation-timing-function', 'transition-duration']),
    ];
    return Object.assign({}, ...rows) as Record<string, string>;
  }, style);

/** What only exists after T2: the spinner's parts and the focus / panel-edge slots. Read apart so the Studio capture
 * (taken before any of it existed) stays comparable. */
const measureNew = (page: Page, style: string): Promise<Probe> =>
  page.evaluate((styleId: string) => {
    const root = document.documentElement;
    root.setAttribute('data-style', styleId);
    root.setAttribute('data-palette', 'studio');
    root.setAttribute('data-mode', 'light');
    const spinner = document.querySelector('.fy-spinner') as Element;
    const part = spinner.querySelector('.fy-spinner__p1') as Element | null;
    const ring = spinner.querySelector('.fy-spinner-ring') as Element | null;
    const partStyle = part === null ? null : getComputedStyle(part);
    const ringStyle = ring === null ? null : getComputedStyle(ring);
    const focus = document.getElementById('focusme') as HTMLElement;
    focus.focus();
    return {
      parts: spinner.querySelectorAll('[class*="fy-spinner__p"]').length.toString(),
      partDisplay: partStyle?.display ?? 'missing',
      partAnimationDuration: partStyle?.animationDuration ?? 'missing',
      partAnimationTiming: partStyle?.animationTimingFunction ?? 'missing',
      ringDisplay: ringStyle?.display ?? 'missing',
    };
  }, style);

let page: Page;
const requests: string[] = [];

beforeAll(async () => {
  const browser = await sharedChromium();
  page = await (await browser.newContext()).newPage();
  page.on('request', request => {
    if (!request.url().startsWith('data:') && request.url() !== 'about:blank') requests.push(request.url());
  });
  const css = [
    readThemeCss(),
    readFileSync(join(srcDir, 'ui/design-system.css'), 'utf8'),
    readCssWithImports(join(srcDir, 'ui/spinner.css')),
    readCssWithImports(join(srcDir, 'compose/choice-cards.css')),
    readFileSync(join(srcDir, 'styles/index.css'), 'utf8').replace(/^@(import|tailwind)[^;]*;\s*$/gmu, ''),
    PROBE_STYLE,
  ].join('\n');
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head><body>${MARKDOWN}${renderToStaticMarkup(createElement(Spinner, {}))}</body></html>`,
  );
}, 120_000);

describe('r11 T2 · the component style contract', () => {
  it('Studio resolves every probe exactly as the base commit did', async () => {
    // The grain layer is T2's own (the base had no `body::after` to capture), and the body's background gained a first
    // layer that is `none` in Studio (asserted apart below).
    const all = await measure(page, 'studio');
    const studio = Object.fromEntries(
      Object.entries(all).filter(([key]) => key !== 'body|background-image' && !key.startsWith('body::after')),
    );
    if (process.env.CAPTURE_STUDIO === '1') {
      writeFileSync(FIXTURE, `${JSON.stringify(studio, null, 2)}\n`);
      return;
    }
    const captured = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Probe;
    expect(studio).toEqual(captured);
  });

  it('Studio draws no pattern, no grain and hides the spinner parts', async () => {
    const studio = await measure(page, 'studio');
    expect(studio['body|background-image']).toMatch(/^none(, none)*$/u);
    expect(studio['body::after|opacity']).toBe('0');
    const parts = await measureNew(page, 'studio');
    expect(parts.parts).toBe('4');
    expect(parts.partDisplay).toBe('none');
    expect(parts.ringDisplay).not.toBe('none');
  });

  it('a style that fills every slot changes every component', async () => {
    const studio = await measure(page, 'studio');
    const probe = await measure(page, 'probe');
    const changed = (selector: string): string[] =>
      Object.keys(studio).filter(key => key.startsWith(`${selector}|`) && studio[key] !== probe[key]);
    for (const selector of [
      'body',
      'body::after',
      '.md h1',
      '.md h2',
      '.md pre',
      '.md blockquote',
      '.md td',
      '.md th',
      '.md tbody tr:nth-child(even) td',
      '.md a',
      '.md ul',
      '.md ol',
      '#li::marker',
      '#card',
    ]) {
      expect(changed(selector).length, `${selector} must change under a style that sets the slots`).toBeGreaterThan(0);
    }
    const studioNew = await measureNew(page, 'studio');
    const probeNew = await measureNew(page, 'probe');
    expect(probeNew.partDisplay).not.toBe(studioNew.partDisplay);
    expect(probeNew.partAnimationDuration).toBe('0.6s');
    expect(probeNew.partAnimationTiming).toBe('steps(4)');
    expect(probeNew.ringDisplay).toBe('none');
  });

  it('the choice card select animation follows the motion tokens', async () => {
    const probe = await measure(page, 'probe');
    expect(probe['#card|animation-duration']).toBe('0.42s');
    expect(probe['#card|animation-timing-function']).toBe('cubic-bezier(0.1, 0.9, 0.2, 1)');
  });

  it('the grain is an inline data URI: the page made no request', async () => {
    const probe = await measure(page, 'probe');
    expect(probe['body::after|background-image']).toContain('data:image/svg+xml');
    expect(requests).toEqual([]);
  });
});
