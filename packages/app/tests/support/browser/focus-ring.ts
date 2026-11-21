/**
 * THE FOCUS RING PROBE (r11 S13): is every keyboard focus ring drawn where nothing can cut it?
 *
 * `walkFocusRings(tab)` presses Tab through a page (a real keyboard, so `:focus-visible` is what draws) and, at every stop,
 * measures the ring box against every clipping ancestor. The ring box is the focused element's border box inflated by what
 * its ring paints OUTSIDE it: `max(0, outline-offset + outline-width)` and any hard (blur 0) non-inset `box-shadow` spread.
 * An ancestor clips when its `overflow-x`/`overflow-y` is not `visible`, it has `contain: paint | content | strict`, or a
 * `clip-path`. The ring box must lie inside that ancestor's PADDING box (± 1 px: scrolling snaps to whole pixels). A ring drawn inside the control's own
 * border box (`outline-offset: -<width>`) inflates by 0, so it can never be cut by an ancestor, whatever its padding.
 *
 * Geometry is measured WHERE THE BROWSER LEFT THE FOCUS (a real Tab scrolls natively) before this probe scrolls anything; a second look
 * follows `scrollIntoView` for walks. Only what a ring adds OUTSIDE its owner counts, so an owner the page left partly hidden is not a
 * ring defect. `ringOfFocused`, `arrowWalkRings` and `edgeRings` never scroll at all (r11-1c C2).
 *
 * Ring owners are the focused element AND any ancestor that draws an outline of its own while the focus is inside it
 * (`.fy-cc__card:has(:focus-visible)`, `.kt-tab:has(> input:focus-visible)`): the ring is on them, not on the input.
 *
 * Also returned, per stop that lands on a primary button: the ring's contrast against what sits just inside it (the 1 px
 * `--surface` separator when the control has one, otherwise the control's own fill) and against what sits just outside it.
 *
 * The gate (r11-1 / r11-2 / r11-3) and T14's probe 7 reuse this file; the page function below is self-contained because
 * Playwright serialises it into the page.
 */
import type { Locator, Page } from 'playwright-core';
import { COLOUR_TOOLS, type ColourTools } from './colour.ts';

export interface FocusStop {
  /** `tag.class "first words"` of the focused element. */
  readonly label: string;
  /** One line per ancestor that would clip the ring (empty = none). */
  readonly violations: readonly string[];
  /** The widest the ring reaches outside the control's border box, in px (0 = drawn inside). */
  readonly reach: number;
  /** True when the stop paints a visible ring: its own outline, or an ancestor's `:has(:focus-visible)` outline. */
  readonly painted: boolean;
  /** True when the focused element matches the selector the caller was looking for (`ringOf`). */
  readonly target: boolean;
  /** True when this exact element (not just a same-labelled one) was already a stop of this walk: the Tab order wrapped. */
  readonly repeat: boolean;
  /** True when the element is the very one the previous Tab already stopped on: Tab did not move focus (an autocomplete took it). */
  readonly stuck: boolean;
  /** Set when the stop is a primary button: contrast of the ring against the inside / outside neighbours. */
  readonly primary?: { readonly inside: number; readonly outside: number; readonly separator: boolean };
}

export interface FocusWalk {
  readonly stops: readonly FocusStop[];
  /** How the walk ended: the Tab order came back to a stop it had already measured (by element identity), left the page, hit the cap, or Tab could not leave a control (a keyboard trap). */
  readonly ended: 'wrapped' | 'left-page' | 'cap' | 'stuck';
  /** Flattened `label — violation` lines across every stop. */
  readonly violations: readonly string[];
}

