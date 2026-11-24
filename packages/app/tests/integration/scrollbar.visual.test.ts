/**
 * THE APP'S SCROLLBARS ARE THIN AND THEMED, EVERYWHERE (O9-7, owner: "Scrollbars are ugly everywhere (shots 2, 4, 6, 7)").
 *
 * ONE rule owns them (`styles/index.css`): `scrollbar-width: thin` and a `scrollbar-color` taken from the palette's `--muted`, so light,
 * dark and every palette pack follow. In a real browser over the REAL app (`fixtures/mobile-scene.tsx`), light and dark:
 *
 *  - the page and every scroll area a real page draws is thin and coloured: not the engine's default `auto` / `auto`, and a thumb that
 *    is not the track (a scrollbar cannot be seen if both are one colour), unless the component hides its own strip on purpose;
 *  - the surfaces that used to restyle their own (a code block, a table, the xterm viewport) read the same two values as the page, EXCEPT
 *    a surface that paints its own background (a code block, a terminal, a diff or process body): its thumb comes from ITS ink, and the
 *    RENDERED contrast of thumb over that surface is at least 3:1 in every style x palette x mode;
 *  - (the REAL xterm scrollback slider is measured in the terminals plugin: `terminal-scrollbar.visual.test.ts`;)
 *  - a SelectBox list that grows past its max height keeps its rows where they were (the selected row's check does not move), and the
 *    page shell reserves no empty strip at its right edge, with classic desktop scrollbars (the owner's 1440 case);
 *
 * `FY_SCROLLBAR_SHOTS_DIR=<dir>` keeps `<width>-<theme>-<name>.png` (local evidence for the PR, never committed).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import { ALL_PALETTE_IDS, COLOUR_TOOLS, sceneServer, sharedChromium } from '../support/browser/index.ts';
import { STYLE_IDS } from '../../src/theme/catalog.ts';
import { readStyleFile, readThemeCss } from '../../src/testing/theme-css.ts';

setDefaultTimeout(90_000);

const shotsDir = process.env.FY_SCROLLBAR_SHOTS_DIR ?? '';
const scene = new URL('./fixtures/mobile-scene.tsx', import.meta.url).pathname;

let browser: Browser;
let server: ReturnType<typeof Bun.spawn> | undefined;
let origin = '';
/** A scene server over one entry; resolves to its origin. */
const serve = async (entry: string): Promise<{ child: ReturnType<typeof Bun.spawn>; origin: string }> => {
  const child = Bun.spawn([process.execPath, sceneServer, '--entry', entry], { stderr: 'inherit', stdout: 'pipe' });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const first = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the scene server did not start')), 120_000)),
  ]);
  const line = new TextDecoder().decode(first.value).trim().split('\n')[0] as string;
  return { child, origin: (JSON.parse(line) as { origin: string }).origin };
};

/**
 * A Chromium that DRAWS its scrollbars: the shared one keeps Playwright's `--hide-scrollbars`, which hides the very thing under test
 * (a classic bar takes layout width, and a thumb has a colour to measure). Used by the geometry and the shots.
 */
let drawn: Browser;

beforeAll(async () => {
  browser = await sharedChromium();
  const app = await serve(scene);
  server = app.child;
  origin = app.origin;
  drawn = await chromium.launch({
    executablePath: Bun.which('google-chrome') ?? Bun.which('chromium') ?? undefined,
    headless: true,
    ignoreDefaultArgs: ['--hide-scrollbars'],
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 300_000);

afterAll(async () => {
  server?.kill();
  await drawn?.close();
});

const PAGES = [
  { name: 'ferrets', path: '/d/ws/ferrets', ready: '[data-sbar-session]' },
  { name: 'chat', path: '/d/ws/ferrets/zoe/chat', ready: '[data-composer-send]' },
  { name: 'settings', path: '/d/ws/settings', ready: '.fy-page' },
  { name: 'projects', path: '/d/ws/projects', ready: '.fy-main' },
] as const;
const VIEWPORTS = [
  { width: 390, height: 844, phone: true },
  { width: 1_440, height: 900, phone: false },
] as const;
const SCHEMES = ['light', 'dark'] as const;

const open = async (
  page: (typeof PAGES)[number],
  viewport: (typeof VIEWPORTS)[number],
  scheme: 'light' | 'dark',
  engine: Browser = browser,
  mobile: boolean = viewport.phone,
) => {
  const context = await engine.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2,
    hasTouch: mobile,
    isMobile: mobile,
    colorScheme: scheme,
  });
  const tab = await context.newPage();
  tab.setDefaultTimeout(30_000);
  await tab.goto(`${origin}${page.path}?theme=studio-${scheme}`);
  await tab.waitForSelector(page.ready, { timeout: 30_000 });
  await tab.waitForTimeout(1_200);
  return { tab, close: async () => await context.close() };
};

interface Read {
  readonly width: string;
  readonly color: string;
}
/** What an element's scrollbar computes to: the two standard properties. */
const read = (tab: Page, selector: string): Promise<Read | null> =>
  tab.evaluate(sel => {
    const node = sel === ':root' ? document.documentElement : document.querySelector(sel);
    if (node === null) return null;
    const style = getComputedStyle(node);
    return { width: style.scrollbarWidth, color: style.scrollbarColor };
  }, selector);

/** `scrollbar-color` computes to "<thumb> <track>"; the thumb must not be the track, and must not be the engine's `auto`. */
const visible = (value: Read): boolean => {
  if (value.color === 'auto') return false;
  const parts = value.color.split(/\)\s+/).map(part => part.replace(/\)?$/, ')'));
  return parts.length === 2 && parts[0] !== parts[1];
};

