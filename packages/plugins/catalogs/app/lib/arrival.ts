/**
 * A SHARE LINK'S CODE LEAVES THE ADDRESS BAR BEFORE ANYTHING ELSE LOADS. The link's fragment holds a live, single-use
 * code, so it is read once and then taken out of the address with `replaceState`, not `pushState`: Back must never
 * restore it, and it must not linger in the history. Copied from today's `JoinRoute` (App.tsx `takeArrivalFromLocation`).
 *
 * WHO DOES IT: not the `/join` view, which is a lazily loaded chunk that may be slow or never arrive, but an
 * {@link ArrivalHold} armed by this half's eager module when the shell builds its daemon-less screens, before the first
 * render. It strips the first link at once and every later one (a second link opened in the same tab, a `hashchange`),
 * and holds the fragment in memory until the `/join` view comes for it. This file holds no React, so it loads with the
 * eager module. The entry's own history state is passed back (`history.state`), so the router's trail and scroll
 * identity for that entry survive the rewrite.
 *
 * WHICH ADDRESSES: the ones the shell's router draws the join screen at, decided by the router's own parse
 * (`@ferretry/app` `addressPlace`), never by comparing a string: `/join/`, `/app/join` and `/j%6Fin` are the join
 * screen as much as `/join` is, and a gate of its own would drift from the router. A link beneath the join address
 * (`/join/x`, which the router draws as not-found) leaves the address too, and is dropped: no join screen is drawn
 * there to take it, and a held code must never reach a join the person did not see begin.
 */

import type { AddressPlace } from '@ferretry/app';

/** The slice of `window` the strip needs. */
export interface ArrivalBrowser {
  readonly location: Pick<Location, 'pathname' | 'search' | 'hash'>;
  readonly history: Pick<History, 'state' | 'replaceState'>;
}

/** The slice of `window` a hold needs: the strip, and the one event a second link raises. */
export interface ArrivalWindow extends ArrivalBrowser {
  readonly addEventListener: (type: 'hashchange', listener: () => void) => void;
}

/** The fragment now in the address bar, taken out of it. Empty when there was none (and then nothing is rewritten). */
export function takeArrival(browser: ArrivalBrowser): string {
  const fragment = browser.location.hash;
  if (fragment === '') return '';
  browser.history.replaceState(browser.history.state, '', `${browser.location.pathname}${browser.location.search}`);
  return fragment;
}

/**
 * THE LINKS THAT ARRIVED AT THE JOIN ADDRESS, off the address and held in memory only. A link is delivered to the
 * screen that is listening; with none listening it waits (the screen's chunk has not arrived, or failed) and the screen
 * takes it when it mounts.
 */
export interface ArrivalHold {
  /** Reads the address now: a fragment found at the join address leaves it and is held or delivered. */
  readonly read: () => void;
  /** The link waiting for a screen, without taking it; empty when none waits. */
  readonly waiting: () => string;
  /** The link waiting for a screen, taken: it is no longer held. Empty when none waits. */
  readonly take: () => string;
  /** Listens for links that arrive from now on (each is delivered, not held); returns the way to stop. */
  readonly subscribe: (onLink: (fragment: string) => void) => () => void;
}

const isWindow = (candidate: Partial<ArrivalWindow>): candidate is ArrivalWindow =>
  candidate.location !== undefined &&
  candidate.history !== undefined &&
  typeof candidate.addEventListener === 'function';

/**
 * Arms the hold: strips a link already in the address now, and every one that arrives by `hashchange`, but only while
 * `place` says the page is at the join screen or beneath it (a fragment on any other page is not a share link and is
 * left alone). Only a link AT the join screen is held or delivered. Where there is no window (the registry generator and
 * every non-browser caller that only inspects the half) there is no address, so nothing is read and nothing is ever held.
 */
export function armArrivalHold(
  candidate: Partial<ArrivalWindow>,
  place: (pathname: string) => AddressPlace,
): ArrivalHold {
  const browser = isWindow(candidate) ? candidate : undefined;
  let waiting = '';
  const listeners = new Set<(fragment: string) => void>();
  const read = (): void => {
    if (browser === undefined) return;
    const here = place(browser.location.pathname);
    if (here === 'elsewhere') return;
    const fragment = takeArrival(browser);
    if (fragment === '' || here === 'beneath') return;
    if (listeners.size === 0) waiting = fragment;
    else for (const listener of [...listeners]) listener(fragment);
  };
  browser?.addEventListener('hashchange', read);
  read();
  return {
    read,
    waiting: () => waiting,
    take: () => {
      const link = waiting;
      waiting = '';
      return link;
    },
    subscribe: onLink => {
      listeners.add(onLink);
      return () => void listeners.delete(onLink);
    },
  };
}