/** The page function: measure the active element's ring and every clipping ancestor. Self-contained. */
const measureActive = (arg: { target: string | null; scroll: boolean }): FocusStop | 'none' | 'hidden' => {
  const { target, scroll } = arg;
  /** Sub-pixel slack: a scroll position snaps to whole device pixels, so an element at a fractional offset can sit < 1px past the edge. */
  const TOLERANCE = 1;
  const active = document.activeElement;
  if (active === null || active === document.body || active === document.documentElement) return 'none';
  const colour = (window as unknown as { __colour: ColourTools }).__colour;
  const describe = (el: Element): string =>
    `${el.tagName.toLowerCase()}${
      typeof el.className === 'string' && el.className.trim() !== ''
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : ''
    }${(el.textContent ?? '').trim() === '' ? '' : ` "${(el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24)}"`}`;
  const visible = (el: Element): boolean => {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  if (!visible(active)) return 'hidden';

  /** How far the outline reaches outside the border box (0 = drawn inside), or null when it paints nothing. */
  const outlineReach = (el: Element): number | null => {
    const style = getComputedStyle(el);
    // A transparent outline (Tailwind's `outline-none` keeps one for forced-colours mode) paints nothing.
    const width = style.outlineStyle === 'none' ? 0 : Number.parseFloat(style.outlineWidth);
    if (!(width > 0) || colour.rgba(style.outlineColor)[3] === 0) return null;
    return Math.max(0, Number.parseFloat(style.outlineOffset) + width);
  };
  const shadowReach = (el: Element): number => {
    const parts = getComputedStyle(el).boxShadow.split(/,(?![^()]*\))/);
    let reach = 0;
    for (const part of parts) {
      if (part.includes('inset') || part.trim() === 'none') continue;
      const lengths = [...part.matchAll(/(-?[\d.]+)px/g)].map(m => Number.parseFloat(m[1] ?? '0'));
      const [x = 0, y = 0, blur = 0, spread = 0] = lengths;
      if (blur === 0 && spread > 0) reach = Math.max(reach, spread + Math.max(Math.abs(x), Math.abs(y)));
    }
    return reach;
  };
  const clips = (el: Element): boolean => {
    const style = getComputedStyle(el);
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') return true;
    if (/paint|content|strict/.test(style.contain)) return true;
    return style.clipPath !== 'none';
  };
  const positioned = (el: Element): boolean => {
    const style = getComputedStyle(el);
    return style.position !== 'static' || style.transform !== 'none' || style.filter !== 'none';
  };

  const owners: Element[] = [active];
  for (let node = active.parentElement; node !== null && node !== document.body; node = node.parentElement)
    if (outlineReach(node) !== null) owners.push(node);

  const violations: string[] = [];
  /** A stop that paints no ring at all is a violation: a missing ring is not "nothing outside the control to clip". */
  const painted = owners.some(owner => outlineReach(owner) !== null);
  if (!painted)
    violations.push(`${describe(active)} paints no visible focus ring (outline absent, zero-width or transparent)`);
  const holder = window as unknown as { __ringSeen?: Element[] };
  const seen = holder.__ringSeen ?? [];
  holder.__ringSeen = seen;
  const stuck = seen.at(-1) === active;
  const repeat = !stuck && seen.includes(active);
  if (!repeat && !stuck) seen.push(active);
  let widest = 0;
  /**
   * Judge every owner's ring against every clipping ancestor. Only what the ring adds OUTSIDE its owner counts: an owner the page
   * left partly hidden (a card's own border row under the frame's edge, a control scrolled half out of view) is not a ring defect,
   * but a ring that reaches beyond such an owner is cut by that much more.
   */
  const judge = (): void => {
    for (const owner of owners) {
      const reach = Math.max(outlineReach(owner) ?? 0, owner === active ? shadowReach(owner) : 0);
      widest = Math.max(widest, reach);
      const rect = owner.getBoundingClientRect();
      const ring = {
        left: rect.left - reach,
        top: rect.top - reach,
        right: rect.right + reach,
        bottom: rect.bottom + reach,
      };
      const style = getComputedStyle(owner);
      let escaped = style.position === 'absolute';
      for (let node = owner.parentElement; node !== null; node = node.parentElement) {
        if (node === document.body || node === document.documentElement) break;
        if (style.position === 'fixed') break;
        if (escaped) {
          // An absolutely placed owner is clipped only by its containing block and what is above it.
          if (!positioned(node)) continue;
          escaped = false;
        }
        if (clips(node)) {
          const box = node.getBoundingClientRect();
          const pad = {
            left: box.left + node.clientLeft,
            top: box.top + node.clientTop,
            right: box.left + node.clientLeft + node.clientWidth,
            bottom: box.top + node.clientTop + node.clientHeight,
          };
          const sides = {
            left: pad.left - ring.left,
            top: pad.top - ring.top,
            right: ring.right - pad.right,
            bottom: ring.bottom - pad.bottom,
          };
          const own = {
            left: pad.left - rect.left,
            top: pad.top - rect.top,
            right: rect.right - pad.right,
            bottom: rect.bottom - pad.bottom,
          };
          const net = (key: keyof typeof sides): number => sides[key] - Math.max(own[key], 0);
          const keys = Object.keys(sides) as (keyof typeof sides)[];
          const over = Math.max(...keys.map(net));
          const side = keys.find(key => net(key) === over) ?? 'left';
          const line = `${describe(owner)} ring (${reach}px outside) crosses ${describe(node)} padding box by ${over.toFixed(1)}px on its ${side}`;
          if (over > TOLERANCE && !violations.includes(line)) violations.push(line);
        }
        if (getComputedStyle(node).position === 'fixed') break;
      }
    }
  };
  judge();
  if (scroll) {
    // The page's own scroll (a real Tab) is judged above, as it left the ring; then bring the control into view, as before, and judge again.
    active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    judge();
  }

  let primary: FocusStop['primary'];
  if (active.matches(".kt-btn[data-variant='primary']")) {
    const style = getComputedStyle(active);
    const ink = colour.rgba(style.outlineColor);
    const inset = style.boxShadow.split(/,(?![^()]*\))/).find(part => part.includes('inset'));
    const innerColour =
      inset === undefined
        ? colour.backdrop(active as HTMLElement)
        : (() => {
            const text = inset.replace(/inset/g, '').trim();
            const paint = /(rgba?\([^)]*\)|color\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|#[0-9a-f]{3,8})/i.exec(text);
            const fill = colour.rgba(paint?.[1] ?? '#000');
            return colour.over(fill, [...colour.backdrop(active as HTMLElement), 1]);
          })();
    const outer = colour.backdrop(active.parentElement ?? (active as HTMLElement));
    const withRing = (below: readonly number[]) => colour.over(ink, [...below, 1]);
    primary = {
      inside: colour.ratio(withRing(innerColour), innerColour),
      outside: colour.ratio(withRing(outer), outer),
      separator: inset !== undefined,
    };
  }
  return {
    label: describe(active),
    violations,
    reach: widest,
    painted,
    repeat,
    stuck,
    target: target !== null && active.matches(target),
    ...(primary === undefined ? {} : { primary }),
  };
};

