/**
 * A SHARE LINK'S CODE LEAVES THE ADDRESS BAR AT ONCE. The link's fragment holds a live, single-use code, so it is read
 * once and then taken out of the address with `replaceState`, not `pushState`: Back must never restore it, and it must
 * not linger in the history. Copied from today's `JoinRoute` (App.tsx `takeArrivalFromLocation`).
 */

/** The slice of `window` this needs. */
export interface ArrivalBrowser {
  readonly location: Pick<Location, 'pathname' | 'search' | 'hash'>;
  readonly history: Pick<History, 'replaceState'>;
}

/** The fragment now in the address, taken out of it. Empty when there was none (and then nothing is rewritten). */
export function takeArrival(browser: ArrivalBrowser): string {
  const fragment = browser.location.hash;
  if (fragment === '') return '';
  browser.history.replaceState({}, '', `${browser.location.pathname}${browser.location.search}`);
  return fragment;
}
