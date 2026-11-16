import { ROUTER_TRAIL_KEY } from '../../src/router/router.tsx';

/**
 * Puts the document where a person is after tapping "All daemons" from inside the app: ON `path` with another entry of
 * this tab's trail behind it. The app's home opens a paired machine only when the app is OPENED (no entry behind); a test
 * that wants the daemon list itself arrives like this, not by typing the address into a fresh tab. The next `go()` (a
 * plain `replaceState` with no entry identity) lands on index 0 again, so nothing here leaks into a later test.
 */
export function arriveAtList(path = '/app/'): void {
  window.history.replaceState({ fyEntry: 'arrive-1', fyIndex: 1 }, '', path);
  window.sessionStorage.setItem(
    ROUTER_TRAIL_KEY,
    JSON.stringify([
      { key: 'arrive-0', path: '/settings' },
      { key: 'arrive-1', path },
    ]),
  );
}
