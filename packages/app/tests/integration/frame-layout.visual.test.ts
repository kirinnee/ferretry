/**
 * THE FRAME LAYS OUT THE AGENDA AND THE FERRET PAGE, in a real browser, over fake data (`fixtures/frame-scene.tsx`):
 * the real shell, the default layout and the stylesheet that ships; no daemon.
 *
 *  - AGENDA PAGE: at 1280 the page column is as wide as v4's even while a background view draws a status line (that line
 *    used to be a column of the frame's own row and took ~400px from the page: the item column was 350px). The ⋯ menu's
 *    placement is the Agenda plugin's own visual test (`inbox-item-menu.visual.test.ts`).
 *  - FERRET PAGE: the side pane has its own column and scrolls, so every panel the default layout lists is reachable and
 *    the chat keeps most of the row; on a phone the pane does not crush the chat.
 *
 * Set `FY_LAYOUT_SHOTS_DIR` to keep `<viewport>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

// Each case drives a real browser through several taps and screenshots; the default 5s is too tight for a loaded machine.
setDefaultTimeout(30_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_LAYOUT_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

const build = async (): Promise<{ readonly css: string; readonly js: string }> => {
  directory = await mkdtemp(join(tmpdir(), 'ferretry-frame-layout-'));
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

const VIEWPORTS = [
  { name: '1280', width: 1_280, height: 800, phone: false },
  { name: '390', width: 390, height: 844, phone: true },
] as const;

const open = async (
  viewport: { readonly name: string; readonly width: number; readonly height: number; readonly phone: boolean },
  path: string,
  ready: string,
  query = '',
  theme = 'studio-light',
) => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: theme.endsWith('dark') ? 'dark' : 'light',
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
  await tab.goto(`${origin}${path}?theme=${theme}${query}`);
  try {
    await tab.waitForSelector(ready, { timeout: 8_000 });
    if (shotsDir !== '')
      await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${path.replaceAll('/', '_')}-opened.png`) });
  } catch (error) {
    throw new Error(`the scene did not draw ${ready}: ${String(error)}\n${problems.join('\n')}`);
  }
  return { tab, close: async () => await context.close() };
};

const shotOf = async (tab: Page, name: string): Promise<void> => {
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${name}.png`) });
};

const width = async (tab: Page, selector: string): Promise<number> =>
  await tab.evaluate(query => document.querySelector(query)?.getBoundingClientRect().width ?? -1, selector);

/** Whether the point at the centre of `selector` hits that element (or something inside it): not clipped, not covered. */
const hitsItself = async (tab: Page, selector: string): Promise<{ readonly hit: boolean; readonly left: number }> =>
  await tab.evaluate(query => {
    const element = document.querySelector(query);
    if (element === null) throw new Error(`nothing matches ${query}`);
    const box = element.getBoundingClientRect();
    const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { hit: at !== null && element.contains(at), left: box.left };
  }, selector);

describe('the agenda page with a status line drawn in flow', () => {
  it('at 1280 keeps v4’s page column and puts the line in a strip at the top of the body, across the page', async () => {
    const { tab, close } = await open(VIEWPORTS[0], '/d/ws/agenda', '[data-relay-fallback]');
    try {
      if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, '1280-agenda-page.png') });
      expect(await width(tab, '.fy-main'), 'the page column (v4: ~680px)').toBeGreaterThanOrEqual(680);
      const line = await tab.evaluate(() => {
        const box = (query: string) => document.querySelector(query)?.getBoundingClientRect();
        const note = box('[data-relay-fallback]');
        const top = box('.fy-body');
        const columns = box('.fy-columns');
        const body = box('.fy-body');
        return {
          noteLeft: note?.left ?? -1,
          noteRight: note?.right ?? -1,
          noteTop: note?.top ?? -1,
          noteBottom: note?.bottom ?? -1,
          topBottom: top?.top ?? -1,
          columnsTop: columns?.top ?? -1,
          bodyLeft: body?.left ?? -1,
          bodyRight: body?.right ?? -1,
        };
      });
      expect(line.noteTop, 'at the top of the body: no bar above it').toBeGreaterThanOrEqual(line.topBottom);
      expect(line.noteBottom, 'above the columns').toBeLessThanOrEqual(line.columnsTop);
      expect(line.noteLeft, 'the strip starts at the body’s left edge').toBeLessThanOrEqual(line.bodyLeft + 16);
    } finally {
      await close();
    }
  });

  it('at 390 keeps the page column at the phone’s width', async () => {
    const { tab, close } = await open(VIEWPORTS[1], '/d/ws/agenda', '[data-relay-fallback]');
    try {
      if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, '390-agenda-page.png') });
      expect(await width(tab, '.fy-main'), 'the page column').toBeGreaterThanOrEqual(330);
    } finally {
      await close();
    }
  });
});

