/**
 * A SHARE LINK'S CODE LEAVES THE ADDRESS BAR AT ONCE. The link's fragment holds a live, single-use code, so it is read
 * once and then taken out of the address with `replaceState`, not `pushState`: Back must never restore it, and it must
 * not linger in the history. Copied from today's `JoinRoute` (App.tsx `takeArrivalFromLocation`).
 *
 * WHO DOES IT: the `/join` screen, which the shell draws with no daemon at all (a recipient's browser usually holds no
 * pairing). It takes the fragment on mount and on every later arrival (a second link opened in the same tab, a
 * `hashchange`). The entry's own history state is passed back (`history.state`), so the router's trail and scroll
 * identity for that entry survive the rewrite.
 */

/** The slice of `window` this needs. */
export interface ArrivalBrowser {
  readonly location: Pick<Location, 'pathname' | 'search' | 'hash'>;
  readonly history: Pick<History, 'state' | 'replaceState'>;
}

/** The fragment of an address, or empty when there is none. */
export function fragmentOf(address: string): string {
  try {
    return new URL(address).hash;
  } catch {
    return '';
  }
}

/** The fragment now in the address bar, taken out of it. Empty when there was none (and then nothing is rewritten). */
export function takeArrival(browser: ArrivalBrowser): string {
  const fragment = browser.location.hash;
  if (fragment === '') return '';
  browser.history.replaceState(browser.history.state, '', `${browser.location.pathname}${browser.location.search}`);
  return fragment;
}
