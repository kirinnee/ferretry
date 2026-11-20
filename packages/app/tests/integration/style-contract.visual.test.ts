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
import { Loading, LOADING_DELAY_MS, LOADING_FADE_MS } from '../../src/ui/loading.tsx';

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
  --md-stack-frame: 3px dashed var(--accent);
  --md-stack-radius: 0px;
  --md-stack-row-rule: 2px dotted var(--fg);
  --md-stack-row-fill: color-mix(in srgb, var(--accent) 18%, transparent);
  --md-stack-label-weight: 900;
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
  --ease-in-out: cubic-bezier(0.5, 0, 0.5, 1);
  --motion-loading-ring: 3.3s;
  --motion-loading-run: 0.9s;
  --motion-loading-shimmer: 1.7s;
  --ease-loading-ring: steps(6, end);
  --ease-loading-run: linear;
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
<div class="fy-loading-bar" id="bar" style="--loading-delay:${LOADING_DELAY_MS}ms;--loading-fade:${LOADING_FADE_MS}ms"><span class="fy-loading-bar__run" id="run"></span></div>
<div class="fy-sp" data-sp-state="playing" id="sp"><div class="fy-sp__layer fy-sp__layer--before" id="sp-before"></div><div class="fy-sp__layer fy-sp__layer--after" id="sp-after"></div></div>
`;

/** The phone's default reading of a table, with the REAL wrapper markup (markdown-table.tsx): `.md-table[data-md-table-view=cards]`. */
const STACKED = `
<div class="md"><div class="md-table" data-md-table-view="cards"><div class="md-table-scroll scroll-thin">
<table><thead><tr><th>h</th><th>h2</th></tr></thead>
<tbody><tr><td data-label="h">a</td><td data-label="h2">b</td></tr><tr><td data-label="h">c</td><td data-label="h2">d</td></tr></tbody></table>
</div></div></div>
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
let css: string;
const requests: string[] = [];

beforeAll(async () => {
  const browser = await sharedChromium();
  page = await (await browser.newContext()).newPage();
  page.on('request', request => {
    if (!request.url().startsWith('data:') && request.url() !== 'about:blank') requests.push(request.url());
  });
  css = [
    readThemeCss(),
    readFileSync(join(srcDir, 'ui/design-system.css'), 'utf8'),
    readCssWithImports(join(srcDir, 'ui/spinner.css')),
    readCssWithImports(join(srcDir, 'compose/choice-cards.css')),
    readCssWithImports(join(srcDir, 'compose/setting-preview.css')),
    readCssWithImports(join(srcDir, 'ui/loading.css')),
    readFileSync(join(srcDir, 'styles/index.css'), 'utf8').replace(/^@(import|tailwind)[^;]*;\s*$/gmu, ''),
    PROBE_STYLE,
  ].join('\n');
  await page.setContent(
    `<!doctype html><html><head><style>${css}</style></head><body>${MARKDOWN}${renderToStaticMarkup(createElement(Spinner, {}))}${renderToStaticMarkup(createElement(Loading, { kind: 'page' }))}</body></html>`,
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

  it("r11 T2 review 2 · the loading system and the setting preview follow the style's motion slots, not their own numbers", async () => {
    const read = (styleId: string) =>
      page.evaluate((id: string) => {
        document.documentElement.setAttribute('data-style', id);
        document.documentElement.setAttribute('data-palette', 'studio');
        document.documentElement.setAttribute('data-mode', 'light');
        const cs = (selector: string) => getComputedStyle(document.querySelector(selector) as Element);
        const page = cs('.fy-loading--page');
        const ring = cs('.fy-loading__ring:not(.fy-loading__ring--late)');
        const late = cs('.fy-loading__ring--late');
        const shimmer = cs('.fy-loading__label');
        const run = cs('#run');
        const bar = cs('#bar');
        const before = cs('#sp-before');
        const after = cs('#sp-after');
        return {
          ringDuration: ring.animationDuration,
          ringTiming: ring.animationTimingFunction,
          lateDelay: late.animationDelay,
          shimmerDuration: shimmer.animationDuration,
          shimmerTiming: shimmer.animationTimingFunction,
          runDuration: run.animationDuration,
          runTiming: run.animationTimingFunction,
          revealDuration: page.animationDuration,
          revealTiming: page.animationTimingFunction,
          revealDelay: page.animationDelay,
          barRevealTiming: bar.animationTimingFunction,
          barRevealDelay: bar.animationDelay,
          spBeforeTiming: before.animationTimingFunction,
          spAfterTiming: after.animationTimingFunction,
        };
      }, styleId);
    const studio = await read('studio');
    const probe = await read('probe');
    // Studio keeps every number the loader drew before the slots existed.
    expect(studio).toEqual({
      ringDuration: '2.2s',
      ringTiming: 'cubic-bezier(0.2, 0.6, 0.35, 1)',
      lateDelay: '1.1s',
      shimmerDuration: '2.4s',
      shimmerTiming: 'ease-in-out',
      runDuration: '1.3s',
      runTiming: 'cubic-bezier(0.4, 0, 0.2, 1)',
      revealDuration: '0.16s',
      revealTiming: 'ease-out',
      revealDelay: '0.3s',
      barRevealTiming: 'ease-out',
      barRevealDelay: '0.3s',
      spBeforeTiming: 'ease-in-out',
      spAfterTiming: 'ease-in-out',
    });
    // A style that fills the slots moves every one of them...
    expect(probe.ringDuration).toBe('3.3s');
    expect(probe.ringTiming).toBe('steps(6)');
    expect(probe.lateDelay).toBe('1.65s');
    expect(probe.shimmerDuration).toBe('1.7s');
    expect(probe.shimmerTiming).toBe('cubic-bezier(0.5, 0, 0.5, 1)');
    expect(probe.runDuration).toBe('0.9s');
    expect(probe.runTiming).toBe('linear');
    expect(probe.revealTiming).toBe('cubic-bezier(0.1, 0.9, 0.2, 1)');
    expect(probe.barRevealTiming).toBe('cubic-bezier(0.1, 0.9, 0.2, 1)');
    expect(probe.spBeforeTiming).toBe('cubic-bezier(0.5, 0, 0.5, 1)');
    expect(probe.spAfterTiming).toBe('cubic-bezier(0.5, 0, 0.5, 1)');
    // ...and none of them touches WHEN the loader appears: the delay and the fade are ui/loading.tsx's, not a style's.
    expect(probe.revealDelay).toBe(studio.revealDelay);
    expect(probe.barRevealDelay).toBe(studio.barRevealDelay);
    expect(probe.revealDuration).toBe(studio.revealDuration);
    expect(studio.revealDelay).toBe(`${LOADING_DELAY_MS / 1000}s`);
  });

  it('r11 T2 review 3 · reduced transparency switches off BOTH layers: the pattern and the grain', async () => {
    const cdp = await page.context().newCDPSession(page);
    try {
      const normal = await measure(page, 'probe');
      expect(normal['body|background-image']).toContain('radial-gradient');
      expect(normal['body::after|opacity']).toBe('0.08');
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
      });
      const reduced = await measure(page, 'probe');
      expect(reduced['body|background-image']).toMatch(/^none(, none)*$/u);
      expect(await page.evaluate(() => getComputedStyle(document.body, '::after').display)).toBe('none');
    } finally {
      await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    }
    // Back to normal: the pattern is drawn again.
    expect((await measure(page, 'probe'))['body|background-image']).toContain('radial-gradient');
  });

  it('the grain is an inline data URI: the page made no request', async () => {
    const probe = await measure(page, 'probe');
    expect(probe['body::after|background-image']).toContain('data:image/svg+xml');
    expect(requests).toEqual([]);
  });
});

