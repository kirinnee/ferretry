/**
 * THE SESSION PAGE'S LAYOUT, MEASURED IN A REAL BROWSER — three defects that shipped with every gate
 * green, each now a geometry assertion rather than a screenshot somebody has to notice:
 *
 *   1. CONVERSATION WIDTH (Settings › Appearance). The setting narrows the conversation's text column
 *      and nothing else: Compact is 720px, 1200px is 1200px, Full is the scroller — each capped by the
 *      room there is. The composer's column has EXACTLY the text column's left and right edges. Before,
 *      the setting capped the whole surface, the composer sat a padding and a scrollbar off the text,
 *      and in a 1150px pane the three modes were almost indistinguishable.
 *   2. THE TAB STRIP. The strip spans its pane edge to edge, the first tab starts on the pane's left
 *      edge, every tab shares one top and one bottom (the strip's), and none is scrolled or clipped out
 *      of the tab list. A negative margin used to drop the selected tab one stroke below its neighbours
 *      and past a scrollport that clips vertically — "Chat sits offset and clipped" in every theme.
 *   3. NOTHING RUNS UNDER A PANE. With a split pane and Info open in a 1100px window, the
 *      chat — its text, its composer, its scroller — ends at the agent pane's right edge, and the pane
 *      itself overflows nothing. A centred surface sized to its content used to stay ~280px wide in a
 *      237px pane and draw the conversation underneath the terminal beside it.
 *   5. THE PHONE'S COMFORT LAYOUT, in a working session. The composer runs nearly edge to edge (8px from
 *      each side); its row is kteam's — attach and mic in a left column, Interrupt & send over Send in a
 *      right one — and the field between them is the SAME box with the agent idle and working, because a
 *      box that resized under the thumb when Interrupt appeared was the owner's complaint. The status line
 *      under it stays one line, the bar draws no Interrupt and no ⓘ (both are in ▾), and the Chat / Console
 *      tabs start on the conversation's own text edge in a strip no taller than the old 33px one.
 *   4. A PHONE WITH WIDE CONTENT. At 390px, with a code block, a table, a long URL and a tool result in the
 *      transcript, the chat column, the composer and every one of its buttons (Send among them) sit inside
 *      the viewport, nothing scrolls sideways, and focusing the composer scrolls nothing sideways either.
 *      The surface used to grow to its content (768-880px), which put Send at x=650 — no way to send a
 *      message — and focusing the editor slid the whole session 81px off the left edge.
 *
 * Every theme family is measured for the two layout-shape checks (1 at Compact, 2 and 3), because a
 * family changes strokes, radii, paddings and type — exactly what moves an edge. The width arithmetic
 * of the other two modes, and the phone, are theme-independent and measured once, in Studio.
 *
 * COUNTED AND ASSERTED, like every other tally in `screenshot.ts`: a check that stops being reached
 * reads exactly like a check that passed, so the run owes `SESSION_LAYOUT_GEOMETRY_CHECKS` of them.
 */

import { join } from 'node:path';
import type { Browser, BrowserContextOptions, Page } from 'playwright-core';
import { COMPOSER_DOCK_LAYOUT_KEY } from '../src/lib/composer-dock-layout.ts';
import { THEME_FAMILIES } from '../src/lib/theme-preferences.ts';
import { timed } from './walk-timing.ts';

type ChatWidth = 'readable' | 'balanced' | 'full';

/** What each mode caps the text column at. */
const COLUMN_CAP: Readonly<Record<ChatWidth, number>> = {
  readable: 720,
  balanced: 1_200,
  full: Number.POSITIVE_INFINITY,
};

/** Sub-pixel rounding between two boxes laid out in one pass. */
const EPSILON = 1;

/** Per family: Compact at 1440 (width + tabs), the split at 1100 (overlap + tabs), the wide phone and the phone comfort layout. Plus four in Studio. */
export const SESSION_LAYOUT_GEOMETRY_CHECKS = THEME_FAMILIES.length * 6 + 4;

const DESKTOP = { width: 1_440, height: 900 } as const;
/** Wide enough that 1200px and Full are different widths beside the sessions column. */
const WIDE = { width: 1_920, height: 1_080 } as const;
/** Where the overlap reproduced: a split pane and Info in a window just wide enough for both. */
const NARROW = { width: 1_100, height: 800 } as const;

