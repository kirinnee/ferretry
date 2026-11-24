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
/** Mid widths: a tablet, and the window a person gets by halving a laptop screen. The default layout keeps its list column there. */
const TABLET = { name: '768', width: 768, height: 900, phone: false } as const;
const MIDDLE = { name: '800', width: 800, height: 900, phone: false } as const;
interface Viewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly phone: boolean;
}
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

/** A phone's tab: its chip when the row has room for it, else the entry in "More tabs" (the row never shows half a label). */
const tapTab = async (tab: Page, label: string): Promise<void> => {
  const chip = tab.locator('[data-phone-chip]', { hasText: label });
  if ((await chip.count()) > 0) await chip.tap();
  else {
    await tab.locator('[data-phone-more]').tap();
    await tab.locator('[role="menuitem"]', { hasText: label }).tap();
  }
};

describe('the ferret page on a phone keeps its chips', () => {
  for (const mode of MODES) {
    it(`${mode}: Chat, then the Terminal and the Browser chips each show one panel full width`, async () => {
      const { tab, close } = await open(PHONE, mode);
      try {
        expect(await tab.locator(ASIDE).count(), 'no side column on a phone').toBe(0);
        await shot(tab, PHONE, mode, 'chat');
        await tapTab(tab, 'Terminals');
        await tab.waitForSelector('[data-panel="terminals.terminals"][data-phone-shown]');
        await shot(tab, PHONE, mode, 'terminal');
        await tapTab(tab, 'Browser');
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

/**
 * THE CHAT FLOOR AT MID WIDTHS (rv-2393 item 1): at 768 and 800 the default layout (nav + list column) leaves the ferret row too
 * little for a 300px column AND a 320px chat. The column then overlays the chat (a drawer, as on a phone) instead of squeezing it,
 * so the chat is never narrower than 320px whether the column is open or closed.
 */
describe('the chat keeps its floor at mid widths', () => {
  for (const viewport of [TABLET, MIDDLE])
    for (const mode of MODES)
      it(`${viewport.name} ${mode}: with the column open the chat is still >= 320px and the column stays on screen`, async () => {
        const { tab, close } = await open(viewport, mode);
        try {
          await shot(tab, viewport, mode, 'closed');
          await openColumn(tab);
          const chat = await chatWidth(tab);
          expect(chat, `the chat is ${chat}px beside an open column at ${viewport.name}`).toBeGreaterThanOrEqual(320);
          const box = await tab.locator(ASIDE).boundingBox();
          expect(box, 'the column is drawn').not.toBeNull();
          expect((box?.x ?? -1) + (box?.width ?? 0), 'the column ends inside the window').toBeLessThanOrEqual(
            viewport.width + 0.5,
          );
          expect(box?.x ?? -1, 'the column starts inside the window').toBeGreaterThanOrEqual(0);
          expect(await tab.locator(HANDLE).isVisible(), 'an overlaid column has no divider to drag').toBe(false);
          await shot(tab, viewport, mode, 'open-console');
        } finally {
          await close();
        }
      });
});

/**
 * THE DIVIDER SPEAKS FOR THE WIDTH IT DRAWS (rv-2393 item 2): save 720 at 1440, narrow the window to 900, and the column renders
 * narrower than its saved width. The divider starts from what is DRAWN: it announces the drawn width and the room there really
 * is, and a key or a drag moves the edge from there at once.
 */
describe('the divider uses the drawn width, not the saved one', () => {
  const NARROWED = 900;
  const narrowed = async (mode: Mode) => {
    const session = await open(DESK, mode);
    await openColumn(session.tab);
    await drag(session.tab, -2_000);
    expect(await widthOf(session.tab, ASIDE), 'saved the widest').toBe(720);
    await session.tab.setViewportSize({ width: NARROWED, height: DESK.height });
    await calm(session.tab);
    return session;
  };
  const announced = async (tab: Page) => ({
    now: Number(await tab.getAttribute(HANDLE, 'aria-valuenow')),
    max: Number(await tab.getAttribute(HANDLE, 'aria-valuemax')),
  });

  for (const mode of MODES)
    it(`${mode}: aria-valuenow and aria-valuemax say the drawn width and the real room`, async () => {
      const { tab, close } = await narrowed(mode);
      try {
        const drawn = await widthOf(tab, ASIDE);
        expect(drawn, 'the saved 720 does not fit at 900').toBeLessThan(720);
        const { now, max } = await announced(tab);
        expect(now, 'valuenow is the drawn width').toBe(Math.round(drawn));
        expect(max, 'valuemax is the most the window allows, not the saved range').toBeLessThanOrEqual(
          Math.round(drawn) + 1,
        );
        expect(max).toBeGreaterThanOrEqual(now);
        await shot(tab, DESK, mode, 'saved-wide-narrowed');
      } finally {
        await close();
      }
    });

  it('ArrowRight narrows the drawn column by a step at once, and ArrowLeft cannot push past the room', async () => {
    const { tab, close } = await narrowed('light');
    try {
      const drawn = await widthOf(tab, ASIDE);
      await tab.focus(HANDLE);
      await tab.keyboard.press('ArrowRight');
      expect(await widthOf(tab, ASIDE), 'one step narrower, visibly').toBe(drawn - 16);
      expect((await announced(tab)).now).toBe(drawn - 16);
      await tab.keyboard.press('ArrowLeft');
      await tab.keyboard.press('ArrowLeft');
      expect(await widthOf(tab, ASIDE), 'never wider than the room').toBe(drawn);
      expect((await announced(tab)).now).toBe(drawn);
    } finally {
      await close();
    }
  });

  it('a 24px drag moves the edge 24px from where it is drawn (it was drawn 340 wide: 48 would pass the 300 minimum)', async () => {
    const { tab, close } = await narrowed('light');
    try {
      const drawn = await widthOf(tab, ASIDE);
      await drag(tab, 24);
      expect(await widthOf(tab, ASIDE)).toBe(drawn - 24);
    } finally {
      await close();
    }
  });
});

/**
 * THE FERRET PAGE CLIPS NO WORD AND KEEPS ITS COMPOSER (O11 R7, O9-12): the owner's line is "clips no text, not crammed".
 *  - the Console at a desk shows every character of the pane and of its input's hint, with no sideways scrolling to find them;
 *  - the phone's tab row never shows half a label: a tab is whole or it is in the "More" menu, and Browser and Files can be reached;
 *  - where the row cannot hold the column beside a 320px chat (768, 800) the column sits BELOW the chat, so the composer and its
 *    Send button stay on screen and clickable.
 */
describe('the ferret page clips no text and keeps its composer', () => {
  /** How wide the Console's input hint is drawn, against the room the input has for it. */
  const hintFit = async (tab: Page) =>
    await tab.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('[data-console-input]');
      if (input === null) throw new Error('no console input');
      const style = getComputedStyle(input);
      const canvas = document.createElement('canvas').getContext('2d');
      if (canvas === null) throw new Error('no canvas');
      canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      return { hint: canvas.measureText(input.placeholder).width, room: input.clientWidth - padding };
    });

  for (const mode of MODES)
    it(`${mode}: the Console at 1440 shows its whole pane and its whole hint`, async () => {
      const { tab, close } = await open(DESK, mode);
      try {
        await openColumn(tab);

        await tab.waitForFunction(() => document.querySelector('pre')?.textContent?.includes('turn-001.md') === true);
        const sideways = await tab.evaluate(() => {
          const scroller = document.querySelector<HTMLElement>('[data-testid="terminal-snapshot-scroller"]');
          return scroller === null ? -1 : scroller.scrollWidth - scroller.clientWidth;
        });
        expect(sideways, 'no line of the pane runs past its right edge').toBeLessThanOrEqual(1);
        const { hint, room } = await hintFit(tab);
        expect(hint, 'the input hint fits the field').toBeLessThanOrEqual(room);
        await shot(tab, DESK, mode, 'r7-console');
      } finally {
        await close();
      }
    });

  for (const mode of MODES)
    it(`${mode}: the phone's tab row shows whole labels only, and Browser and Files are one tap away`, async () => {
      const { tab, close } = await open(PHONE, mode);
      try {
        const half = await tab.evaluate(() => {
          const row = document.querySelector('[data-phone-tab-row] [role="tablist"]');
          if (row === null) throw new Error('no tab row');
          const edge = row.getBoundingClientRect();
          return [...row.querySelectorAll<HTMLElement>('[data-phone-chip]')]
            .filter(chip => {
              const box = chip.getBoundingClientRect();
              return box.left < edge.left - 0.5 || box.right > edge.right + 0.5;
            })
            .map(chip => chip.textContent);
        });
        expect(half, 'no chip is cut by the row edge').toEqual([]);
        await shot(tab, PHONE, mode, 'r7-tabs');
        await tab.locator('[data-phone-more]').tap();
        const reachable = await tab.locator('[role="menuitem"]').allInnerTexts();
        expect(reachable.join('|')).toContain('Browser');
        expect(reachable.join('|')).toContain('Files');
        await shot(tab, PHONE, mode, 'r7-tabs-more');
        await tab.locator('[role="menuitem"]', { hasText: 'Browser' }).tap();
        await tab.waitForSelector('[data-panel="browsers.browser"][data-phone-shown]');
        expect(
          await tab.locator('[data-phone-chip="browsers.browser"]').count(),
          'a tab chosen from More takes a place in the row',
        ).toBe(1);
        await shot(tab, PHONE, mode, 'r7-tabs-browser');
      } finally {
        await close();
      }
    });

  for (const viewport of [TABLET, MIDDLE])
    for (const mode of MODES)
      it(`${viewport.name} ${mode}: with the column open the composer is whole and Send can be pressed`, async () => {
        const { tab, close } = await open(viewport, mode);
        try {
          await openColumn(tab);
          await tab.locator('[data-composer-send]').waitFor();
          const covered = await tab.evaluate(
            ([aside]) => {
              const send = document.querySelector<HTMLElement>('[data-composer-send]');
              const side = document.querySelector(aside as string);
              if (send === null || side === null) throw new Error('no composer or column');
              const box = send.getBoundingClientRect();
              const column = side.getBoundingClientRect();
              const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
              return {
                overlaps:
                  box.right > column.left &&
                  box.left < column.right &&
                  box.bottom > column.top &&
                  box.top < column.bottom,
                reachable: hit !== null && send.contains(hit),
                inside: box.right <= window.innerWidth && box.bottom <= window.innerHeight,
              };
            },
            [ASIDE],
          );
          expect(covered.inside, 'Send is on screen').toBe(true);
          expect(covered.overlaps, 'the column does not lie over Send').toBe(false);
          expect(covered.reachable, 'what is drawn at Send is Send').toBe(true);
          await shot(tab, viewport, mode, 'r7-composer');
        } finally {
          await close();
        }
      });
});
