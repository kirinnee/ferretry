/**
 * THE FERRET PAGE'S SIDE PANEL IS A RESIZABLE ROW OF TABS, in a real browser, over fake data: the REAL app over the REAL
 * generated plugins (`fixtures/ferret-asks-scene.tsx`), reached the way a person reaches it (O9 item 12, the owner's shots 5/6).
 *
 *  - the toggle is a quiet icon (no bordered box) that opens the column on its first tab, the Console, and hides it again;
 *  - Terminal and Browser are TABS: one panel on show, never stacked;
 *  - the divider is DRAGGABLE with a real mouse and with the keyboard, inside its range, and the width survives a reload;
 *  - the tab row and the panel clip no text at the narrowest width the divider allows;
 *  - a stopped ferret says "Resume" beside its state, a running one "Stop";
 *  - a phone keeps its chip row: Chat, then one panel at a time.
 *
 * Set `FY_FERRET_SIDE_SHOTS_DIR` to keep `<viewport>-<mode>-<case>.png`.
 */
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { sceneBuilder, sharedChromium } from '../support/browser/index.ts';

setDefaultTimeout(60_000);

const packageRoot = import.meta.dir;
const shotsDir = process.env.FY_FERRET_SIDE_SHOTS_DIR ?? '';

let browser: Browser;
let directory = '';
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  browser = await sharedChromium();
  directory = await mkdtemp(join(tmpdir(), 'ferretry-ferret-side-'));
  const child = Bun.spawn(
    [
      process.execPath,
      sceneBuilder,
      '--out',
      directory,
      '--entry',
      resolve(packageRoot, 'fixtures/ferret-asks-scene.tsx'),
    ],
    { cwd: packageRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`the ferret scene did not build (${code}):\n${stderr}\n${stdout}`);
  const manifest = JSON.parse(stdout.trim().split('\n').at(-1) as string) as { css: string; js: string };
  const css = await readFile(manifest.css, 'utf8');
  const js = await readFile(manifest.js, 'utf8');
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
}, 240_000);

afterAll(async () => {
  server?.stop(true);
  if (directory !== '') await rm(directory, { force: true, recursive: true });
});

const DESK = { name: '1440', width: 1_440, height: 900, phone: false } as const;
const PHONE = { name: '390', width: 390, height: 844, phone: true } as const;
type Viewport = typeof DESK | typeof PHONE;
type Mode = 'light' | 'dark';
const MODES: readonly Mode[] = ['light', 'dark'];

const TOGGLE = '[data-side-toggle]';
/** The toggle a person can see: a closed column keeps its own hidden one inside it. */
const TOGGLE_SHOWN = '[data-side-toggle]:visible';
const ASIDE = '[data-ferret-side]';
const HANDLE = '[data-resize-handle="ferret-side"]';
const TABS = `${ASIDE} [role="tab"]`;

const open = async (viewport: Viewport, mode: Mode, query = '') => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: mode,
    deviceScaleFactor: 1,
    hasTouch: viewport.phone,
    isMobile: viewport.phone,
  });
  const origin = server?.url.origin ?? '';
  await context.route('**/*', async route =>
    new URL(route.request().url()).origin === origin ? await route.continue() : await route.abort(),
  );
  const tab = await context.newPage();
  tab.setDefaultTimeout(15_000);
  const problems: string[] = [];
  tab.on('pageerror', error => problems.push(error.message));
  await tab.goto(`${origin}/d/ws/ferrets/zoe/chat?theme=studio-${mode}&agenda=off&asks=0${query}`);
  const entry = viewport.phone ? '[data-phone-chip]' : TOGGLE;
  try {
    await tab.waitForSelector(entry, { timeout: 20_000 });
  } catch (error) {
    throw new Error(`the scene did not draw ${entry}: ${String(error)}\n${problems.join('\n')}`);
  }
  return { tab, problems, close: async () => await context.close() };
};

/** Waits for every loading state to be gone and the page to stop moving, so a screenshot shows the settled page. */
const calm = async (tab: Page): Promise<void> => {
  await tab.waitForFunction(() => document.querySelector('[data-loading]') === null, undefined, { timeout: 20_000 });
  await tab.waitForTimeout(250);
};