export interface SessionLayoutRun {
  readonly browser: Browser;
  readonly rootUrl: string;
  readonly scheme: 'light' | 'dark';
  /** Applied to every context: the caller's phone emulation, colour scheme and motion. */
  readonly phone: BrowserContextOptions;
  readonly fail: (message: string) => never;
  /** Present: also capture the evidence frames into this directory. */
  readonly captureDir?: string;
  /** The families whose frames are captured; every family is still measured. */
  readonly captureFamilies?: readonly string[];
}

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
}

interface Reading {
  readonly pane: Box;
  readonly strip: Box | null;
  readonly tablist: (Box & { readonly scrollLeft: number }) | null;
  readonly tabs: readonly Box[];
  readonly scroller: Box & { readonly clientWidth: number };
  readonly column: Box;
  readonly input: Box;
  readonly composer: Box | null;
  readonly next: Box | null;
  readonly rail: Box | null;
  readonly paneOverflow: number;
}

/** Every box the checks read, in one evaluation so they come from one layout. */
const read = async (page: Page): Promise<Reading> =>
  await page.evaluate(() => {
    const box = (element: Element | null) => {
      if (element === null) return null;
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
    };
    const must = (selector: string, root: ParentNode = document) => {
      const element = root.querySelector(selector);
      if (element === null) throw new Error(`no ${selector} on the session page`);
      return element;
    };
    const surface = must('.kt-chat-surface');
    const pane = surface.closest('.fy-ws-pane') ?? must('[data-phone-workspace-body]');
    const scroller = must('.fy-transcript', surface) as HTMLElement;
    const tablist = pane.querySelector<HTMLElement>(':scope > .fy-ws-strip .fy-ws-tabs');
    const split = pane.closest('.fy-ws-split-child') as HTMLElement | null;
    const neighbour = split?.nextElementSibling?.nextElementSibling ?? null;
    return {
      pane: box(pane) as Box,
      strip: box(pane.querySelector(':scope > .fy-ws-strip')),
      tablist: tablist === null ? null : { ...(box(tablist) as Box), scrollLeft: tablist.scrollLeft },
      tabs: [...pane.querySelectorAll(':scope > .fy-ws-strip .fy-ws-tab')].map(tab => box(tab) as Box),
      scroller: { ...(box(scroller) as Box), clientWidth: scroller.clientWidth },
      column: box(must('.fy-transcript-content', surface)) as Box,
      input: box(must('.fy-chat-input__column', surface)) as Box,
      composer: box(surface.querySelector('[data-session-input] form')),
      next: neighbour instanceof HTMLElement && !neighbour.hidden ? box(neighbour) : null,
      rail: box(document.querySelector('[data-info-frame]')),
      paneOverflow: split === null ? 0 : split.scrollWidth - split.clientWidth,
    };
  });

