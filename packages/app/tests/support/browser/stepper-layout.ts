/**
 * Real-browser READS of how a stepper page is laid out, shared by the end-to-end onboarding gate. Each one measures what a
 * person would see, never a marker the page puts there for the test:
 *
 *   - `gapUnderTitle`   the distance from the page title (and its one line) to the FIRST thing drawn in the body;
 *   - `underFooter`     scrolls every scroller to its end, then lists every visible thing that sits under the sticky footer;
 *   - `clippedBoxes`    every box that hides text it holds (sideways, or a clipped height) inside a root;
 *   - `footerButtons`   the footer's buttons in the order they are drawn, with their boxes.
 *
 * They run inside the page (`page.evaluate`), so they take only strings and return plain data.
 */
import type { Page } from 'playwright-core';

export interface Gap {
  /** Pixels from the bottom of the header to the top of the first visible text or control of the body; -1 when nothing is drawn. */
  readonly gap: number;
  /** What the first visible thing is (for the failure message). */
  readonly first: string;
}

export async function gapUnderTitle(tab: Page, head: string, body: string): Promise<Gap> {
  return await tab.evaluate(
    ([headSelector, bodySelector]) => {
      const header = document.querySelector(headSelector as string);
      const root = document.querySelector(bodySelector as string);
      if (header === null || root === null) return { gap: -1, first: 'no header or body' };
      const headBottom = header.getBoundingClientRect().bottom;
      let top = Number.POSITIVE_INFINITY;
      let first = '';
      const consider = (el: Element, at: number): void => {
        if (at < top) {
          top = at;
          // The boxes from the body down to it, each with its offset under the header: where the space comes from.
          const chain: string[] = [];
          for (let up: Element | null = el; up !== null && up !== root; up = up.parentElement)
            chain.unshift(
              `${up.tagName.toLowerCase()}.${String(up.className).slice(0, 24)}@${Math.round(up.getBoundingClientRect().top - headBottom)}${up.previousElementSibling === null ? '' : `(after ${up.previousElementSibling.tagName.toLowerCase()}.${String(up.previousElementSibling.className).slice(0, 20)} h${Math.round(up.previousElementSibling.getBoundingClientRect().height)})`}`,
            );
          first = chain.join(' > ');
        }
      };
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const el = node.parentElement;
        if (el === null || (node.textContent ?? '').trim() === '' || el.closest('[hidden]') !== null) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const box = range.getBoundingClientRect();
        if (box.height > 0 && box.width > 0) consider(el, box.top);
      }
      for (const el of root.querySelectorAll('*')) {
        if (el.closest('[hidden]') !== null) continue;
        const box = el.getBoundingClientRect();
        if (box.height === 0 || box.width === 0) continue;
        const style = getComputedStyle(el);
        // A box that draws something of its own: a control, a picture, a border or a fill (a card counts from its edge, not its text).
        const draws =
          /^(button|input|textarea|select|img|canvas|svg)$/iu.test(el.tagName) ||
          el.getAttribute('role') === 'radio' ||
          Number.parseFloat(style.borderTopWidth) > 0 ||
          (style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent');
        if (draws) consider(el, box.top);
      }
      return { gap: Number.isFinite(top) ? top - headBottom : -1, first };
    },
    [head, body],
  );
}

/**
 * Scrolls every scrollable ancestor of the footer (and the window) to its end, then returns one line for every visible text
 * or control whose box reaches under the footer. Empty means nothing hides behind it. The scroll is put back afterwards.
 */