const shot = async (tab: Page, viewport: Viewport, mode: Mode, name: string): Promise<void> => {
  await calm(tab);
  if (shotsDir !== '') await tab.screenshot({ path: join(shotsDir, `${viewport.name}-${mode}-${name}.png`) });
};

const widthOf = async (tab: Page, selector: string): Promise<number> =>
  await tab.evaluate(query => document.querySelector(query)?.getBoundingClientRect().width ?? -1, selector);

const shownPanels = async (tab: Page): Promise<string[]> =>
  await tab.evaluate(
    aside =>
      [...document.querySelectorAll(`${aside} [data-panel][data-phone-shown]`)]
        .filter(node => (node as HTMLElement).getBoundingClientRect().height > 0)
        .map(node => node.getAttribute('data-panel') ?? ''),
    ASIDE,
  );

/** Elements inside `scope` whose own text is cut off by a hidden overflow with no ellipsis to say so (the owner's "clips text"). */
const clippedText = async (tab: Page, scope: string): Promise<string[]> =>
  await tab.evaluate(query => {
    const root = document.querySelector(query);
    if (root === null) throw new Error(`nothing matches ${query}`);
    const cut: string[] = [];
    for (const element of root.querySelectorAll<HTMLElement>('*')) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || element.clientWidth === 0) continue;
      const hidden = style.overflowX === 'hidden' || style.overflowX === 'clip';
      if (!hidden || element.scrollWidth <= element.clientWidth + 1) continue;
      if (style.textOverflow === 'ellipsis') continue;
      if (element.closest('canvas, .xterm, [data-terminal-surface], .sr-only') !== null) continue;
      if ((element.textContent ?? '').trim() === '') continue;
      cut.push(
        `${element.tagName.toLowerCase()}.${element.className} "${(element.textContent ?? '').trim().slice(0, 40)}"`,
      );
    }
    return cut;
  }, scope);

const openColumn = async (tab: Page): Promise<void> => {
  await tab.locator(TOGGLE_SHOWN).click();
  await tab.waitForSelector(`${ASIDE} [role="tab"]`);
  await calm(tab);
};

/** The chat is what is left of the row: the first thing in the row that holds the column. */
const chatWidth = async (tab: Page): Promise<number> =>
  await tab.evaluate(
    aside => document.querySelector(aside)?.parentElement?.firstElementChild?.getBoundingClientRect().width ?? -1,
    ASIDE,
  );

const drag = async (tab: Page, dx: number): Promise<void> => {
  const box = await tab.locator(HANDLE).boundingBox();
  if (box === null) throw new Error('no divider');
  const x = box.x;
  const y = box.y + box.height / 2;
  await tab.mouse.move(x, y);
  await tab.mouse.down();
  await tab.mouse.move(x + dx / 2, y, { steps: 4 });
  await tab.mouse.move(x + dx, y, { steps: 4 });
  await tab.mouse.up();
};