describe('every scroll area is thin and themed', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of SCHEMES)
      for (const page of PAGES)
        it(`${page.name} at ${viewport.width}, ${scheme}`, async () => {
          const { tab, close } = await open(page, viewport, scheme);
          try {
            if (shotsDir !== '')
              await tab.screenshot({ path: join(shotsDir, `${viewport.width}-${scheme}-${page.name}.png`) });
            const root = await read(tab, ':root');
            expect(root?.width, 'the page scrollbar is thin').toBe('thin');
            expect(visible(root as Read), `the page scrollbar is coloured (${root?.color})`).toBe(true);
            // Every element that scrolls and has not hidden its own strip: thin and coloured.
            const scrollers = await tab.evaluate(() =>
              [...document.querySelectorAll('*')]
                .filter(node => {
                  const style = getComputedStyle(node);
                  return (
                    /(auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`) &&
                    style.scrollbarWidth !== 'none' &&
                    (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)
                  );
                })
                .map(node => ({
                  node: `${node.tagName.toLowerCase()}.${String(node.className).split(' ')[0]}`,
                  width: getComputedStyle(node).scrollbarWidth,
                  color: getComputedStyle(node).scrollbarColor,
                })),
            );
            for (const scroller of scrollers) {
              expect(scroller.width, `${scroller.node} is thin`).toBe('thin');
              expect(visible(scroller), `${scroller.node} is coloured (${scroller.color})`).toBe(true);
            }
          } finally {
            await close();
          }
        });
});

/** Surfaces that paint their own dark or inverted background: the thumb must come from THEIR ink, not the page's. */
const OWN_SURFACES = [
  { name: 'fenced code block', markup: '<div class="md"><pre><code class="hljs">x</code></pre></div>', pick: 'pre' },
  { name: 'highlighted block', markup: '<pre class="hljs kt-code-block">x</pre>', pick: 'pre' },
  {
    name: 'terminal stage',
    markup: '<div class="kt-webterm__stage"><div class="kt-webterm__xterm">x</div></div>',
    pick: '.kt-webterm__xterm',
  },
  { name: 'utility code surface', markup: '<div class="bg-code-bg text-code-fg">x</div>', pick: 'div' },
  { name: 'file code pane', markup: '<div class="kt-fs-code">x</div>', pick: 'div' },
  {
    name: 'process body',
    markup: '<div class="fy-proc-body-wrap"><pre class="fy-proc-body">x</pre></div>',
    pick: 'pre',
  },
  { name: 'diff body', markup: '<div class="fy-diff"><pre class="fy-diff__body">x</pre></div>', pick: 'pre' },
] as const;

/** The contrast floor of a graphic object (WCAG 1.4.11): a scrollbar thumb against the surface it is drawn on. */
const THUMB_FLOOR = 3;

describe('a surface with its own background takes a thumb from its own ink', () => {
  let tab: Page;
  beforeAll(async () => {
    const context = await browser.newContext();
    tab = await context.newPage();
    // The theme tokens plus the app's base rule (the scrollbar block lives in `styles/index.css`); its `@import`s are skipped here.
    const base = readStyleFile('index.css').replace(/^@import .*$/gmu, '');
    await tab.setContent(
      `<!doctype html><html><head><style>${readThemeCss()}\n${base}</style></head><body></body></html>`,
    );
    await tab.evaluate(COLOUR_TOOLS);
  }, 60_000);

  const measure = (style: string, palette: string, mode: string) =>
    tab.evaluate(
      ([styleId, paletteId, tone, surfaces]) => {
        const root = document.documentElement;
        root.setAttribute('data-style', styleId as string);
        root.setAttribute('data-palette', paletteId as string);
        root.setAttribute('data-mode', tone as string);
        root.setAttribute('data-theme', `${paletteId}-${tone}`);
        const tools = (window as unknown as { __colour: import('../support/browser/index.ts').ColourTools }).__colour;
        const out: { name: string; ratio: number; hover: number; own: boolean }[] = [];
        for (const surface of surfaces as readonly { name: string; markup: string; pick: string }[]) {
          document.body.innerHTML = surface.markup;
          const holder = document.body.querySelector(surface.pick) as HTMLElement;
          // Every one of these surfaces paints `--code-bg` (its own rule, in a stylesheet this page does not load), so that is its fill.
          const colourOf = (token: string): [number, number, number, number] => {
            const probe = document.createElement('i');
            probe.style.background = `var(${token})`;
            holder.append(probe);
            const colour = tools.rgba(getComputedStyle(probe).backgroundColor);
            probe.remove();
            return colour;
          };
          const bg = tools.over(colourOf('--code-bg'), [255, 255, 255, 1]);
          const thumb = (token: string): number => tools.ratio(tools.over(colourOf(token), [...bg, 1]), bg);
          out.push({
            name: surface.name,
            ratio: thumb('--scrollbar-thumb'),
            hover: thumb('--scrollbar-thumb-hover'),
            // The surface's own selector took effect: its thumb IS the code thumb, not the page's.
            own:
              colourOf('--scrollbar-thumb').join() === colourOf('--scrollbar-code-thumb').join() &&
              colourOf('--scrollbar-thumb-hover').join() === colourOf('--scrollbar-code-thumb-hover').join(),
          });
        }
        return out;
      },
      [style, palette, mode, OWN_SURFACES] as const,
    );

  for (const mode of SCHEMES)
    for (const style of STYLE_IDS)
      it(`${style}, ${mode}: every palette keeps the thumb at ${THUMB_FLOOR}:1 on every own-background surface`, async () => {
        const failures: string[] = [];
        for (const palette of ALL_PALETTE_IDS)
          for (const row of await measure(style, palette, mode)) {
            if (!row.own) failures.push(`${palette} ${row.name}: the thumb is not drawn from the surface's own ink`);
            for (const [state, ratio] of [
              ['rest', row.ratio],
              ['hover', row.hover],
            ] as const)
              if (ratio < THUMB_FLOOR) failures.push(`${palette} ${row.name} ${state}: ${ratio.toFixed(2)}:1`);
          }
        expect(failures).toEqual([]);
      });
});

describe('a SelectBox list that overflows keeps its rows where they were', () => {
  for (const scheme of SCHEMES)
    it(`classic scrollbars at 1440, ${scheme}: the selected row's check does not move when the list grows past its max height`, async () => {
      const { tab, close } = await open(PAGES[2], VIEWPORTS[1], scheme, drawn, false);
      try {
        const geometry = await tab.evaluate(() => {
          const rows = (count: number): string =>
            Array.from(
              { length: count },
              (_, index) =>
                `<div class="fy-sb__opt" role="option" aria-selected="${index === 1}"><span class="fy-sb__text"><span class="fy-sb__label">Option ${index + 1}</span></span>${index === 1 ? '<svg class="fy-sb__check" width="16" height="16"></svg>' : ''}</div>`,
            ).join('');
          const host = document.createElement('div');
          host.className = 'fy-sb__popover';
          host.style.cssText = 'position:fixed;left:40px;top:40px;width:280px;z-index:50';
          host.innerHTML = '<div class="fy-sb__panel"><div class="fy-sb__list" role="listbox"></div></div>';
          document.body.append(host);
          const list = host.querySelector('.fy-sb__list') as HTMLElement;
          const measure = (count: number) => {
            list.innerHTML = rows(count);
            const check = list.querySelector('.fy-sb__check') as SVGElement;
            const row = list.querySelectorAll('.fy-sb__opt')[1] as HTMLElement;
            const listBox = list.getBoundingClientRect();
            return {
              overflows: list.scrollHeight > list.clientHeight,
              checkRight: check.getBoundingClientRect().right - listBox.left,
              rowWidth: row.getBoundingClientRect().width,
            };
          };
          return { few: measure(3), many: measure(60), few2: measure(3) };
        });
        expect(geometry.few.overflows, 'three rows fit').toBe(false);
        expect(geometry.many.overflows, 'sixty rows overflow').toBe(true);
        expect(geometry.many.checkRight, 'the check stays put once the list overflows').toBe(geometry.few.checkRight);
        expect(geometry.many.rowWidth, 'the row keeps its width once the list overflows').toBe(geometry.few.rowWidth);
        expect(geometry.few2.checkRight, 'and when it shrinks back').toBe(geometry.few.checkRight);
      } finally {
        await close();
      }
    });

  for (const scheme of SCHEMES)
    it(`the page shell reserves no empty strip at its right edge, ${scheme}`, async () => {
      const { tab, close } = await open(PAGES[0], VIEWPORTS[1], scheme, drawn, false);
      try {
        const shell = await tab.evaluate(() => ({
          gutter: getComputedStyle(document.documentElement).scrollbarGutter,
          strip: window.innerWidth - document.documentElement.clientWidth,
        }));
        expect(shell.gutter, 'the page names no scrollbar-gutter').toBe('auto');
        expect(shell.strip, 'the page does not scroll, so nothing is reserved').toBe(0);
      } finally {
        await close();
      }
    });
});

/** The shots the PR carries: a long list, the ferret console, Settings, a code block and a SelectBox list at both widths in both schemes (the terminal's come from the terminals plugin test). */
const SHOTS = [
  {
    name: 'long-list',
    page: PAGES[2],
    // A list longer than its box, in the same card the Settings page draws, scrolled so the thumb is mid-track.
    prepare: async (tab: Page) => {
      await tab.evaluate(() => {
        const box = document.createElement('div');
        box.style.cssText =
          'position:fixed;inset:12% 6%;overflow:auto;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px;z-index:50';
        box.innerHTML = Array.from(
          { length: 60 },
          (_, i) =>
            `<p style="margin:0;padding:10px 4px;border-bottom:1px solid var(--border)">Fake list row ${i + 1}</p>`,
        ).join('');
        document.body.append(box);
        box.scrollTop = 200;
      });
    },
  },
  {
    name: 'ferret-console',
    page: PAGES[1],
    prepare: async (tab: Page) => {
      const side = tab.locator('button[aria-label^="Show side panels"]');
      if ((await side.count()) > 0) await side.click();
      else await tab.getByRole('tab', { name: 'Console', exact: true }).click();
      await tab.waitForSelector('[data-panel="terminals.console"]');
      await tab.locator('[data-panel="terminals.console"]').scrollIntoViewIfNeeded();
      await tab.waitForTimeout(600);
    },
  },
  { name: 'settings', page: PAGES[2], prepare: async (_tab: Page) => {} },
  {
    name: 'code-block',
    page: PAGES[2],
    // A fenced block wider than its card, so the horizontal thumb shows, in the look the owner's contrast reading came from.
    prepare: async (tab: Page) => {
      await tab.evaluate(() => {
        const root = document.documentElement;
        root.dataset.style = 'briefing';
        root.dataset.palette = 'briefing';
        const card = document.createElement('div');
        card.className = 'md';
        card.style.cssText =
          'position:fixed;left:6%;top:12%;width:min(520px,88%);padding:12px;z-index:50;background:var(--surface);border:1px solid var(--border);border-radius:12px';
        const long =
          'const answer = await fetchTheThing({ endpoint: "/v1/fake", retries: 3, backoff: "exponential", jitter: true });';
        card.innerHTML = `<pre><code class="hljs">${Array.from({ length: 6 }, () => long).join('\n')}</code></pre>`;
        document.body.append(card);
      });
    },
  },
  {
    name: 'select-list',
    page: PAGES[2],
    // The SelectBox's own list classes, long enough to scroll, with the checked row near the top.
    prepare: async (tab: Page) => {
      await tab.evaluate(() => {
        const host = document.createElement('div');
        host.className = 'fy-sb__popover';
        host.style.cssText =
          'left:12%;top:12%;width:280px;z-index:50;background:var(--surface);border:1px solid var(--border);border-radius:12px';
        host.innerHTML = `<div class="fy-sb__panel"><div class="fy-sb__list" role="listbox">${Array.from(
          { length: 40 },
          (_, index) =>
            `<div class="fy-sb__opt" role="option"><span class="fy-sb__text"><span class="fy-sb__label">Option ${index + 1}</span></span>${index === 1 ? '<svg class="fy-sb__check" width="16" height="16" viewBox="0 0 16 16"><path d="M3 8l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2"/></svg>' : ''}</div>`,
        ).join('')}</div></div>`;
        document.body.append(host);
      });
    },
  },
] as const;

/**
 * The shots need scrollbars that DRAW: the shared Chromium keeps Playwright's `--hide-scrollbars`, and a phone-emulating context uses
 * overlay bars, so this block launches its own Chromium without that flag and shows 390 as a narrow desktop window (as the owner's
 * shots are). Local evidence only: it runs when `FY_SCROLLBAR_SHOTS_DIR` is set.
 */
describe.skipIf(shotsDir === '')('shots', () => {
  for (const viewport of VIEWPORTS)
    for (const scheme of SCHEMES)
      for (const shot of SHOTS)
        it(`${shot.name} at ${viewport.width}, ${scheme}`, async () => {
          const { tab, close } = await open(shot.page, viewport, scheme, drawn, false);
          try {
            await shot.prepare(tab);
            await tab.waitForTimeout(300);
            await tab.screenshot({ path: join(shotsDir, `${viewport.width}-${scheme}-${shot.name}.png`) });
          } finally {
            await close();
          }
        });
});