export async function underFooter(tab: Page, footer: string): Promise<string[]> {
  return await tab.evaluate(selector => {
    const bar = document.querySelector(selector);
    if (bar === null) return [`no footer matches ${selector}`];
    const scrolled: [Element, number][] = [];
    for (let el: Element | null = bar.parentElement; el !== null; el = el.parentElement)
      if (el.scrollHeight > el.clientHeight + 1) {
        scrolled.push([el, el.scrollTop]);
        el.scrollTop = el.scrollHeight;
      }
    const before = window.scrollY;
    window.scrollTo(0, document.documentElement.scrollHeight);
    const rect = bar.getBoundingClientRect();
    const out: string[] = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (bar.contains(el) || el.contains(bar)) continue;
      if (el.closest('[data-living-background], .fy-lb, [aria-hidden="true"], [hidden], svg') !== null) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.position === 'fixed') continue;
      // The body of a closed <details> draws nothing (only its summary does), whatever its box says.
      const folded = el.closest('details');
      if (folded !== null && !folded.open && el.closest('summary') === null) continue;
      const box = el.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) continue;
      const draws =
        /^(button|input|textarea|select|img|canvas|label|summary)$/iu.test(el.tagName) ||
        [...el.childNodes].some(node => node.nodeType === 3 && (node.textContent ?? '').trim() !== '');
      if (!draws) continue;
      if (box.bottom > rect.top + 0.5 && box.top < rect.bottom)
        out.push(
          `${el.tagName.toLowerCase()} '${(el.textContent ?? '').trim().slice(0, 30)}' ends at ${Math.round(box.bottom)}, footer starts at ${Math.round(rect.top)}`,
        );
    }
    for (const [el, top] of scrolled) el.scrollTop = top;
    window.scrollTo(0, before);
    return out;
  }, footer);
}

/** Every box inside `root` that hides some of what it holds: sideways (hidden, clipped or scrolling) or a clipped height. */
export async function clippedBoxes(tab: Page, root: string): Promise<string[]> {
  return await tab.evaluate(selector => {
    const out: string[] = [];
    for (const top of document.querySelectorAll(selector))
      for (const el of top.querySelectorAll('*')) {
        if (el.closest('[data-living-background], .fy-lb, [aria-hidden="true"], [hidden]') !== null) continue;
        if (/^(textarea|input|html|body)$/iu.test(el.tagName)) continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.position === 'absolute') continue;
        const sideways = ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX);
        const tall = ['hidden', 'clip'].includes(style.overflowY);
        if ((sideways && el.scrollWidth > el.clientWidth + 1) || (tall && el.scrollHeight > el.clientHeight + 1))
          out.push(
            `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} (${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight})`,
          );
      }
    return out;
  }, root);
}

export interface FooterButton {
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly mark: string;
}

/** The footer's buttons, left to right as drawn. */
export async function footerButtons(tab: Page, footer = '[data-step-footer]'): Promise<FooterButton[]> {
  return await tab.evaluate(selector => {
    const buttons = [...document.querySelectorAll(`${selector} button`)].map(button => {
      const box = button.getBoundingClientRect();
      const marks = [...button.getAttributeNames()].filter(name => name.startsWith('data-'));
      return {
        label: (button.textContent ?? '').trim(),
        x: box.x,
        y: box.y,
        w: box.width,
        h: box.height,
        mark: marks.join(' '),
      };
    });
    return buttons.sort((a, b) => a.x - b.x);
  }, footer);
}

/** Where a page is scrolled to when its pinned strip is read: the very top, halfway down, or the very end. */
export type PinScroll = 'top' | 'mid' | 'bottom';

export interface PinReading {
  /** The strip's box (heading + demo) and the screen's width, in CSS pixels. */
  readonly pin: { readonly top: number; readonly left: number; readonly right: number; readonly bottom: number };
  readonly screenWidth: number;
  /** The strip's own fill is a fully opaque colour. */
  readonly opaque: boolean;
  /** The heading's box is inside the strip. */
  readonly headingInside: boolean;
  /** The sampled points of the strip (a grid, gutters included) whose topmost painted element is NOT part of the strip. */
  readonly behind: readonly string[];
  /** Points in the band above the strip (the page edge to the strip's top) whose topmost element is page body, not the strip. */
  readonly above: readonly string[];
  /** The demo's text lines that spill out of the demo's box (sideways or below). */
  readonly spill: readonly string[];
  /** How far the page was scrolled (px) and how far it can scroll. */
  readonly scrolled: number;
  readonly scrollable: number;
}