describe('the ferret page’s side panel at a desk', () => {
  for (const mode of MODES) {
    it(`${mode}: the toggle is a quiet icon, and it opens the column on the Console and hides it again`, async () => {
      const { tab, close } = await open(DESK, mode);
      try {
        await shot(tab, DESK, mode, 'closed');
        const border = await tab.evaluate(
          query => getComputedStyle(document.querySelector(query) as HTMLElement).borderTopWidth,
          TOGGLE,
        );
        expect(border, 'the toggle has no bordered box').toBe('0px');
        expect(await tab.locator(ASIDE).count(), 'closed draws no column').toBe(0);
        await openColumn(tab);
        const labels = await tab.locator(TABS).allInnerTexts();
        expect(labels[0], 'the Console is the first tab, so it is easy to find').toBe('Console');
        expect(labels).toEqual(expect.arrayContaining(['Processes', 'Terminals', 'Browser', 'Files']));
        expect(await shownPanels(tab)).toEqual(['terminals.console']);
        expect(await tab.locator(TOGGLE_SHOWN).count(), 'one toggle, in the tab row').toBe(1);
        expect(await tab.locator(`${ASIDE} ${TOGGLE_SHOWN}`).count()).toBe(1);
        await shot(tab, DESK, mode, 'open-console');
        await tab.locator(TOGGLE_SHOWN).click();
        expect(await tab.locator(ASIDE).isVisible(), 'pressed again it hides').toBe(false);
        await tab.locator(TOGGLE_SHOWN).click();
        expect(await shownPanels(tab), 'and it comes back on the same tab').toEqual(['terminals.console']);
      } finally {
        await close();
      }
    });

    it(`${mode}: Terminal and Browser are tabs, one panel at a time, and neither clips its text`, async () => {
      const { tab, close } = await open(DESK, mode);
      try {
        await openColumn(tab);
        await tab.locator(TABS, { hasText: 'Terminals' }).click();
        await calm(tab);
        expect(await shownPanels(tab)).toEqual(['terminals.terminals']);
        expect(await clippedText(tab, ASIDE), 'the Terminal tab clips no text').toEqual([]);
        await shot(tab, DESK, mode, 'open-terminal');
        await tab.locator(TABS, { hasText: 'Browser' }).click();
        await calm(tab);
        expect(await shownPanels(tab)).toEqual(['browsers.browser']);
        expect(await clippedText(tab, ASIDE), 'the Browser tab clips no text').toEqual([]);
        await shot(tab, DESK, mode, 'open-browser');
        expect(await tab.getAttribute(`${ASIDE} [data-phone-chip="browsers.browser"]`, 'aria-selected')).toBe('true');
      } finally {
        await close();
      }
    });
  }

  it('dragging the divider with a mouse resizes the column inside its range, and a reload keeps the width', async () => {
    const { tab, close } = await open(DESK, 'light');
    try {
      await openColumn(tab);
      const before = await widthOf(tab, ASIDE);
      await drag(tab, -120);
      const wider = await widthOf(tab, ASIDE);
      expect(wider, 'dragged left, it is about 120px wider').toBeGreaterThanOrEqual(before + 110);
      expect(wider).toBeLessThanOrEqual(before + 130);
      await drag(tab, -2_000);
      expect(await widthOf(tab, ASIDE), 'never wider than its maximum').toBe(720);
      await drag(tab, 2_000);
      expect(await widthOf(tab, ASIDE), 'never narrower than its minimum').toBe(300);
      await drag(tab, -200);
      const kept = await widthOf(tab, ASIDE);
      expect(kept).toBe(500);
      await tab.reload();
      await tab.waitForSelector(TOGGLE);
      await openColumn(tab);
      expect(await widthOf(tab, ASIDE), 'the width is saved for this viewer').toBe(500);
      const strip = await tab.locator(HANDLE).boundingBox();
      await tab.mouse.dblclick(strip?.x ?? 0, (strip?.y ?? 0) + (strip?.height ?? 0) / 2);
      expect(await widthOf(tab, ASIDE), 'a double-click puts it back').toBe(before);
    } finally {
      await close();
    }
  });

  it('the divider moves from the keyboard: arrows step 16px, Home puts it back, and the keys never leave the range', async () => {
    const { tab, close } = await open(DESK, 'light');
    try {
      await openColumn(tab);
      const before = await widthOf(tab, ASIDE);
      await tab.focus(HANDLE);
      await tab.keyboard.press('ArrowLeft');
      expect(await widthOf(tab, ASIDE)).toBe(before + 16);
      expect(await tab.getAttribute(HANDLE, 'aria-valuenow')).toBe(String(before + 16));
      await tab.keyboard.press('ArrowRight');
      await tab.keyboard.press('ArrowRight');
      expect(await widthOf(tab, ASIDE)).toBe(before - 16);
      await tab.keyboard.press('Home');
      expect(await widthOf(tab, ASIDE)).toBe(before);
    } finally {
      await close();
    }
  });

  for (const mode of MODES)
    it(`${mode}: at the narrowest width the tab row clips no label and the chat keeps its room`, async () => {
      const { tab, close } = await open(DESK, mode);
      try {
        await openColumn(tab);
        await drag(tab, 2_000);
        expect(await widthOf(tab, ASIDE)).toBe(300);
        const cut = await tab.evaluate(query => {
          return [...document.querySelectorAll<HTMLElement>(query)]
            .filter(
              chip =>
                chip.scrollWidth > chip.clientWidth + 1 ||
                (chip.firstElementChild as HTMLElement).scrollWidth >
                  (chip.firstElementChild as HTMLElement).clientWidth + 1,
            )
            .map(chip => chip.textContent);
        }, TABS);
        expect(cut, 'every tab shows its whole label (the row scrolls instead)').toEqual([]);
        expect(await clippedText(tab, ASIDE)).toEqual([]);
        await tab.locator(TABS, { hasText: 'Terminals' }).click();
        await shot(tab, DESK, mode, 'narrowest-terminal');
        await drag(tab, -2_000);
        expect(await chatWidth(tab), 'the chat keeps at least 320px').toBeGreaterThanOrEqual(320);
      } finally {
        await close();
      }
    });

  for (const mode of MODES) {
    it(`${mode}: a stopped ferret says Resume beside its state, and a running one says Stop`, async () => {
      const stopped = await open(DESK, mode, '&state=stopped');
      try {
        await stopped.tab.waitForSelector('[data-ferret-lifecycle]');
        expect(await stopped.tab.locator('[data-ferret-start]').count(), 'Resume is on the header').toBe(1);
        expect(await stopped.tab.locator('[data-ferret-stop]').count()).toBe(0);
        await shot(stopped.tab, DESK, mode, 'stopped-header');
      } finally {
        await stopped.close();
      }
      const running = await open(DESK, mode, '&state=working');
      try {
        await running.tab.waitForSelector('[data-ferret-lifecycle]');
        expect(await running.tab.locator('[data-ferret-stop]').count(), 'Stop is on the header').toBe(1);
        expect(await running.tab.locator('[data-ferret-start]').count()).toBe(0);
        await running.tab.locator('[data-ferret-stop]').click();
        expect(await running.tab.locator('[data-ferret-stop-confirm]').count(), 'Stop asks once more').toBe(1);
        await shot(running.tab, DESK, mode, 'running-stop-confirm');
      } finally {
        await running.close();
      }
    });
  }
});

