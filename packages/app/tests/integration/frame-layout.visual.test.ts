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

const open = async (viewport: (typeof VIEWPORTS)[number], path: string, ready: string, query = '') => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
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
  await tab.goto(`${origin}${path}?theme=studio-light${query}`);
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
  it('at 1280 keeps v4’s page column and puts the line in a strip under the top bar, across the page', async () => {
    const { tab, close } = await open(VIEWPORTS[0], '/d/ws/agenda', '[data-relay-fallback]');
    try {
      if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, '1280-agenda-page.png') });
      expect(await width(tab, '.fy-main'), 'the page column (v4: ~680px)').toBeGreaterThanOrEqual(680);
      const line = await tab.evaluate(() => {
        const box = (query: string) => document.querySelector(query)?.getBoundingClientRect();
        const note = box('[data-relay-fallback]');
        const top = box('.fy-top');
        const columns = box('.fy-columns');
        const body = box('.fy-body');
        return {
          noteLeft: note?.left ?? -1,
          noteRight: note?.right ?? -1,
          noteTop: note?.top ?? -1,
          noteBottom: note?.bottom ?? -1,
          topBottom: top?.bottom ?? -1,
          columnsTop: columns?.top ?? -1,
          bodyLeft: body?.left ?? -1,
          bodyRight: body?.right ?? -1,
        };
      });
      expect(line.noteTop, 'under the top bar').toBeGreaterThanOrEqual(line.topBottom);
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

describe('the ferret page', () => {
  it('at 1280 gives the side pane its own scrolling column and keeps the chat most of the row', async () => {
    const { tab, close } = await open(VIEWPORTS[0], '/d/ws/ferrets/zoe', '[data-slot="ferret.side"] [data-side-panel]');
    try {
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
      const top = rect('.fy-top');
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

describe('the nav and the top bar stay put while a tall page scrolls', () => {
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
          expect(seen.top.top, 'the top bar is still at the top of the window').toBeGreaterThanOrEqual(0);
          expect(seen.top.bottom, 'the top bar is still on screen').toBeLessThanOrEqual(seen.window.height);
          expect(seen.nav.top, 'the nav starts inside the window').toBeGreaterThanOrEqual(0);
          expect(seen.nav.bottom, 'the nav is still inside the window').toBeLessThanOrEqual(seen.window.height);
          expect(seen.nav.right, 'the nav is still in view sideways').toBeGreaterThan(0);
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