describe('the ferrets page (the screen the side column holds)', () => {
  for (const viewport of VIEWPORTS)
    for (const mode of ['light', 'dark'] as const)
      it(`at ${viewport.name} in ${mode}: the list is drawn once, and Board in the nav is a real link`, async () => {
        const { tab, close } = await open(viewport, '/d/ws/ferrets', '[data-ferret-list]', '', `studio-${mode}`);
        try {
          await shotOf(tab, `${viewport.name}-ferrets-list-${mode}`);
          expect(
            await tab.locator('[data-ferret-list]').count(),
            'the list is drawn once, not in the page and the column',
          ).toBe(1);
          // The nav is docked in the drawer (r11 S1): a phone's drawer is shut behind its menu button.
          if (viewport.phone) {
            await tab.click('button[aria-label="Menu"]');
            await tab.waitForSelector('.fy-drawer--overlay');
          }
          const board = tab.locator('.fy-nav__item', { hasText: 'Board' });
          expect(await board.evaluate(node => node.tagName)).toBe('A');
          expect(await board.getAttribute('href')).toBe('/d/ws/board');
        } finally {
          await close();
        }
      });
});

describe('the ferret page', () => {
  it('at 1280 opens on the chat and the composer: the side column is closed until its toggle is pressed', async () => {
    const { tab, close } = await open(VIEWPORTS[0], '/d/ws/ferrets/zoe', '[data-chat]');
    try {
      await shotOf(tab, '1280-ferret-side-closed');
      expect(await tab.locator('[data-slot="ferret.side"]').count(), 'no side column drawn').toBe(0);
      expect(await tab.locator('[data-side-panel]:visible').count(), 'no panel on screen').toBe(0);
      const toggle = tab.locator('[data-side-toggle]');
      expect(await toggle.getAttribute('aria-expanded')).toBe('false');
      expect((await hitsItself(tab, '[data-side-toggle]')).hit, 'the toggle takes a press').toBe(true);
      const rail = await width(tab, '[data-side-rail]');
      expect(rail, 'a closed column costs a slim rail, not a column').toBeLessThanOrEqual(40);
      await toggle.click();
      await tab.waitForSelector('[data-slot="ferret.side"] [data-side-panel]');
      expect(await toggle.getAttribute('aria-expanded')).toBe('true');
      await toggle.click();
      expect(await tab.locator('[data-side-panel]:visible').count(), 'pressed again, it closes').toBe(0);
    } finally {
      await close();
    }
  });

  it('at 1280 gives the side pane its own scrolling column and keeps the chat most of the row', async () => {
    const { tab, close } = await open(VIEWPORTS[0], '/d/ws/ferrets/zoe', '[data-chat]');
    try {
      await tab.click('[data-side-toggle]');
      await tab.waitForSelector('[data-slot="ferret.side"] [data-side-panel]');
      const panels = await tab.locator('[data-slot="ferret.side"] [data-side-panel]').count();
      expect(panels, 'every panel the default layout lists is drawn').toBe(15);
      const slot = await tab.evaluate(() => {
        const element = document.querySelector('[data-slot="ferret.side"]') as HTMLElement;
        const box = element.getBoundingClientRect();
        return {
          width: box.width,
          height: box.height,
          scrolls: getComputedStyle(element).overflowY === 'auto' || getComputedStyle(element).overflowY === 'scroll',
        };
      });
      expect(slot.width, 'the pane is a column, not the chat’s width').toBeLessThanOrEqual(420);
      expect(slot.scrolls, 'the pane scrolls on its own').toBe(true);
      expect(slot.height, 'the pane is never taller than the window').toBeLessThanOrEqual(VIEWPORTS[0].height);
      expect(await width(tab, '[data-chat]'), 'the chat keeps the row').toBeGreaterThanOrEqual(400);
      if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, '1280-ferret-side-panels.png') });
      // The last panel is reachable: scrolled into its column it is on screen.
      await tab.locator('[data-side-panel="insights"]').scrollIntoViewIfNeeded();
      const insights = await hitsItself(tab, '[data-side-panel="insights"]');
      expect(insights.hit, 'the last panel can be reached').toBe(true);
      if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, '1280-ferret-side-panels-scrolled.png') });
    } finally {
      await close();
    }
  });

  it('at 1280 there is no chip row: the panels are beside the chat', async () => {
    const { tab, close } = await open(VIEWPORTS[0], '/d/ws/ferrets/zoe', '[data-chat]');
    try {
      expect(await tab.locator('[data-phone-tab-row]').count()).toBe(0);
    } finally {
      await close();
    }
  });

  // The toolbar (name, status, chips, Info, Actions, the switches, Lessons' scan bar) used to be one control per line, about
  // 330px of the page; the conversation got what was left: ~40px on a 713px laptop window, nothing on a phone.
  for (const viewport of [
    { name: '1280x713', width: 1_280, height: 713, phone: false },
    { name: '390x844', width: 390, height: 844, phone: true },
  ] as const)
    it(`at ${viewport.name} the toolbar is a compact row and the conversation keeps at least a third of the window`, async () => {
      const { tab, close } = await open(viewport, '/d/ws/ferrets/zoe', '[data-chat]');
      try {
        await shotOf(tab, `${viewport.name}-ferret-toolbar`);
        const boxes = await tab.evaluate(() => {
          const box = (query: string) => document.querySelector(query)?.getBoundingClientRect();
          return { toolbar: box('[data-slot="ferret.toolbar"]')?.height ?? -1, chat: box('[data-chat]')?.height ?? -1 };
        });
        expect(boxes.toolbar, 'the toolbar is drawn').toBeGreaterThan(0);
        expect(boxes.toolbar, 'the toolbar takes at most a third of the window').toBeLessThanOrEqual(
          viewport.height / 3,
        );
        expect(boxes.chat, 'the conversation keeps a third of the window').toBeGreaterThanOrEqual(viewport.height / 3);
        if (!viewport.phone) {
          // The real page at a laptop's height: after the toolbar and the composer the transcript still has room to read.
          const parts = await tab.evaluate(() => {
            const box = (query: string) => document.querySelector(query)?.getBoundingClientRect().height ?? -1;
            const pane = document.querySelector('[data-slot="ferret.side"]');
            return {
              transcript: box('[data-transcript]'),
              paneOverflowsSideways: pane === null ? false : pane.scrollWidth > pane.clientWidth + 1,
            };
          });
          expect(parts.transcript, 'the transcript is readable at a laptop height').toBeGreaterThanOrEqual(250);
          expect(parts.paneOverflowsSideways, 'a wide panel does not give the side pane a sideways scroll').toBe(false);
        }
        if (viewport.phone) {
          // A phone gets one line that scrolls sideways: at most ~15% of the screen, the conversation more than half of it,
          // and the controls a person reaches for (name, status, Actions) are inside the scrolling line without a swipe.
          expect(boxes.toolbar, 'a phone toolbar is one line').toBeLessThanOrEqual(viewport.height * 0.15);
          expect(boxes.chat, 'a phone keeps over half the screen for the conversation').toBeGreaterThan(
            viewport.height / 2,
          );
          const edges = await tab.evaluate(() => {
            const toolbar = document.querySelector('[data-slot="ferret.toolbar"]');
            const right = (suffix: string) =>
              toolbar?.querySelector(`:scope > [data-panel$="${suffix}"]`)?.getBoundingClientRect().right ??
              Number.POSITIVE_INFINITY;
            return {
              limit: toolbar?.getBoundingClientRect().right ?? 0,
              rights: ['.name', '.status', '.actions'].map(right),
            };
          });
          for (const edge of edges.rights)
            expect(edge, 'a first-line control is inside the visible line').toBeLessThanOrEqual(edges.limit - 12);
        }
      } finally {
        await close();
      }
    });

  it('at 390 the side pane does not crush the chat', async () => {
    const { tab, close } = await open(VIEWPORTS[1], '/d/ws/ferrets/zoe', '[data-chat]');
    try {
      if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, '390-ferret-page.png') });
      expect(await width(tab, '[data-chat]'), 'the chat takes the phone’s width').toBeGreaterThanOrEqual(330);
    } finally {
      await close();
    }
  });
});