export function planSessionLayoutGeometry(run: SessionLayoutRun): {
  readonly steps: ReadonlyArray<{ readonly weight: number; readonly run: () => Promise<void> }>;
  readonly checks: () => number;
} {
  const { browser, rootUrl, scheme } = run;
  // Annotated, not destructured: a `never` call narrows only through a name with an explicit type.
  const fail: (message: string) => never = run.fail;
  let checks = 0;
  const near = (a: number, b: number, tolerance = EPSILON): boolean => Math.abs(a - b) <= tolerance;

  type Viewport = { readonly width: number; readonly height: number } | 'phone';

  /**
   * ONE COLD LOAD PER SCENARIO, THEN ONE THEME FLIP PER FAMILY. The harness page reads the theme only from
   * `pre-paint.js` (it mounts no `useTheme`), which sets `<html data-theme>` and the default text scale; the
   * layout is a function of the CSS under that attribute. So a page loaded once and flipped through the
   * families measures what a page loaded once per family would, without paying the 6.6MB bundle's parse and
   * mount eleven times. `work` still runs once per family, against that family's own `where`.
   */
  const openEach = async (
    viewport: Viewport,
    families: readonly string[],
    query: string,
    work: (page: Page, where: string, family: string) => Promise<void>,
  ): Promise<void> => {
    const first = families[0];
    if (first === undefined) return;
    const label = viewport === 'phone' ? 'phone' : `${viewport.width}px`;
    const context = await timed('layout.newContext', () =>
      browser.newContext({
        ...(viewport === 'phone' ? run.phone : { viewport }),
        colorScheme: scheme,
        reducedMotion: 'reduce',
      }),
    );
    try {
      await context.route('**/*', async route => {
        if (new URL(route.request().url()).origin !== new URL(rootUrl).origin) await route.abort();
        else await route.continue();
      });
      await context.addInitScript(
        ([id, mode]) => localStorage.setItem('fy-theme-v1', JSON.stringify({ family: id, mode })),
        [first, scheme] as const,
      );
      const page = await timed('layout.newPage', () => context.newPage());
      await timed('layout.goto', () => page.goto(`${rootUrl}?${query}&family=${first}#session-workspace`));
      await timed('layout.mount', async () => {
        await page.locator('#harness-session-workspace-page').waitFor({ state: 'visible' });
        await page.locator('#harness-session-workspace-page .kt-chat-surface').waitFor({ state: 'attached' });
      });
      for (const family of families) {
        const where = `${family}-${scheme} ${label} ?${query}`;
        await timed('layout.settle', () =>
          page.evaluate(async next => {
            // Back to the state a fresh load starts in: no focus left over from the previous family's pass.
            if (document.documentElement.dataset.theme !== next) {
              if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
              document.documentElement.dataset.theme = next;
            }
            const frames = async (): Promise<void> =>
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            await frames();
            await document.fonts.ready;
            // An infinite busy mark (a spinner's pulse) has no end; `finish()` throws on one.
            for (const animation of document.getAnimations())
              if (animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY) animation.finish();
            await frames();
          }, `${family}-${scheme}`),
        );
        const theme = await page.evaluate(() => document.documentElement.dataset.theme);
        if (theme !== `${family}-${scheme}`)
          fail(`the session layout pass asked for ${family}-${scheme} and got ${theme}`);
        await timed('layout.work', () => work(page, where, family));
        const captured = run.captureFamilies ?? [];
        if (run.captureDir !== undefined && captured.includes(family)) {
          const name = `session-layout-${family}-${scheme}-${label.replace('px', '')}-${query.replaceAll(/[=&]/gu, '-')}.png`;
          await page.screenshot({ path: join(run.captureDir, name), animations: 'disabled' });
          process.stdout.write(`📸 session layout ${where} -> ${name}\n`);
        }
      }
    } finally {
      await timed('layout.close', () => context.close());
    }
  };

  const FAMILY_IDS: readonly string[] = THEME_FAMILIES.map(family => family.id);

  const open = async (
    viewport: Viewport,
    family: string,
    query: string,
    work: (page: Page, where: string) => Promise<void>,
  ): Promise<void> => await openEach(viewport, [family], query, work);

  /** 1. The text column is the mode's measure, and the composer's column has its exact edges. */
  const assertColumn = async (page: Page, where: string, mode: ChatWidth): Promise<void> => {
    const r = await read(page);
    const room = r.scroller.clientWidth;
    const expected = Math.min(COLUMN_CAP[mode], room);
    if (!near(r.column.width, expected))
      fail(`${where}: the ${mode} text column is ${r.column.width}px, not ${expected}px (room ${room}px)`);
    if (!near(r.input.left, r.column.left) || !near(r.input.right, r.column.right))
      fail(
        `${where}: the composer column [${r.input.left}, ${r.input.right}] does not share the text column's ` +
          `edges [${r.column.left}, ${r.column.right}]`,
      );
    if (r.composer !== null && (r.composer.left < r.input.left - EPSILON || r.composer.right > r.input.right + EPSILON))
      fail(`${where}: the composer [${r.composer.left}, ${r.composer.right}] leaves its column`);
    process.stdout.write(
      `   session layout ${where}: ${mode} column ${r.column.width.toFixed(0)}px of ${room}px, composer aligned\n`,
    );
    checks += 1;
  };

  /** 2. The strip spans the pane, the first tab sits on its edge, all tabs share one top and bottom. */
  const assertTabs = async (page: Page, where: string): Promise<void> => {
    const r = await read(page);
    const { strip, tablist, tabs } = r;
    if (strip === null || tablist === null || tabs.length === 0) fail(`${where}: the agent pane has no tab strip`);
    if (!near(strip.left, r.pane.left, 0.5) || !near(strip.right, r.pane.right, 0.5))
      fail(`${where}: the tab strip [${strip.left}, ${strip.right}] is not its pane [${r.pane.left}, ${r.pane.right}]`);
    const first = tabs[0] as Box;
    if (!near(first.left, r.pane.left, 0.5))
      fail(`${where}: the first tab starts at ${first.left}px, not on the pane's edge at ${r.pane.left}px`);
    if (tablist.scrollLeft !== 0) fail(`${where}: the tab list is scrolled ${tablist.scrollLeft}px, clipping Chat`);
    for (const [index, tab] of tabs.entries()) {
      if (!near(tab.bottom, strip.bottom, 0.5))
        fail(`${where}: tab ${index} ends at ${tab.bottom}px, not on the strip's bottom at ${strip.bottom}px`);
      if (!near(tab.top, first.top, 0.5))
        fail(`${where}: tab ${index} starts at ${tab.top}px, offset from the first tab's ${first.top}px`);
      if (tab.left < tablist.left - 0.5 || tab.bottom > tablist.bottom + 0.5)
        fail(`${where}: tab ${index} is clipped by its tab list`);
    }
    checks += 1;
  };

  /** 3. Beside a split pane and Info, nothing of the chat crosses the agent pane's edge. */
  const assertNoOverlap = async (page: Page, where: string): Promise<void> => {
    const r = await read(page);
    if (r.next === null) fail(`${where}: no second pane is open beside the chat`);
    if (r.rail === null) fail(`${where}: Info is not open`);
    const edge = r.pane.right;
    if (edge > r.next.left + 0.5) fail(`${where}: the agent pane ends at ${edge}px, inside the next pane`);
    if (r.next.right > r.rail.left + 0.5) fail(`${where}: the split runs under Info`);
    for (const [name, part] of [
      ['scroller', r.scroller],
      ['text column', r.column],
      ['composer column', r.input],
      ['composer', r.composer],
    ] as const)
      if (part !== null && part.right > edge + 0.5)
        fail(`${where}: the chat's ${name} ends at ${part.right}px, under the pane beside it (edge ${edge}px)`);
    if (r.paneOverflow > 0) fail(`${where}: the agent pane overflows sideways by ${r.paneOverflow}px`);
    process.stdout.write(`   session layout ${where}: chat ends at ${edge}px; next pane at ${r.next.left}px\n`);
    checks += 1;
  };

  /**
   * 4. Wide content on a phone stays inside its own boxes. Read twice: as laid out, and again after the
   * composer takes focus, because a focus scrolls any `overflow: hidden` ancestor that has room to move.
   */
  const assertPhoneFits = async (page: Page, where: string): Promise<void> => {
    const readPhone = async () =>
      await page.evaluate(() => {
        const surface = document.querySelector('.kt-chat-surface');
        if (surface === null) throw new Error('no .kt-chat-surface on the session page');
        const box = (element: Element) => {
          const r = element.getBoundingClientRect();
          return { left: r.left, right: r.right };
        };
        const named = (element: Element): string =>
          element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 24) ?? element.tagName;
        const scrolled: string[] = [];
        for (let node: Element | null = surface; node !== null; node = node.parentElement)
          if (node.scrollLeft !== 0) scrolled.push(`${node.tagName.toLowerCase()} scrollLeft=${node.scrollLeft}`);
        const wide = [...surface.querySelectorAll('pre, table')];
        return {
          width: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          parts: [
            ['chat column', box(surface)],
            ['transcript', box(surface.querySelector('.fy-transcript-content') ?? surface)],
            ['composer', box(surface.querySelector('[data-session-input] form') ?? surface)],
            ...[...surface.querySelectorAll('[data-session-input] form button')].map(
              button => [`composer button "${named(button)}"`, box(button)] as const,
            ),
            ...wide.map(element => [`${element.tagName.toLowerCase()} block`, box(element)] as const),
          ] as [string, { left: number; right: number }][],
          wideBlocks: wide.length,
          buttons: surface.querySelectorAll('[data-session-input] form button').length,
          scrolled,
        };
      });
    const check = (reading: Awaited<ReturnType<typeof readPhone>>, when: string): void => {
      if (reading.wideBlocks < 2)
        fail(`${where}: the wide transcript has ${reading.wideBlocks} code/table blocks, not 2`);
      if (reading.buttons === 0) fail(`${where}: the composer has no buttons to measure`);
      if (reading.documentWidth > reading.width)
        fail(`${where} ${when}: the page scrolls sideways (${reading.documentWidth}px in ${reading.width}px)`);
      for (const [name, part] of reading.parts)
        if (part.left < -EPSILON || part.right > reading.width + EPSILON)
          fail(
            `${where} ${when}: the ${name} spans [${part.left}, ${part.right}], outside the ${reading.width}px phone`,
          );
      if (reading.scrolled.length > 0)
        fail(`${where} ${when}: the chat's ancestors are scrolled sideways: ${reading.scrolled.join(', ')}`);
    };
    check(await readPhone(), 'at rest');
    await page.locator('[data-session-input] textarea, [data-session-input] [contenteditable="true"]').first().focus();
    await page.evaluate(
      async () => await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    check(await readPhone(), 'with the composer focused');
    process.stdout.write(
      `   session layout ${where}: chat, composer and its buttons inside the phone, no sideways scroll\n`,
    );
    checks += 1;
  };

  /** 5. The phone comfort layout, read idle and then working, so the field's box can be compared. */
  const readComfort = async (page: Page) =>
    await page.evaluate(() => {
      const box = (selector: string) => {
        const element = document.querySelector(selector);
        if (element === null) return null;
        const r = element.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      return {
        width: window.innerWidth,
        composer: box('[data-session-input] form .fy-composer-row'),
        field: box('[data-session-input] .fy-composer-input-layer'),
        start: box('[data-session-input] [data-composer-dock="start"]'),
        end: box('[data-session-input] [data-composer-dock=""]'),
        attach: box('[data-session-input] [data-composer-dock="start"] [data-composer-attach]'),
        send: box('[data-session-input] [data-composer-dock=""] [data-composer-send]'),
        interrupt: box('[data-session-input] [data-composer-dock=""] [data-composer-interrupt]'),
        status: box('[data-session-input] .fy-composer-actions'),
        barAction: box('[data-session-bar] [data-session-action="interrupt"]'),
        info: box('[data-session-bar] [data-session-info-toggle]'),
        tabs: box('[data-phone-tab-row]'),
        firstTab: box('[data-phone-tab-row] [role="tab"]'),
        text: (() => {
          const content = document.querySelector('.fy-transcript-content');
          if (content === null) return null;
          const left = content.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(content).paddingLeft);
          return left;
        })(),
      };
    });
  const assertPhoneComfort = async (): Promise<void> => {
    const idle = new Map<string, Awaited<ReturnType<typeof readComfort>>>();
    await openEach('phone', FAMILY_IDS, 'turn=your-turn&pickers&chat-width=readable', async (page, _where, family) => {
      idle.set(family, await readComfort(page));
    });
    await openEach('phone', FAMILY_IDS, 'turn=working&pickers&chat-width=readable', async (page, where, family) => {
      const r = await readComfort(page);
      const before = idle.get(family);
      if (before === undefined) fail(`${where}: the idle comfort reading never ran`);
      const { composer, field, start, end, attach, send, interrupt, status, barAction, info, tabs, firstTab, text } = r;
      if (composer === null || field === null || start === null || end === null || attach === null || send === null)
        fail(`${where}: the phone composer is not kteam's two-column row`);
      if (interrupt === null) fail(`${where}: a working session shows no Interrupt & send in the right column`);
      if (composer.left > 8 + EPSILON || composer.right < r.width - 8 - EPSILON)
        fail(
          `${where}: the composer spans [${composer.left}, ${composer.right}], not within 8px of the ${r.width}px phone's edges`,
        );
      if (!(start.right <= field.left + EPSILON && field.right <= end.left + EPSILON))
        fail(`${where}: the field is not between the attach/mic column and the Send column`);
      if (!near(interrupt.left, send.left) || interrupt.bottom > send.top + EPSILON)
        fail(`${where}: Interrupt & send does not sit over Send in one column`);
      if (before.field === null || !near(before.field.width, field.width) || !near(before.field.height, field.height))
        fail(
          `${where}: the field is ${field.width}×${field.height} working and ${before.field?.width}×${before.field?.height} idle — it must not resize`,
        );
      if (status !== null && status.height > 46)
        fail(`${where}: the composer's status line is ${status.height}px — it wrapped onto a second row`);
      // The phone bar is ☰ · name · one dot · ⓘ · ▾ (owner 2026-10-30). Interrupt lives in ▾ there.
      if (barAction !== null || info === null)
        fail(`${where}: the phone bar must draw ⓘ and no Interrupt (that one belongs in ▾)`);
      if (
        tabs === null ||
        firstTab === null ||
        text === null ||
        tabs.height > 33 + EPSILON ||
        !near(firstTab.left, text, 4)
      )
        fail(
          `${where}: the Chat / Console strip is ${tabs?.height}px tall and its first tab starts at ${firstTab?.left}px, the text at ${text}px`,
        );
      process.stdout.write(
        `   session layout ${where}: composer ${(composer.right - composer.left).toFixed(0)}px wide, field ${field.width.toFixed(0)}×${field.height.toFixed(0)} idle and working\n`,
      );
      checks += 1;
    });
    // A SEPARATE PASS, after the idle/working comparison: emptying the box changes the session's shared
    // draft, so the words are put back before the page closes and no other page ever reads it empty.
    await openEach('phone', FAMILY_IDS, 'turn=your-turn&pickers&chat-width=readable', async (page, where, family) => {
      const kept = await page
        .locator('[data-session-input] .fy-composer-input-layer :is(textarea, [contenteditable])')
        .first()
        .evaluate(node => (node instanceof HTMLTextAreaElement ? node.value : (node.textContent ?? '')));
      // THE PHONE COMPOSER'S BUTTONS, EMPTY AND WRITING, in each layout Settings › Composer › Button layout
      // offers (owner, 2026-11-02, !A237: inline while empty and stacked once there was a draft was "an awkward
      // jump"). Stacked (the default) and One row never move as the first word goes in; Auto is that old switch,
      // kept on purpose: one line while empty, stacked once there is a draft.
      const field = () =>
        page.locator('[data-session-input] .fy-composer-input-layer :is(textarea, [contenteditable])').first();
      const controls = async () => ({
        row: await page.locator('[data-session-input] .fy-composer-row').boundingBox(),
        attach: await page.locator('[data-session-input] [data-composer-attach]').boundingBox(),
        send: await page.locator('[data-session-input] [data-composer-send]').boundingBox(),
      });
      type Box = { x: number; y: number; width: number; height: number };
      const same = (a: Box, b: Box): boolean =>
        near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);
      // ONE PAGE serves every family in turn (`openEach`), so each pass names its layout, reloads, and puts
      // this family's theme back (a reload starts on the first family) — and the last pass leaves the page on
      // the default, so the next family never inherits a layout this one chose.
      const chooseLayout = async (layout: 'stacked' | 'row' | 'auto'): Promise<void> => {
        await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
          key: COMPOSER_DOCK_LAYOUT_KEY,
          value: layout,
        });
        await page.reload();
        await field().waitFor();
        await page.evaluate(async next => {
          document.documentElement.dataset.theme = next;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))));
        }, `${family}-${scheme}`);
        const shown = await page.locator('[data-session-input] form').first().getAttribute('data-composer-dock-layout');
        if (shown !== layout) fail(`${where}: asked for the ${layout} button layout and the composer shows ${shown}`);
      };
      for (const layout of ['stacked', 'row', 'auto'] as const) {
        const at = `${where} (${layout})`;
        await chooseLayout(layout);
        await field().click();
        await page.keyboard.press('ControlOrMeta+A');
        await page.keyboard.press('Backspace');
        await page.locator('[data-session-input] form[data-composer-empty]').waitFor();
        if (process.env.FY_EMPTY_COMPOSER_SHOT !== undefined)
          await page.screenshot({ path: `${process.env.FY_EMPTY_COMPOSER_SHOT}-${family}-${layout}.png` });
        const empty = await controls();
        await page.keyboard.insertText('hi');
        await page.locator('[data-session-input] form:not([data-composer-empty])').waitFor();
        const writing = await controls();
        const { row, attach, send } = empty;
        if (row === null || attach === null || send === null || writing.row === null)
          fail(`${at}: the empty phone composer is not drawn`);
        if (writing.attach === null || writing.send === null) fail(`${at}: the writing phone composer is not drawn`);
        const stacked = (box: { attach: Box; send: Box }): boolean =>
          box.send.y >= box.attach.y + box.attach.height - EPSILON;
        const inline = (box: { attach: Box; send: Box }): boolean =>
          near(box.send.y + box.send.height, box.attach.y + box.attach.height);
        if (layout === 'auto') {
          if (!inline({ attach, send })) fail(`${at}: an empty Auto composer's controls are not on one line`);
          if (!stacked({ attach: writing.attach, send: writing.send }))
            fail(`${at}: a writing Auto composer's controls are not stacked`);
        } else {
          if (!(layout === 'stacked' ? stacked : inline)({ attach, send }))
            fail(
              `${at}: the empty phone composer's controls are not ${layout === 'stacked' ? 'stacked' : 'on one line'} (attach ${JSON.stringify(attach)}, Send ${JSON.stringify(send)})`,
            );
          for (const [name, before, after] of [
            ['the row', row, writing.row],
            ['attach', attach, writing.attach],
            ['Send', send, writing.send],
          ] as const)
            if (!same(before, after))
              fail(
                `${at}: ${name} moved when the first word was typed (${JSON.stringify(before)} → ${JSON.stringify(after)})`,
              );
        }
        await page.keyboard.press('ControlOrMeta+A');
        await page.keyboard.press('Backspace');
        await page.keyboard.insertText(kept);
        await page.locator('[data-session-input] form:not([data-composer-empty])').waitFor();
        await page.waitForTimeout(800);
      }
      await chooseLayout('stacked');
    });
  };

  // Every step below is its own context and its own page, so each can run beside the others. A scenario
  // loads once and is measured in every theme family (see `openEach`); the studio-only widths load once each.
  // They are LISTED in this order, and that is the order they print in. The weight only orders the starts.
  const steps: Array<{ readonly weight: number; readonly run: () => Promise<void> }> = [
    { weight: 4, run: assertPhoneComfort },
    { weight: 3, run: () => openEach('phone', FAMILY_IDS, 'wide&chat-width=readable', assertPhoneFits) },
    {
      weight: 2,
      run: () =>
        openEach(DESKTOP, FAMILY_IDS, 'chat-width=readable', async (page, where) => {
          await assertColumn(page, where, 'readable');
          await assertTabs(page, where);
        }),
    },
    {
      weight: 2,
      run: () =>
        openEach(NARROW, FAMILY_IDS, 'split&info&chat-width=readable', async (page, where) => {
          await assertNoOverlap(page, where);
          await assertTabs(page, where);
        }),
    },
  ];
  for (const mode of ['readable', 'balanced', 'full'] as const)
    steps.push({
      weight: 1,
      run: () =>
        open(WIDE, 'studio', `chat-width=${mode}`, async (page, where) => await assertColumn(page, where, mode)),
    });
  steps.push({
    weight: 1,
    run: () =>
      open('phone', 'studio', 'chat-width=readable', async (page, where) => assertColumn(page, where, 'readable')),
  });

  // EVIDENCE ONLY, never counted: the frames a reviewer compares — every width option where they differ,
  // the split pane with Info open at a common desktop size, and the phone with a pane open.
  const nothing = async (): Promise<void> => undefined;
  if (run.captureDir !== undefined)
    for (const family of run.captureFamilies ?? []) {
      for (const mode of ['readable', 'balanced', 'full'] as const)
        if (family !== 'studio')
          steps.push({ weight: 1, run: () => open(WIDE, family, `chat-width=${mode}`, nothing) });
      steps.push({ weight: 1, run: () => open(DESKTOP, family, 'split&info&chat-width=readable', nothing) });
      if (family !== 'studio')
        steps.push({ weight: 1, run: () => open('phone', family, 'chat-width=readable', nothing) });
      steps.push({ weight: 1, run: () => open('phone', family, 'split&chat-width=readable', nothing) });
    }
  return { steps, checks: () => checks };
}