/**
 * Scroll the step page to `where`, then read its pinned strip (`.fy-spf__pin`): is it opaque, as wide as the screen, does it hold the
 * heading, and is anything of the body painted over or around it? `elementsFromPoint` answers "what is drawn there" for a grid of points,
 * so a card showing through (the "Ag" tiles above Appearance's preview) is found, not guessed.
 */
export async function pinnedStrip(tab: Page, where: PinScroll): Promise<PinReading> {
  return await tab.evaluate(position => {
    const pin = document.querySelector('.fy-spf__pin') as HTMLElement;
    const scrollerOf = (node: HTMLElement): HTMLElement => {
      for (let up = node.parentElement; up !== null; up = up.parentElement) {
        const { overflowY } = getComputedStyle(up);
        if ((overflowY === 'auto' || overflowY === 'scroll') && up.scrollHeight > up.clientHeight + 1) return up;
      }
      return document.scrollingElement as HTMLElement;
    };
    const scroller = scrollerOf(pin);
    const reach = scroller.scrollHeight - scroller.clientHeight;
    scroller.scrollTop = position === 'top' ? 0 : position === 'mid' ? reach / 2 : reach;
    const box = pin.getBoundingClientRect();
    const fill = getComputedStyle(pin).backgroundColor;
    const alpha = /rgba\(.*,\s*([\d.]+)\)$/.exec(fill);
    const heading = (pin.querySelector('.fy-spf__title') as HTMLElement).getBoundingClientRect();
    const name = (el: Element): string => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)}`;
    const behind: string[] = [];
    const above: string[] = [];
    const inset = 1;
    for (const x of [inset, box.width * 0.25, box.width * 0.5, box.width * 0.75, box.width - inset - 1]) {
      for (let row = 0; row <= 6; row += 1) {
        const y = box.top + inset + ((box.height - 2 * inset - 1) * row) / 6;
        if (y < 0 || y >= innerHeight) continue;
        const top = document.elementsFromPoint(box.left + x, y)[0];
        if (top === undefined || !pin.contains(top))
          behind.push(`${Math.round(box.left + x)},${Math.round(y)}: ${top === undefined ? 'nothing' : name(top)}`);
      }
      // The band between the screen's top and the strip (only exists once the strip has stuck below something).
      for (let y = 1; y < box.top - 1; y += 4) {
        const top = document.elementsFromPoint(box.left + x, y)[0];
        if (top !== undefined && top.closest('.fy-spf__main') !== null)
          above.push(`${Math.round(x)},${y}: ${name(top)}`);
      }
    }
    const demo = pin.querySelector('.fy-spf__demo') as HTMLElement;
    const demoBox = demo.getBoundingClientRect();
    const spill: string[] = [];
    for (const text of demo.querySelectorAll<HTMLElement>('p, span')) {
      const range = document.createRange();
      range.selectNodeContents(text);
      for (const rect of range.getClientRects())
        if (
          rect.width > 0 &&
          (rect.right > demoBox.right + 0.5 ||
            rect.left < demoBox.left - 0.5 ||
            rect.bottom > demoBox.bottom + 0.5 ||
            rect.top < demoBox.top - 0.5)
        )
          spill.push(
            `${name(text)} ${Math.round(rect.left)}..${Math.round(rect.right)} of ${Math.round(demoBox.left)}..${Math.round(demoBox.right)}`,
          );
    }
    return {
      pin: { top: box.top, left: box.left, right: box.right, bottom: box.bottom },
      screenWidth: document.documentElement.clientWidth,
      opaque: alpha === null ? fill !== 'rgba(0, 0, 0, 0)' && fill !== 'transparent' : Number(alpha[1]) === 1,
      headingInside: heading.top >= box.top - 0.5 && heading.bottom <= box.bottom + 0.5,
      behind,
      above,
      spill,
      scrolled: scroller.scrollTop,
      scrollable: reach,
    };
  }, where);
}
