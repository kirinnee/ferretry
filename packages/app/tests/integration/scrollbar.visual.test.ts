/**
 * THE APP'S SCROLLBARS ARE THIN AND THEMED, EVERYWHERE (O9-7, owner: "Scrollbars are ugly everywhere (shots 2, 4, 6, 7)").
 *
 * ONE rule owns them (`styles/index.css`): `scrollbar-width: thin` and a `scrollbar-color` taken from the palette's `--muted`, so light,
 * dark and every palette pack follow. In a real browser over the REAL app (`fixtures/mobile-scene.tsx`), light and dark:
 *
 *  - the page and every scroll area a real page draws is thin and coloured: not the engine's default `auto` / `auto`, and a thumb that
 *    is not the track (a scrollbar cannot be seen if both are one colour), unless the component hides its own strip on purpose;
 *  - the three surfaces that used to restyle their own (a code block, a table, the xterm viewport) read the same two values as the page;
 *
 * `FY_SCROLLBAR_SHOTS_DIR=<dir>` keeps `<width>-<theme>-<name>.png` (local evidence for the PR, never committed).
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import { sceneServer, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(90_000);

const shotsDir = process.env.FY_SCROLLBAR_SHOTS_DIR ?? '';
const scene = new URL('./fixtures/mobile-scene.tsx', import.meta.url).pathname;

let browser: Browser;
let server: ReturnType<typeof Bun.spawn> | undefined;
let origin = '';

beforeAll(async () => {
  browser = await sharedChromium();
  server = Bun.spawn([process.execPath, sceneServer, '--entry', scene], { stderr: 'inherit', stdout: 'pipe' });
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
  const first = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the scene server did not start')), 120_000)),
  ]);
  origin = (JSON.parse(new TextDecoder().decode(first.value).trim().split('\n')[0] as string) as { origin: string })
    .origin;
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 240_000);

afterAll(() => {
  server?.kill();
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

describe('the three surfaces that used to restyle their own read the page rule', () => {
  for (const scheme of SCHEMES)
    it(`a code block, a table and the terminal viewport, ${scheme}`, async () => {
      const { tab, close } = await open(PAGES[2], VIEWPORTS[1], scheme);
      try {
        await tab.evaluate(() => {
          const probe = document.createElement('div');
          probe.id = 'sb-probe';
          probe.innerHTML =
            '<pre class="kt-code-block hljs scroll-thin" id="sb-code">x</pre>' +
            '<div class="md-table-scroll scroll-thin" id="sb-table">x</div>' +
            '<div class="kt-webterm__xterm"><div class="xterm"><div class="xterm-viewport" id="sb-term">x</div></div></div>' +
            '<div class="fy-sb__list" id="sb-list">x</div>';
          document.body.append(probe);
        });
        const page = await read(tab, ':root');
        for (const id of ['#sb-code', '#sb-table', '#sb-term', '#sb-list']) {
          const value = await read(tab, id);
          expect(value, `${id} reads the page rule`).toEqual(page);
        }
      } finally {
        await close();
      }
    });
});

/** The shots the PR carries: a long list, the ferret console, a terminal and Settings, at both widths in both schemes. */
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
  {
    name: 'terminal',
    page: PAGES[1],
    prepare: async (tab: Page) => {
      await tab.evaluate(() => {
        const frame = document.createElement('div');
        frame.className = 'kt-webterm__xterm';
        frame.style.cssText =
          'position:fixed;inset:auto;left:16px;top:96px;width:calc(100vw - 32px);max-width:none;height:60vh;z-index:50;border:1px solid var(--border)';
        const lines = Array.from({ length: 120 }, (_, i) => `$ build step ${i + 1}  ok  ${'.'.repeat(24)}`).join('\n');
        frame.innerHTML = `<div class="xterm" style="height:100%"><div class="xterm-viewport mono" style="height:100%;overflow-y:scroll;white-space:pre;padding:8px;background:#000">${lines}</div></div>`;
        document.body.append(frame);
        (frame.querySelector('.xterm-viewport') as HTMLElement).scrollTop = 300;
      });
    },
  },
  { name: 'settings', page: PAGES[2], prepare: async (_tab: Page) => {} },
] as const;

/**
 * The shots need scrollbars that DRAW: the shared Chromium keeps Playwright's `--hide-scrollbars`, and a phone-emulating context uses
 * overlay bars, so this block launches its own Chromium without that flag and shows 390 as a narrow desktop window (as the owner's
 * shots are). Local evidence only: it runs when `FY_SCROLLBAR_SHOTS_DIR` is set.
 */
describe.skipIf(shotsDir === '')('shots', () => {
  let drawn: Browser;
  beforeAll(async () => {
    drawn = await chromium.launch({
      executablePath: Bun.which('google-chrome') ?? Bun.which('chromium') ?? undefined,
      headless: true,
      ignoreDefaultArgs: ['--hide-scrollbars'],
    });
  }, 60_000);
  afterAll(async () => {
    await drawn?.close();
  });
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