/** Press Tab until `stop` says to end (or `cap`), measuring each stop. The walk ends on ELEMENT identity, never on a label. */
const tabThrough = async (
  tab: Page,
  cap: number,
  target: string | null,
): Promise<{ stops: FocusStop[]; ended: FocusWalk['ended'] }> => {
  await tab.evaluate(COLOUR_TOOLS);
  await tab.evaluate(() => {
    (window as unknown as { __ringSeen: Element[] }).__ringSeen = [];
    // Start from the top of the page: a blur alone leaves Chromium's sequential-focus starting point on the control that had
    // focus, so the next Tab would continue from THERE. Focusing the body moves the starting point to the document.
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.setAttribute('tabindex', '-1');
    document.body.focus();
    document.body.removeAttribute('tabindex');
  });
  const stops: FocusStop[] = [];
  for (let index = 0; index < cap; index += 1) {
    await tab.keyboard.press('Tab');
    let measured = await tab.evaluate(measureActive, { target, scroll: true });
    // A control that keeps Tab for itself (an autocomplete accepting a suggestion): Escape closes it, one more Tab moves on.
    if (typeof measured !== 'string' && measured.stuck) {
      await tab.keyboard.press('Escape');
      await tab.keyboard.press('Tab');
      measured = await tab.evaluate(measureActive, { target, scroll: true });
      if (typeof measured !== 'string' && measured.stuck) return { stops, ended: 'stuck' };
    }
    // Focus left the document (the browser's own chrome): the walk is over. A merely invisible stop is skipped.
    if (measured === 'none') return { stops, ended: stops.length > 0 ? 'left-page' : 'cap' };
    if (measured === 'hidden') continue;
    if (measured.repeat) return { stops, ended: 'wrapped' };
    stops.push(measured);
    if (measured.target) return { stops, ended: 'wrapped' };
  }
  return { stops, ended: 'cap' };
};

/** Tab through `tab` (cap `cap`, default 80) and measure every stop. The page must already be drawn. */
export const walkFocusRings = async (tab: Page, cap = 80): Promise<FocusWalk> => {
  const { stops, ended } = await tabThrough(tab, cap, null);
  return {
    stops,
    ended,
    violations: stops.flatMap(stop => stop.violations.map(line => `${stop.label} — ${line}`)),
  };
};

/**
 * Tab (a real keyboard, so `:focus-visible` draws) until the element matching `selector` has focus, and measure ITS ring.
 * Null when Tab never reaches it within `cap` stops.
 */
export const ringOf = async (tab: Page, selector: string, cap = 80): Promise<FocusStop | null> => {
  const { stops } = await tabThrough(tab, cap, selector);
  const last = stops.at(-1);
  return last?.target === true ? last : null;
};