describe('the ferret page on a phone keeps its chips', () => {
  for (const mode of MODES) {
    it(`${mode}: Chat, then the Terminal and the Browser chips each show one panel full width`, async () => {
      const { tab, close } = await open(PHONE, mode);
      try {
        expect(await tab.locator(ASIDE).count(), 'no side column on a phone').toBe(0);
        await shot(tab, PHONE, mode, 'chat');
        await tab.locator('[data-phone-chip]', { hasText: 'Terminals' }).tap();
        await tab.waitForSelector('[data-panel="terminals.terminals"][data-phone-shown]');
        await shot(tab, PHONE, mode, 'terminal');
        await tab.locator('[data-phone-chip]', { hasText: 'Browser' }).tap();
        await tab.waitForSelector('[data-panel="browsers.browser"][data-phone-shown]');
        await shot(tab, PHONE, mode, 'browser');
        expect(await tab.locator('[data-panel][data-phone-shown]').count(), 'one panel at a time').toBe(1);
      } finally {
        await close();
      }
    });

    it(`${mode}: a stopped ferret keeps its Resume on the phone's toolbar line, and a running one leaves Stop to the menu`, async () => {
      const stopped = await open(PHONE, mode, '&state=stopped');
      try {
        await stopped.tab.waitForSelector('[data-ferret-start]');
        await shot(stopped.tab, PHONE, mode, 'stopped-header');
      } finally {
        await stopped.close();
      }
      const running = await open(PHONE, mode, '&state=working');
      try {
        await running.tab.waitForSelector('[data-phone-chip]');
        await calm(running.tab);
        expect(await running.tab.locator('[data-ferret-stop]').count(), 'no Stop on a phone line').toBe(0);
      } finally {
        await running.close();
      }
    });
  }
});