/** Where the chrome is, and how far the page's own content has been carried, after every scroller has been pushed to its end. */
const scrolledToEnd = async (tab: Page) => {
  const filler = tab.locator('[data-tall-filler]').first();
  const before = await filler.evaluate(element => element.getBoundingClientRect().top);
  // A real wheel over the page body, then the document and every box that could scroll to their ends (the body of an
  // overflow:hidden page still scrolls programmatically, as a focused input or scrollIntoView does): whichever of them scrolls.
  const body = await tab.evaluate(() => {
    const box = document.querySelector('.fy-main')?.getBoundingClientRect();
    return { x: (box?.left ?? 0) + 40, y: (box?.top ?? 0) + 200 };
  });
  await tab.mouse.move(body.x, body.y);
  await tab.mouse.wheel(0, 4_000);
  await tab.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    for (const element of document.querySelectorAll<HTMLElement>(
      'body, #root, .fy-frame, .fy-body, .fy-columns, .fy-main, [data-chat]',
    ))
      element.scrollTop = element.scrollHeight;
  });
  await tab.waitForTimeout(150);
  return await tab.evaluate(
    ({ before: start }) => {
      const rect = (query: string) => document.querySelector(query)?.getBoundingClientRect();
      const nav = rect('.fy-nav');
      const top = rect('.fy-body');
      const filler = document.querySelector('[data-tall-filler]')?.getBoundingClientRect();
      return {
        window: { width: window.innerWidth, height: window.innerHeight },
        nav: { top: nav?.top ?? NaN, bottom: nav?.bottom ?? NaN, left: nav?.left ?? NaN, right: nav?.right ?? NaN },
        top: { top: top?.top ?? NaN, bottom: top?.bottom ?? NaN },
        carried: start - (filler?.top ?? start),
      };
    },
    { before },
  );
};

