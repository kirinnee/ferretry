/**
 * r11 S1: THE NAV IS DOCKED AT THE FOOT OF THE SIDEBAR, ICONS OR WORDS, in a real browser, over fake data
 * (`fixtures/frame-scene.tsx`): the real shell, the default layout and the stylesheet that ships; no daemon.
 *
 * The owner's words: "i prefer having the nav at the bottom of the sidebar as icons, or as words (Allow user to choose)
 * for the default. having them at the bottom bar takes up alot of space (for the chat esp) and on the side, takes up alot
 * of the convo" and, for phones (C2): the same as desktop: the nav sits in the drawer, at its foot, no bottom bar.
 * And: "Conversations" is a default nav place.
 *
 * Set `FY_LAYOUT_SHOTS_DIR` to keep `<name>.png` shots.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_LAYOUT_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-nav-dock-'));
  const child = Bun.spawn(
    [process.execPath, sceneBuilder, '--out', directory, '--entry', resolve(packageRoot, 'fixtures/frame-scene.tsx')],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the frame scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  return { css: await readFile(manifest.css, 'utf8'), js: await readFile(manifest.js, 'utf8') };
};

beforeAll(async () => {
  browser = await sharedChromium();
  const { css, js } = await build();
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body class="bg-bg text-fg"><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const path = new URL(request.url).pathname;
      if (path === '/app.js') return new Response(js, { headers: { 'content-type': 'text/javascript' } });
      return new Response(page, { headers: { 'content-type': 'text/html' } });
    },
  });
  if (shotsDir !== '') await mkdir(shotsDir, { recursive: true });
}, 180_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

interface Viewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly phone: boolean;
}
const WIDE: Viewport = { name: '1280', width: 1_280, height: 800, phone: false };
const PHONE: Viewport = { name: '390', width: 390, height: 844, phone: true };

const open = async (viewport: Viewport, path: string, query: string, mode: 'light' | 'dark' = 'light') => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: mode,
    deviceScaleFactor: viewport.phone ? 2 : 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(8_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}${path}?theme=studio-${mode}&relay=0${query}`);
  try {
    await tab.waitForSelector('.fy-main', { timeout: 8_000 });
  } catch (error) {
    throw new Error(`the scene did not draw: ${String(error)}\n${problems.join('\n')}`);
  }
  return { tab, close: async () => await context.close() };
};

const shotOf = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}.png`) });
};

interface Box {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/** What the nav, the drawer and the ferret list measure to, in one read. */
const measure = async (tab: Page) =>
  await tab.evaluate(() => {
    const box = (element: Element | null | undefined): Box | undefined => {
      if (element === null || element === undefined) return undefined;
      const { top, bottom, left, right } = element.getBoundingClientRect();
      return { top, bottom, left, right };
    };
    const dock = document.querySelector('nav[data-nav="dock"]');
    const items = [...document.querySelectorAll('nav[data-nav="dock"] .fy-nav__item')].map(item => {
      const label = item.querySelector('.fy-nav__label');
      const shown =
        label !== null && getComputedStyle(label).display !== 'none' && label.getBoundingClientRect().width > 0;
      return {
        name: (item.querySelector('.sr-only, .fy-nav__label')?.textContent ?? '').trim(),
        tooltip: item.getAttribute('title') ?? '',
        visibleWord: shown ? (label?.textContent ?? '').trim() : '',
        box: box(item) as Box,
        overflows: item.scrollWidth > item.clientWidth + 1,
        // A word cut short with an ellipsis: the label's own text is wider than the box it has.
        wordCut: label !== null && label.scrollWidth > label.clientWidth + 1,
        weight: Number.parseInt(getComputedStyle(item).fontWeight, 10),
        current: item.getAttribute('aria-current') === 'page',
        boxShadow: getComputedStyle(item).boxShadow,
        borderLeft: getComputedStyle(item).borderLeftWidth,
        icon: item.querySelector('svg') !== null,
      };
    });
    const first = document.querySelector('.fy-drawer .fy-search, .fy-drawer [data-drawer-find]');
    return {
      window: { width: window.innerWidth, height: window.innerHeight },
      dock: box(dock),
      dockOverflows: dock === null ? true : dock.scrollWidth > dock.clientWidth + 1,
      drawer: box(document.querySelector('.fy-drawer')),
      list: box(document.querySelector('.fy-drawer__list')),
      find: box(first),
      columns: box(document.querySelector('.fy-columns')),
      main: box(document.querySelector('.fy-main')),
      bottomBars: document.querySelectorAll('[data-nav="bottom"], nav.fy-nav--bottom, [data-slot="bottom"]').length,
      listAtTop: document.querySelectorAll('.fy-drawer nav.fy-nav--drawer').length,
      items,
      pageOverflows: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });

/** With `FY_LAYOUT_SHOTS_DIR` set, the measured numbers are kept beside the shots (they go in the PR body). */
const keep = async (name: string, seen: Awaited<ReturnType<typeof measure>>): Promise<void> => {
  if (shotsDir === '') return;
  const { items, ...rest } = seen;
  await writeFile(
    join(shotsDir, `${name}.json`),
    JSON.stringify(
      { ...rest, items: items.map(item => ({ name: item.name, box: item.box, weight: item.weight })) },
      null,
      1,
    ),
  );
};

const near = (a: number, b: number, tolerance: number): boolean => Math.abs(a - b) <= tolerance;

describe('r11 S1: the nav sits at the foot of the sidebar (default layout)', () => {
  for (const mode of ['light', 'dark'] as const)
    it(`1280, ${mode}: icons at the drawer's foot, under the ferret list; no bottom bar; the chat has the full height`, async () => {
      const { tab, close } = await open(WIDE, '/d/ws/ferrets/zoe', '', mode);
      try {
        const seen = await measure(tab);
        await shotOf(tab, `r11-s1-1280-icons-${mode}`);
        await keep(`r11-s1-1280-icons-${mode}`, seen);
        expect(seen.dock, 'a docked nav is drawn').toBeDefined();
        expect(
          seen.drawer && seen.dock && seen.drawer.bottom - seen.dock.bottom,
          'the dock ends within 16px of the drawer foot',
        ).toBeLessThanOrEqual(16);
        expect(seen.dock?.bottom ?? 0, 'inside the drawer').toBeLessThanOrEqual((seen.drawer?.bottom ?? 0) + 1);
        expect(seen.list?.bottom ?? 9_999, 'below the ferret list').toBeLessThanOrEqual((seen.dock?.top ?? 0) + 1);
        expect(seen.listAtTop, 'no list of places at the top of the drawer').toBe(0);
        expect(seen.bottomBars, 'no bottom bar in the DOM').toBe(0);
        expect(seen.columns?.bottom, 'the page column runs to the window foot').toBe(seen.window.height);
        expect(seen.main?.bottom, 'the chat column is as tall as the window').toBe(seen.window.height);
        expect(seen.items.length, 'every default place is in the dock').toBeGreaterThanOrEqual(6);
        for (const item of seen.items) {
          expect(item.icon, `${item.name} has an icon`).toBe(true);
          expect(item.name.length, 'each icon has an accessible name').toBeGreaterThan(0);
          expect(item.tooltip, `${item.name} has a tooltip`).toBe(item.name);
          expect(item.visibleWord, `${item.name}: icons mode shows no word`).toBe('');
        }
        expect(
          seen.items.map(item => item.name),
          'Conversations is a default place',
        ).toContain('Conversations');
        expect(seen.dockOverflows, 'the dock does not overflow').toBe(false);
        expect(new Set(seen.items.map(item => Math.round(item.box.top))).size, 'one row of icons').toBe(1);
      } finally {
        await close();
      }
    });

  it('1280: the words form shows each word and every item fits the drawer width', async () => {
    const { tab, close } = await open(WIDE, '/d/ws/agenda', '&nav=words');
    try {
      const seen = await measure(tab);
      await shotOf(tab, 'r11-s1-1280-words-light');
      await keep('r11-s1-1280-words-light', seen);
      expect(seen.items.length).toBeGreaterThanOrEqual(6);
      for (const item of seen.items) {
        expect(item.visibleWord.length, `${item.name} shows its word`).toBeGreaterThan(0);
        expect(item.overflows, `${item.name} fits its cell`).toBe(false);
        expect(item.wordCut, `${item.name} is whole, not cut short`).toBe(false);
        expect(item.box.right, `${item.name} is inside the drawer`).toBeLessThanOrEqual((seen.drawer?.right ?? 0) + 1);
      }
      expect(seen.dockOverflows, 'the dock does not overflow').toBe(false);
      expect(
        seen.drawer?.bottom && seen.dock && seen.drawer.bottom - seen.dock.bottom,
        'still at the foot',
      ).toBeLessThanOrEqual(16);
      expect(seen.listAtTop).toBe(0);
    } finally {
      await close();
    }
  });

  it('1280: the current place reads by fill and weight, with no bar beside it', async () => {
    const { tab, close } = await open(WIDE, '/d/ws/agenda', '');
    try {
      const seen = await measure(tab);
      const current = seen.items.filter(item => item.current);
      expect(current.map(item => item.name)).toEqual(['Agenda']);
      expect(current[0]?.weight, 'stronger weight').toBeGreaterThanOrEqual(600);
      expect(current[0]?.boxShadow, 'no inset bar').toBe('none');
      expect(current[0]?.borderLeft, 'no left border bar').toBe('0px');
      for (const item of seen.items.filter(entry => !entry.current)) expect(item.weight).toBeLessThan(600);
    } finally {
      await close();
    }
  });

  it('1280: collapsed to the rail, the icons stack at the rail’s foot', async () => {
    const { tab, close } = await open(WIDE, '/d/ws/board', '');
    try {
      await tab.click('[data-drawer-toggle]');
      await tab.waitForSelector('.fy-drawer--rail');
      const seen = await measure(tab);
      await shotOf(tab, 'r11-s1-1280-rail-light');
      await keep('r11-s1-1280-rail-light', seen);
      expect(seen.drawer?.right ?? 9_999, 'a slim rail').toBeLessThanOrEqual(72);
      expect(seen.drawer && seen.dock && seen.drawer.bottom - seen.dock.bottom, 'at the rail foot').toBeLessThanOrEqual(
        16,
      );
      expect(seen.items.length).toBeGreaterThanOrEqual(6);
      const lefts = new Set(seen.items.map(item => Math.round(item.box.left)));
      expect(lefts.size, 'one column of icons').toBe(1);
      const tops = seen.items.map(item => item.box.top);
      expect(tops, 'stacked top to bottom').toEqual([...tops].sort((a, b) => a - b));
      expect(
        seen.items.every(item => item.box.right <= (seen.drawer?.right ?? 0) + 1),
        'inside the rail',
      ).toBe(true);
      expect(seen.listAtTop).toBe(0);
    } finally {
      await close();
    }
  });
});

describe('r11 S1: phones follow desktop (owner answer C2): the nav is in the drawer, at its foot, with no bottom bar', () => {
  for (const mode of ['light', 'dark'] as const)
    it(`390, ${mode}: no bottom bar; the menu opens the drawer with the dock at its foot`, async () => {
      const { tab, close } = await open(PHONE, '/d/ws/board', '', mode);
      try {
        const shut = await measure(tab);
        expect(shut.bottomBars, 'no bottom bar on a phone').toBe(0);
        expect(shut.dock, 'the drawer is shut: no dock on the page').toBeUndefined();
        expect(shut.main?.bottom, 'the chat column runs to the window foot').toBe(shut.window.height);
        await tab.click('button[aria-label="Menu"]');
        await tab.waitForSelector('.fy-drawer--overlay');
        const seen = await measure(tab);
        await shotOf(tab, `r11-s1-390-drawer-${mode}`);
        await keep(`r11-s1-390-drawer-${mode}`, seen);
        expect(seen.dock, 'the dock is in the drawer').toBeDefined();
        expect(
          seen.drawer && seen.dock && seen.drawer.bottom - seen.dock.bottom,
          'at the drawer foot',
        ).toBeLessThanOrEqual(56);
        expect(seen.list?.bottom ?? 9_999, 'below the ferret list').toBeLessThanOrEqual((seen.dock?.top ?? 0) + 1);
        expect(seen.listAtTop).toBe(0);
        expect(seen.dockOverflows).toBe(false);
        // A finger-sized cell is 44px, and seven are wider than the drawer: a grid of four to a row, evenly spaced.
        const rows = new Set(seen.items.map(item => Math.round(item.box.top)));
        expect(rows.size, 'two short rows of icons').toBe(2);
        const widths = new Set(seen.items.map(item => Math.round(item.box.right - item.box.left)));
        expect(widths.size, 'every cell the same width').toBe(1);
        expect(seen.pageOverflows).toBe(false);
        for (const item of seen.items) {
          expect(item.box.right, `${item.name} is inside the drawer`).toBeLessThanOrEqual(
            (seen.drawer?.right ?? 0) + 1,
          );
          expect(item.box.right - item.box.left, `${item.name} is a touch target`).toBeGreaterThanOrEqual(40);
        }
        // A place chosen shuts the drawer and goes there.
        await tab.click('nav[data-nav="dock"] a[title="Board"]');
        await tab.waitForURL('**/d/ws/board*');
        expect(await tab.locator('.fy-drawer').count(), 'the drawer shuts on a place').toBe(0);
      } finally {
        await close();
      }
    });

  it('390: the words form fits the drawer', async () => {
    const { tab, close } = await open(PHONE, '/d/ws/board', '&nav=words');
    try {
      await tab.click('button[aria-label="Menu"]');
      await tab.waitForSelector('.fy-drawer--overlay');
      const seen = await measure(tab);
      await shotOf(tab, 'r11-s1-390-words-light');
      await keep('r11-s1-390-words-light', seen);
      for (const item of seen.items) {
        expect(item.visibleWord.length, `${item.name} shows its word`).toBeGreaterThan(0);
        expect(item.overflows).toBe(false);
        expect(item.wordCut, `${item.name} is whole, not cut short`).toBe(false);
        expect(item.box.right).toBeLessThanOrEqual((seen.drawer?.right ?? 0) + 1);
      }
      expect(seen.dockOverflows).toBe(false);
    } finally {
      await close();
    }
  });
});

describe('r11 S1: the other forms stay one switch away in Settings › Layout', () => {
  it('the phone bottom bar is still there when the phone switch asks for it (no dock beside it)', async () => {
    const { tab, close } = await open(PHONE, '/d/ws/board', '&phonenav=bottom');
    try {
      const seen = await measure(tab);
      expect(seen.bottomBars, 'the bar is drawn').toBeGreaterThan(0);
      expect(
        near(
          seen.window.height,
          await tab.evaluate(() => document.querySelector('.fy-nav--bottom')?.getBoundingClientRect().bottom ?? -1),
          1,
        ),
        'at the window foot',
      ).toBe(true);
    } finally {
      await close();
    }
  });

  it('the desktop “Side list” form draws the list at the top of the drawer and no dock', async () => {
    const { tab, close } = await open(WIDE, '/d/ws/board', '&nav=list');
    try {
      const seen = await measure(tab);
      expect(seen.listAtTop, 'a list of places in the drawer').toBe(1);
      expect(seen.dock, 'no dock').toBeUndefined();
      expect(seen.bottomBars).toBe(0);
    } finally {
      await close();
    }
  });

  it('the desktop “Bottom bar” form draws the bar and no dock', async () => {
    const { tab, close } = await open(WIDE, '/d/ws/board', '&nav=bottom');
    try {
      const seen = await measure(tab);
      expect(seen.bottomBars, 'the bar').toBeGreaterThan(0);
      expect(seen.dock, 'no dock').toBeUndefined();
    } finally {
      await close();
    }
  });
});