/**
 * Measure the ring of whatever has focus RIGHT NOW (no Tab): for a control the keyboard reaches another way, such as the
 * radios of a group (one Tab stop; the arrow keys move between them). Null when nothing visible is focused. Nothing is
 * scrolled: the ring is measured exactly where the browser left it (r11-1c C2).
 */
export const ringOfFocused = async (tab: Page): Promise<FocusStop | null> => {
  await tab.evaluate(COLOUR_TOOLS);
  const measured = await tab.evaluate(measureActive, { target: null, scroll: false });
  return typeof measured === 'string' ? null : measured;
};

/** What one arrow-key walk through a radio group saw: for each radio, which group member held focus and how its ring sat. */
export interface ArrowWalk {
  /** The `idAttr` value of the element around each focused radio, in the order ArrowDown reached them. */
  readonly ids: readonly string[];
  readonly stops: readonly FocusStop[];
  readonly violations: readonly string[];
}

/**
 * Walk a radio group by the arrow keys (the group is ONE Tab stop, so Tab never visits the rest): keyboard modality on, focus the
 * first radio matching `radio`, then ArrowDown through all of them, measuring the ring of each where the browser left it.
 * `idAttr` names the attribute (on the radio's card) that says WHICH member holds focus, so a stalled arrow cannot count as a new
 * one: the caller asserts the ids are all different.
 */
export const arrowWalkRings = async (tab: Page, radio: string, idAttr: string): Promise<ArrowWalk> => {
  const count = await tab.locator(radio).count();
  await tab.keyboard.press('Shift'); // keyboard modality, so :focus-visible draws on a scripted focus
  await tab.locator(radio).first().focus();
  const ids: string[] = [];
  const stops: FocusStop[] = [];
  for (let index = 0; index < count; index += 1) {
    const stop = await ringOfFocused(tab);
    if (stop !== null) stops.push(stop);
    ids.push(
      await tab.evaluate(
        attr => (document.activeElement?.closest(`[${attr}]`) as HTMLElement | null)?.getAttribute(attr) ?? '',
        idAttr,
      ),
    );
    if (index < count - 1) await tab.keyboard.press('ArrowDown');
  }
  return { ids, stops, violations: stops.flatMap(stop => stop.violations.map(line => `${stop.label} — ${line}`)) };
};

/**
 * Scroll so `target` sits `gap` px below (negative = above) the top of the padding box of its nearest clipping ancestor, and return the
 * gap actually reached (scroll ranges can refuse). `null` scrolls nothing and only reports the gap. The scroll moves whatever scrolls: that ancestor, any scrollable one above it, the page.
 */
export const placeFromFrameTop = async (target: Locator, gap: number | null): Promise<number> =>
  target.evaluate(async (node, wanted) => {
    const clipper = (): HTMLElement => {
      for (let el = node.parentElement; el !== null; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.overflowX !== 'visible' || style.overflowY !== 'visible') return el;
      }
      return document.documentElement;
    };
    const frame = clipper();
    const gapNow = (): number => {
      const top = frame === document.documentElement ? 0 : frame.getBoundingClientRect().top + frame.clientTop;
      return node.getBoundingClientRect().top - top;
    };
    const scrollers: Element[] = [];
    for (let el: Element | null = node.parentElement; el !== null; el = el.parentElement)
      if (el.scrollHeight > el.clientHeight) scrollers.push(el);
    scrollers.push(document.scrollingElement ?? document.documentElement);
    const place = (to: number): void => {
      for (const scroller of scrollers) {
        const delta = gapNow() - to;
        if (Math.abs(delta) < 0.5) break;
        scroller.scrollTop += delta;
      }
    };
    if (wanted === null) return gapNow();
    // Placed, then let the page settle (a list that has just opened or a choice that has just re-drawn it moves things on its own):
    // done only when the gap held for two looks 120 ms apart.
    let held = 0;
    for (let attempt = 0; attempt < 12 && held < 2; attempt += 1) {
      place(wanted);
      await new Promise(resolve => setTimeout(resolve, 120));
      held = Math.abs(gapNow() - wanted) < 0.5 ? held + 1 : 0;
    }
    return gapNow();
  }, gap);

/** One edge case: the card placed, the gap it was placed at, the gap it still had when the ring was measured, and that ring. */
interface EdgeCase {
  readonly card: number;
  readonly gap: number;
  readonly gapAtRing: number;
  readonly stop: FocusStop | null;
}