describe("r11 T2 review 1 · the Stacked table (the phone's default) takes its own style slots", () => {
  it('at 390px a style changes the frame, the row divider and the record fill, with the real wrapper', async () => {
    const context = await (await sharedChromium()).newContext({ viewport: { width: 390, height: 844 } });
    const phone = await context.newPage();
    await phone.setContent(`<!doctype html><html><head><style>${css}</style></head><body>${STACKED}</body></html>`);
    const read = (styleId: string) =>
      phone.evaluate((id: string) => {
        document.documentElement.setAttribute('data-style', id);
        document.documentElement.setAttribute('data-palette', 'studio');
        document.documentElement.setAttribute('data-mode', 'light');
        const cs = (selector: string, pseudo?: string) =>
          getComputedStyle(document.querySelector(selector) as Element, pseudo);
        const table = cs('[data-md-table-view="cards"] table');
        const second = cs('[data-md-table-view="cards"] tbody tr:nth-child(2)');
        const cell = cs('[data-md-table-view="cards"] tbody tr:nth-child(2) td');
        const first = cs('[data-md-table-view="cards"] tbody tr:nth-child(1) td');
        return {
          view: document.querySelector('.md-table')?.getAttribute('data-md-table-view') ?? '',
          display: cs('[data-md-table-view="cards"] td').display,
          frameWidth: table.borderTopWidth,
          frameStyle: table.borderTopStyle,
          frameRadius: table.borderTopLeftRadius,
          dividerWidth: second.borderTopWidth,
          dividerStyle: second.borderTopStyle,
          evenFill: cell.backgroundColor,
          oddFill: first.backgroundColor,
          labelWeight: cs('[data-md-table-view="cards"] tbody tr:nth-child(1) td', '::before').fontWeight,
        };
      }, styleId);
    try {
      const studio = await read('studio');
      const probe = await read('probe');
      expect(studio.view).toBe('cards');
      expect(studio.display).toBe('block'); // the stacked rules really apply at 390px
      // Studio is what the stack drew before the slots (1px frame, 1px hairline, no fill, 600 labels).
      expect(studio).toMatchObject({
        frameWidth: '1px',
        frameStyle: 'solid',
        dividerWidth: '1px',
        dividerStyle: 'solid',
        evenFill: 'rgba(0, 0, 0, 0)',
        oddFill: 'rgba(0, 0, 0, 0)',
        labelWeight: '600',
      });
      // A style that fills the slots changes every one of them.
      expect(probe).toMatchObject({
        frameWidth: '3px',
        frameStyle: 'dashed',
        frameRadius: '0px',
        dividerWidth: '2px',
        dividerStyle: 'dotted',
        labelWeight: '900',
      });
      expect(probe.evenFill).not.toBe(studio.evenFill);
      expect(probe.oddFill).not.toBe(studio.oddFill);
    } finally {
      await context.close();
    }
  });
});