describe('the drawer and the body stay put while a tall page scrolls', () => {
  for (const viewport of VIEWPORTS)
    for (const [name, path, ready] of [
      ['agenda', '/d/ws/agenda', '[data-agenda-stand-in]'],
      ['ferret', '/d/ws/ferrets/zoe', '[data-chat]'],
    ] as const)
      it(`a tall ${name} page at ${viewport.name}: only the page body scrolls`, async () => {
        const { tab, close } = await open(viewport, path, ready, '&tall=1');
        try {
          const seen = await scrolledToEnd(tab);
          expect(seen.carried, 'the page body did scroll').toBeGreaterThan(200);
          // A ferret's own page puts the bar of places and the top bar away (chat-chrome.visual.test.ts): its one menu button is
          // the chrome that must stay put there.
          if ((await tab.locator('.fy-frame[data-chat-chrome]').count()) > 0 && seen.nav.right === 0) {
            const menu = await tab.evaluate(() => document.querySelector('.fy-chat-menu')?.getBoundingClientRect());
            const column = await tab.evaluate(() => document.querySelector('.fy-main')?.getBoundingClientRect().top);
            expect(menu?.top, 'the chat menu is still at the top of the page column').toBe(column);
            expect(menu?.bottom ?? Number.POSITIVE_INFINITY, 'the chat menu is still on screen').toBeLessThanOrEqual(
              seen.window.height,
            );
          } else {
            expect(seen.top.top, 'the body is still at the top of the window').toBeGreaterThanOrEqual(0);
            expect(seen.top.bottom, 'the body is still on screen').toBeLessThanOrEqual(seen.window.height);
            // The places are docked in the drawer (r11 S1): on a phone the drawer is shut, so there is no nav on the page at all.
            if (!Number.isNaN(seen.nav.top)) {
              expect(seen.nav.top, 'the nav starts inside the window').toBeGreaterThanOrEqual(0);
              expect(seen.nav.bottom, 'the nav is still inside the window').toBeLessThanOrEqual(seen.window.height);
              expect(seen.nav.right, 'the nav is still in view sideways').toBeGreaterThan(0);
            }
          }
          if (shotsDir !== '')
            await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${name}-page-scrolled.png`) });
        } finally {
          await close();
        }
      });
});

/** THE PHONE'S FERRET PAGE (v4's PhoneWorkspace): every `ferret.side` panel is one tap away, full width, one at a time. */
describe('the ferret page on a phone (390)', () => {
  const PHONE = VIEWPORTS[1];
  const READY = '[data-phone-tab-row] [data-phone-chip]';
  const CHIPS = [
    ['Chat', 'chat'],
    ['Console', 'stubs.console'],
    ['Processes', 'stubs.processes'],
    ['Terminals', 'stubs.terminals'],
    ['Browser', 'stubs.browser'],
    ['Files', 'stubs.files'],
  ] as const;

  it('offers v4’s chips in v4’s order: Chat, Console, Processes, Terminals, Browser, Files', async () => {
    const { tab, close } = await open(PHONE, '/d/ws/ferrets/zoe', READY);
    try {
      const labels = await tab.locator('[data-phone-tab-row] [role="tab"]').allInnerTexts();
      expect(labels.slice(0, 6)).toEqual(CHIPS.map(([label]) => label));
      expect(labels.length, 'one chip per panel the default layout places, and Chat').toBe(16);
      await shotOf(tab, '390-ferret-chip-chat');
    } finally {
      await close();
    }
  });

  it('reaches terminals, browser and files (and the rest): each chip shows its panel full width, alone', async () => {
    const { tab, close } = await open(PHONE, '/d/ws/ferrets/zoe', READY);
    try {
      for (const [label, key] of CHIPS.slice(1)) {
        await tab.click(`[data-phone-chip="${key}"]`);
        expect(await tab.getAttribute(`[data-phone-chip="${key}"]`, 'aria-selected'), `${label} is selected`).toBe(
          'true',
        );
        const id = key.split('.')[1] as string;
        const own = await hitsItself(tab, `[data-side-panel="${id}"]`);
        expect(own.hit, `${label}: its panel is on screen and takes a tap`).toBe(true);
        expect(await width(tab, `[data-panel="${key}"]`), `${label}: full width`).toBeGreaterThanOrEqual(340);
        const shown = await tab.locator('[data-side-panel]:visible').count();
        expect(shown, `${label}: one panel at a time`).toBe(1);
        expect(await tab.locator('[data-chat]:visible').count(), `${label}: the chat is behind it`).toBe(0);
        await shotOf(tab, `390-ferret-chip-${label.toLowerCase()}`);
      }
      await tab.click('[data-phone-chip="chat"]');
      expect(await tab.locator('[data-chat]:visible').count(), 'back on the chat').toBe(1);
      expect(await tab.locator('[data-side-panel]:visible').count(), 'no panel beside the chat').toBe(0);
    } finally {
      await close();
    }
  });

  it('every other panel the layout places is reachable too (the whole row scrolls)', async () => {
    const { tab, close } = await open(PHONE, '/d/ws/ferrets/zoe', READY);
    try {
      await tab.locator('[data-phone-chip="stubs.insights"]').scrollIntoViewIfNeeded();
      await tab.click('[data-phone-chip="stubs.insights"]');
      expect((await hitsItself(tab, '[data-side-panel="insights"]')).hit).toBe(true);
    } finally {
      await close();
    }
  });

  it('S-0075 a press in the Instructions list brings Files on screen: the workspace moves the chip, alone and full width', async () => {
    const { tab, close } = await open(PHONE, '/d/ws/ferrets/zoe', READY);
    try {
      await tab.locator('[data-phone-chip="stubs.instructions"]').scrollIntoViewIfNeeded();
      await tab.click('[data-phone-chip="stubs.instructions"]');
      expect(await tab.getAttribute('[data-phone-chip="stubs.instructions"]', 'aria-selected')).toBe('true');
      expect(await tab.locator('[data-side-panel="files"]:visible').count(), 'Files is behind Instructions').toBe(0);
      await tab.click('[data-open-in-files]');
      expect(
        await tab.getAttribute('[data-phone-chip="stubs.files"]', 'aria-selected'),
        'Files is the chip on show',
      ).toBe('true');
      expect(await tab.getAttribute('[data-phone-chip="stubs.instructions"]', 'aria-selected')).toBe('false');
      expect((await hitsItself(tab, '[data-side-panel="files"]')).hit, 'Files is on screen and takes a tap').toBe(true);
      expect(await tab.locator('[data-side-panel]:visible').count(), 'one panel at a time').toBe(1);
    } finally {
      await close();
    }
  });

  it('the + menu lists New terminal, New browser, Open file; each takes you to the panel that owns it', async () => {
    const { tab, close } = await open(PHONE, '/d/ws/ferrets/zoe', READY);
    try {
      await tab.click('[data-phone-new-tab]');
      await tab.waitForSelector('[role="menu"] [role="menuitem"]');
      const items = await tab.locator('[role="menu"] [role="menuitem"]').allInnerTexts();
      expect(items.map(text => text.trim())).toEqual(['New terminal', 'New browser', 'Open file']);
      for (const key of ['new-terminal', 'new-browser', 'open-file'])
        expect((await hitsItself(tab, `[data-menu-key="${key}"]`)).hit, `${key} takes a tap`).toBe(true);
      await shotOf(tab, '390-ferret-plus-menu');

      await tab.click('[role="menuitem"]:has-text("New terminal")');
      expect(await tab.getAttribute('[data-phone-chip="stubs.terminals"]', 'aria-selected')).toBe('true');
      expect(
        await tab.getAttribute('[data-side-panel="terminals"]', 'data-intent'),
        'the terminals panel was asked',
      ).toBe('new-terminal#1');

      await tab.click('[data-phone-new-tab]');
      await tab.click('[role="menuitem"]:has-text("New browser")');
      expect(await tab.getAttribute('[data-phone-chip="stubs.browser"]', 'aria-selected')).toBe('true');
      expect(await tab.getAttribute('[data-side-panel="browser"]', 'data-intent')).toBe('new-page#2');

      await tab.click('[data-phone-new-tab]');
      await tab.click('[role="menuitem"]:has-text("Open file")');
      expect(await tab.getAttribute('[data-phone-chip="stubs.files"]', 'aria-selected')).toBe('true');
      expect((await hitsItself(tab, '[data-side-panel="files"]')).hit).toBe(true);
    } finally {
      await close();
    }
  });

  it('is a keyboard tablist: arrows move focus and selection', async () => {
    const { tab, close } = await open(PHONE, '/d/ws/ferrets/zoe', READY);
    try {
      await tab.focus('[data-phone-chip="chat"]');
      await tab.keyboard.press('ArrowRight');
      expect(await tab.getAttribute('[data-phone-chip="stubs.console"]', 'aria-selected')).toBe('true');
      expect(await tab.evaluate(() => document.activeElement?.getAttribute('data-phone-chip'))).toBe('stubs.console');
      await tab.keyboard.press('End');
      expect(await tab.getAttribute('[data-phone-chip="stubs.insights"]', 'aria-selected')).toBe('true');
    } finally {
      await close();
    }
  });
});

// U-L: the default layout is v4's shell — the ferret list is a column on the LEFT of every page, the nav a short row of
// destinations (a phone keeps the bottom bar), and no second "Needs you" list under the nav. The same fake pages are what
// `v4-vs-v5` side-by-side shots are taken from (`FY_LAYOUT_SHOTS_DIR`, named `v5-<viewport>-<mode>-<page>.png`).
describe('the default shell is v4’s: ferret list on the left, a left drawer', () => {
  const SHELL_VIEWPORTS = [
    { name: 'desktop', width: 1_440, height: 900, phone: false },
    { name: 'phone', width: 390, height: 844, phone: true },
  ] as const;
  const PAGES = [
    { name: 'chat', path: '/d/ws/ferrets/zoe', ready: '[data-chat]' },
    { name: 'board', path: '/d/ws/board', ready: '.fy-main' },
  ] as const;

  for (const viewport of SHELL_VIEWPORTS)
    for (const mode of ['light', 'dark'] as const)
      for (const page of PAGES)
        it(`${viewport.name}, ${mode}, ${page.name}: ${viewport.phone ? 'no bottom bar (the nav is in the shut drawer), no side column' : 'list in the drawer left of the page with the nav docked under it, no top row'}, nothing overflows`, async () => {
          const { tab, close } = await open(viewport, page.path, page.ready, '&relay=0', `studio-${mode}`);
          try {
            await shotOf(tab, `v5-${viewport.name}-${mode}-${page.name}`);
            const geometry = await tab.evaluate(() => {
              const box = (query: string) => document.querySelector(query)?.getBoundingClientRect();
              const nav = document.querySelector('nav.fy-nav') as HTMLElement | null;
              const drawer = document.querySelector('.fy-drawer') as HTMLElement | null;
              return {
                navClass: nav?.className ?? '',
                topRow: document.querySelector('.fy-top, .fy-nav--top') !== null,
                drawerFill: drawer === null ? -1 : drawer.getBoundingClientRect().height,
                windowHeight: window.innerHeight,
                navOverflows: nav === null ? false : nav.scrollWidth > nav.clientWidth + 1,
                side: box('.fy-drawer__list'),
                main: box('.fy-main'),
                navPanels: document.querySelectorAll('[data-device-slot="nav"]').length,
                pageOverflows: document.documentElement.scrollWidth > window.innerWidth + 1,
              };
            });
            expect(geometry.navPanels, 'no second "Needs you" list in the nav').toBe(0);
            expect(geometry.navOverflows, 'the nav does not overflow').toBe(false);
            expect(geometry.pageOverflows, 'the page does not scroll sideways').toBe(false);
            if (viewport.phone) {
              expect(geometry.navClass, 'no bottom bar on a phone (owner, C2): the nav is in the drawer').toBe('');
              expect(geometry.side, 'a phone draws no side column').toBeUndefined();
            } else {
              expect(geometry.navClass).toContain('fy-nav--dock');
              expect(geometry.topRow, 'no row of places across the top').toBe(false);
              expect(geometry.drawerFill, 'the drawer runs the full height').toBeGreaterThanOrEqual(
                geometry.windowHeight - 1,
              );
              expect(geometry.side, 'the ferret list is drawn').not.toBeUndefined();
              expect(geometry.side?.right ?? 9_999, 'the list is left of the page').toBeLessThanOrEqual(
                geometry.main?.left ?? 0,
              );
              expect(geometry.side?.width ?? 0, 'a column, not half the row').toBeLessThanOrEqual(320);
            }
          } finally {
            await close();
          }
        });
});

// r8-SHELL: the left drawer collapses to a slim icon rail (Find's icon and the places), the page takes the room, and the
// choice is remembered on this device; on a phone the same drawer is an overlay opened by the menu button.
describe('the left drawer collapses to a rail and opens over a phone', () => {
  it('desktop: the toggle makes a slim rail, the page widens, and a reload keeps it', async () => {
    const { tab, close } = await open(VIEWPORTS[0], '/d/ws/board', '.fy-main', '&relay=0', 'studio-light');
    try {
      const wide = await tab.evaluate(() => document.querySelector('.fy-drawer')?.getBoundingClientRect().width ?? -1);
      const mainWide = await width(tab, '.fy-main');
      expect(await tab.locator('.fy-drawer__list [data-sbar-filter]').count(), 'Mine / All / Agents in the slot').toBe(
        3,
      );
      await shotOf(tab, 'v5-desktop-light-drawer-open');
      await tab.click('[data-drawer-toggle]');
      await tab.waitForSelector('.fy-drawer--rail');
      const rail = await tab.evaluate(() => document.querySelector('.fy-drawer')?.getBoundingClientRect().width ?? -1);
      expect(rail, 'a slim rail').toBeLessThanOrEqual(72);
      expect(rail, 'narrower than the open drawer').toBeLessThan(wide);
      expect(await width(tab, '.fy-main'), 'the page takes the room').toBeGreaterThan(mainWide);
      expect(await tab.locator('.fy-drawer--rail [data-drawer-find]').count(), 'the find icon is in the rail').toBe(1);
      expect(await tab.locator('.fy-drawer--rail .fy-drawer__list').count(), 'the list slot is put away').toBe(0);
      await shotOf(tab, 'v5-desktop-light-drawer-rail');
      await tab.reload();
      await tab.waitForSelector('.fy-drawer');
      expect(await tab.locator('.fy-drawer--rail').count(), 'remembered after a reload').toBe(1);
    } finally {
      await close();
    }
  });

  for (const mode of ['light', 'dark'] as const)
    it(`phone, ${mode}: the menu button opens the overlay over the page`, async () => {
      const { tab, close } = await open(VIEWPORTS[1], '/d/ws/board', '.fy-main', '&relay=0', `studio-${mode}`);
      try {
        expect(await tab.locator('.fy-drawer').count(), 'shut until asked').toBe(0);
        await tab.click('button[aria-label="Menu"]');
        await tab.waitForSelector('.fy-drawer--overlay');
        const box = await tab.evaluate(() => document.querySelector('.fy-drawer')?.getBoundingClientRect());
        expect(box?.left, 'from the left edge').toBe(0);
        expect(box?.height ?? 0, 'the full height').toBeGreaterThanOrEqual(840);
        // The same order as the wide drawer: places, then the ferret list (Mine / All / Agents and its ⋯ menu).
        expect(
          await tab.locator('.fy-drawer--overlay .fy-drawer__list [data-sbar-filter]').count(),
          'the list',
        ).toBeGreaterThan(0);
        await shotOf(tab, `v5-phone-${mode}-drawer-open`);
        await tab.click('.fy-drawer-scrim', { position: { x: 380, y: 400 } });
        expect(await tab.locator('.fy-drawer').count(), 'the scrim puts it away').toBe(0);
      } finally {
        await close();
      }
    });
});

describe('a slow daemon: ONE centred loader, never drawn over what is already drawn (o9-11, /new)', () => {
  const SLOW_MS = 1_500;
  for (const viewport of [
    { name: '1440', width: 1_440, height: 900, phone: false },
    { name: '390', width: 390, height: 844, phone: true },
  ] as const)
    for (const mode of ['light', 'dark'] as const)
      it(`${viewport.name} ${mode}: one loader while it waits, the form with nothing over it once it has drawn`, async () => {
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
        try {
          await tab.goto(`${origin}/d/ws/new?theme=studio-${mode}&relay=0&slow=${SLOW_MS}`);
          // In the page, in the body of the window: counted by what a person sees, not by which component drew it.
          await tab.waitForSelector('[data-loading="page"]', { timeout: 5_000 });
          await tab.waitForTimeout(650); // past the 300 ms threshold and the fade
          const waiting = await tab.evaluate(() => {
            const visible = (element: Element): boolean => {
              for (let node: Element | null = element; node !== null; node = node.parentElement)
                if (Number(getComputedStyle(node).opacity) <= 0.01) return false;
              return element.getBoundingClientRect().width > 0;
            };
            const loaders = [...document.querySelectorAll('[data-loading="page"]')].filter(visible);
            const main = document.querySelector('.fy-main')?.getBoundingClientRect();
            const box = loaders[0]?.getBoundingClientRect();
            return {
              count: loaders.length,
              inMain:
                box !== undefined && main !== undefined && box.left >= main.left - 1 && box.right <= main.right + 1,
              form: document.querySelectorAll('[data-new-ferret]').length,
              // The loader fills the area, it must not make the page scroll.
              scrolls:
                (document.querySelector('.fy-main')?.scrollHeight ?? 0) >
                (document.querySelector('.fy-main')?.clientHeight ?? 0) + 1,
              // How far the mark sits from the vertical middle of the page area (under the top bar), as a share of that area.
              offCentre:
                box !== undefined && main !== undefined
                  ? Math.abs((box.top + box.bottom) / 2 - (main.top + main.bottom) / 2) / main.height
                  : 1,
            };
          });
          await shotOf(tab, `o9-11-${viewport.name}-${mode}-1-waiting`);
          expect(waiting.count, 'one loader on screen').toBe(1);
          expect(waiting.inMain, 'centred in the page, not in the side column').toBe(true);
          expect(waiting.offCentre, 'centred vertically in the page area, not top-heavy').toBeLessThan(0.06);
          expect(waiting.scrolls, 'the loader does not make the page scroll').toBe(false);
          expect(waiting.form, 'nothing drawn yet').toBe(0);
          // Watch every 25 ms from the answer on: a loader (or a leftover copy of one) must never share the screen with the form.
          await tab.waitForSelector('[data-new-ferret]', { timeout: 6_000 });
          await shotOf(tab, `o9-11-${viewport.name}-${mode}-2-just-drawn`);
          const seen = await tab.evaluate(async () => {
            const overlaps: string[] = [];
            for (let at = 0; at < 1_500; at += 25) {
              const loader = document.querySelectorAll(
                '[data-loading], [data-loading-ghost], .fy-loading-ghost',
              ).length;
              const form = document.querySelectorAll('[data-new-ferret]').length;
              if (loader > 0 && form > 0) overlaps.push(`${at} ms: ${loader} loader(s) over the form`);
              await new Promise(resolve => setTimeout(resolve, 25));
            }
            return overlaps;
          });
          await shotOf(tab, `o9-11-${viewport.name}-${mode}-3-settled`);
          expect(seen).toEqual([]);
        } finally {
          await context.close();
        }
      }, 40_000);
});