/** The two edge cases of a ring near the edge of its frame, each measured exactly where the browser left the focus. */
export interface EdgeRings {
  /** Which card (index) was placed for each case, and the gap to the frame top that was reached (px; negative = above). */
  readonly nearTop: EdgeCase;
  readonly partlyHidden: EdgeCase;
}

/**
 * The cases a scroll cannot be trusted to hide. Among the `cards` (each holding a radio `radio`), take the first one the frame can place
 * 2 px under its top, press it with the pointer, then press Shift (so keyboard modality turns the ring on where the card stands); and
 * the first one the frame can leave at least `hidden` px above its top, focus it with `focus({ preventScroll: true })` after Shift.
 * Neither measurement scrolls anything.
 */
export const edgeRings = async (tab: Page, cards: string, radio: string, hidden = 14): Promise<EdgeRings> => {
  const count = await tab.locator(cards).count();
  const attempt = async (
    wanted: number,
    reached: (gap: number) => boolean,
  ): Promise<{ card: number; gap: number; locator: Locator }> => {
    let last = { card: -1, gap: Number.NaN, locator: tab.locator(cards).first() };
    for (let card = 0; card < count; card += 1) {
      const locator = tab.locator(cards).nth(card);
      const gap = await placeFromFrameTop(locator, wanted);
      last = { card, gap, locator };
      if (reached(gap)) return last;
    }
    return last;
  };
  const near = await attempt(2, gap => Math.abs(gap - 2) < 1);
  // A raw mouse press where the card stands (Playwright's own click would scroll the card to a better place first, which is the very thing
  // this case must not have): the press has to land on the card's radio, or the case proves nothing.
  const box = await near.locator.locator(radio).boundingBox();
  if (box === null) throw new Error('the card has no box to press');
  const point = { x: box.x + 20, y: box.y + Math.max(box.height / 2, 20) };
  const hit = await tab.evaluate(({ x, y, selector }) => document.elementFromPoint(x, y)?.matches(selector) ?? false, {
    ...point,
    selector: radio,
  });
  if (!hit) throw new Error(`the press at ${point.x},${point.y} does not land on ${radio}`);
  // Pressed and still held: the press focuses the radio (pointer focus, no ring); choosing the card would re-render the page, and the
  // page moving is not the case. Shift then turns keyboard modality on while the pointer's focus is still there.
  await tab.mouse.move(point.x, point.y);
  await tab.mouse.down();
  await tab.keyboard.press('Shift');
  const nearStop = await ringOfFocused(tab);
  const nearGap = await placeFromFrameTop(near.locator, null);
  await tab.mouse.up();
  const half = await attempt(-hidden, gap => gap <= -hidden + 1 && gap >= -hidden - 1);
  await tab.keyboard.press('Shift');
  await half.locator.locator(radio).evaluate(node => (node as HTMLElement).focus({ preventScroll: true }));
  const halfStop = await ringOfFocused(tab);
  const halfGap = await placeFromFrameTop(half.locator, null);
  return {
    nearTop: { card: near.card, gap: near.gap, gapAtRing: nearGap, stop: nearStop },
    partlyHidden: { card: half.card, gap: half.gap, gapAtRing: halfGap, stop: halfStop },
  };
};

/**
 * The contrast of the ring drawn by the element around the focused control (`owner`, such as a card that outlines itself while
 * its radio has keyboard focus) against the owner's own fill (what sits on both sides of an inset ring) and against the page
 * behind the owner. Null when nothing focused sits in such an owner or the owner paints no outline.
 */
export const ringContrastOf = async (tab: Page, owner: string): Promise<{ card: number; page: number } | null> => {
  await tab.evaluate(COLOUR_TOOLS);
  return tab.evaluate(selector => {
    const colour = (window as unknown as { __colour: ColourTools }).__colour;
    const el = document.activeElement?.closest(selector) as HTMLElement | null | undefined;
    if (el === null || el === undefined) return null;
    const style = getComputedStyle(el);
    if (style.outlineStyle === 'none' || !(Number.parseFloat(style.outlineWidth) > 0)) return null;
    const ring = colour.rgba(style.outlineColor);
    const fill = colour.backdrop(el);
    const page = colour.backdrop(el.parentElement ?? el);
    const seen = (below: readonly number[]) => colour.over(ring, [...below, 1]);
    return { card: colour.ratio(seen(fill), fill), page: colour.ratio(seen(page), page) };
  }, owner);
};
