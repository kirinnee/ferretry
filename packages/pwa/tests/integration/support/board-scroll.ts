/**
 * What a real browser says about the Board's scrolling, read from the page (never inferred from the
 * source): which elements scroll up and down, where the lane strip sits, how far down the first card
 * starts, and whether a pull from the top still opens the finder.
 *
 * Shared by `board-scroll.visual.test.ts` (which asserts on it) and `harness/board-screenshot.ts`
 * (which prints it beside the review frames), so the number a reviewer reads is the number CI gated on.
 */
import type { Page } from 'playwright-core';

export interface BoardScrollFacts {
  readonly viewport: number;
  /** Every element in the page whose computed `overflow-y` makes it a vertical scroller. */
  readonly verticalScrollers: readonly string[];
  /** The subset that really has more to scroll than it shows. */
  readonly scrollingNow: readonly string[];
  /** How far the document itself overflows the window (a second, hidden scroller). */
  readonly documentOverflow: number;
  readonly boardScrollTop: number;
  readonly boardTop: number;
  readonly strip: { readonly position: string; readonly top: number } | null;
  /** Each piece of chrome above the strip: the bottom edge of its box. */
  readonly chromeBottoms: Readonly<Record<string, number>>;
  readonly firstCardTop: number | null;
  /** Is the strip, not a card, what a finger meets at the strip's own centre? */
  readonly stripOnTop: boolean;
}

const CHROME = ['.fy-board__views', '.fy-board__phone-bar', '.fy-board__notice'] as const;

export const readBoardScroll = async (page: Page): Promise<BoardScrollFacts> =>
  await page.evaluate(chrome => {
    const label = (element: Element): string =>
      element.className === '' || typeof element.className !== 'string'
        ? element.tagName.toLowerCase()
        : (element.className.split(/\s+/u)[0] ?? '');
    const board = document.querySelector<HTMLElement>('.fy-board');
    const strip = document.querySelector<HTMLElement>('.fy-board-phone__strip');
    const card = document.querySelector<HTMLElement>('.fy-board-card');
    const scrollers = [...document.querySelectorAll<HTMLElement>('#root *')].filter(element =>
      ['auto', 'scroll', 'overlay'].includes(getComputedStyle(element).overflowY),
    );
    const stripBox = strip?.getBoundingClientRect() ?? null;
    const middle =
      stripBox === null ? null : document.elementFromPoint(stripBox.left + stripBox.width / 2, stripBox.top + 2);
    return {
      viewport: window.innerHeight,
      verticalScrollers: scrollers.map(label),
      scrollingNow: scrollers.filter(element => element.scrollHeight > element.clientHeight + 1).map(label),
      documentOverflow: document.documentElement.scrollHeight - window.innerHeight,
      boardScrollTop: board?.scrollTop ?? 0,
      boardTop: board?.getBoundingClientRect().top ?? 0,
      strip:
        strip === null || stripBox === null ? null : { position: getComputedStyle(strip).position, top: stripBox.top },
      chromeBottoms: Object.fromEntries(
        chrome.map(selector => [
          selector,
          document.querySelector(selector)?.getBoundingClientRect().bottom ?? Number.NaN,
        ]),
      ),
      firstCardTop: card?.getBoundingClientRect().top ?? null,
      stripOnTop: middle !== null && (strip?.contains(middle) ?? false),
    };
  }, CHROME);

export const scrollBoardTo = async (page: Page, top: number): Promise<void> => {
  await page.locator('.fy-board').evaluate((element, to) => element.scrollTo(0, to), top);
  await page.waitForTimeout(150);
};

/**
 * A one-finger drag straight down from `fromY`, as a real touch (Chrome's `Input.dispatchTouchEvent`), and how
 * many times the finder opened because of it. The scene counts `onOpen` in `window.__paletteOpened`.
 */
export const pullDown = async (page: Page, fromY: number, distance: number): Promise<number> => {
  const session = await page.context().newCDPSession(page);
  const x = 195;
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', y: number) =>
    session.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const before = await page.evaluate(() => (window as unknown as { __paletteOpened?: number }).__paletteOpened ?? 0);
  await touch('touchStart', fromY);
  for (let step = 1; step <= 8; step += 1) await touch('touchMove', fromY + (distance * step) / 8);
  await touch('touchEnd', fromY + distance);
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => (window as unknown as { __paletteOpened?: number }).__paletteOpened ?? 0);
  await session.detach();
  return after - before;
};
