/**
 * THE CARD A LINK OPENS (`<app>/#agenda/<id>?session=<sessionId>`, printed by `fy plan approve`). The fragment is read
 * once, before the router can redirect away from it, then held here until the shell has a paired machine that runs the
 * session. Nothing in a fragment reaches the daemon; it only picks which card the app opens.
 */

import { type AgendaDeepLink, agendaDeepLinkFromHash } from './agenda-inbox.ts';

let pending: AgendaDeepLink | null = null;
const listeners = new Set<() => void>();

/** Reads the address bar's fragment into the pending link, and takes it out of the address bar. */
export function captureAgendaDeepLink(
  location: Pick<Location, 'hash' | 'pathname' | 'search'> = window.location,
): void {
  const link = agendaDeepLinkFromHash(location.hash);
  if (link === null) return;
  pending = link;
  // `replaceState`, so Back never returns to the link and a reload does not open the card again.
  window.history.replaceState(window.history.state, '', `${location.pathname}${location.search}`);
  for (const listener of listeners) listener();
}

export const pendingAgendaDeepLink = (): AgendaDeepLink | null => pending;

export const clearAgendaDeepLink = (): void => {
  pending = null;
};

export const subscribeAgendaDeepLink = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
