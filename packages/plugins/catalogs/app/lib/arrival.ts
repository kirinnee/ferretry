/**
 * A SHARE LINK'S CODE LEAVES THE ADDRESS BAR AT ONCE. The link's fragment holds a live, single-use code, so it is read
 * once and then taken out of the address with `replaceState`, not `pushState`: Back must never restore it, and it must
 * not linger in the history. Copied from today's `JoinRoute` (App.tsx `takeArrivalFromLocation`).
 *
 * The strip does NOT wait for the join screen: this half's `build` starts {@link watchArrivals}, which takes the
 * fragment off `/join` the moment the half is built (and on every later arrival) and HOLDS it in memory until the join
 * screen reads it. A views chunk that is slow, or fails to load, therefore never leaves a code in the address bar.
 */

/** The slice of `window` this needs. */
export interface ArrivalBrowser {
  readonly location: Pick<Location, 'pathname' | 'search' | 'hash'>;
  readonly history: Pick<History, 'replaceState'>;
}

/** The slice of `window` the watcher needs. */
export interface ArrivalWindow extends ArrivalBrowser {
  addEventListener(type: 'hashchange' | 'popstate', listener: () => void): void;
}

/** Where a share link lands. */
const JOIN_PATH = '/join';

/** The fragment now in the address, taken out of it. Empty when there was none (and then nothing is rewritten). */
export function takeArrival(browser: ArrivalBrowser): string {
  const fragment = browser.location.hash;
  if (fragment === '') return '';
  browser.history.replaceState({}, '', `${browser.location.pathname}${browser.location.search}`);
  return fragment;
}

let held = '';
let watching: ArrivalWindow | undefined;

/** Takes a fragment off the join page's address into memory. Anywhere else the address is left alone. */
export function holdArrival(browser: ArrivalBrowser): void {
  if (browser.location.pathname !== JOIN_PATH) return;
  const fragment = takeArrival(browser);
  if (fragment !== '') held = fragment;
}

/** The held fragment, without releasing it (a render may be thrown away and must find it again). */
export function heldArrival(): string {
  return held;
}

/** The held fragment, released: the join screen has it now. */
export function releaseArrival(): string {
  const fragment = held;
  held = '';
  return fragment;
}

/** Holds the arrival in the address now and on every later one. Once per window. */
export function watchArrivals(browser: ArrivalWindow): void {
  if (watching === browser) return;
  watching = browser;
  holdArrival(browser);
  const hold = (): void => holdArrival(browser);
  browser.addEventListener('hashchange', hold);
  browser.addEventListener('popstate', hold);
}

/** For tests: forgets what is held and which window is watched. */
export function resetArrivals(): void {
  held = '';
  watching = undefined;
}
