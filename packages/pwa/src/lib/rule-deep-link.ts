/**
 * THE APPROVAL A LINK OPENS (`<app>/#rules/<stage>`, printed by `fy rules add`). The fragment is read once, before the
 * router can redirect away from it, then held here until the shell has routed to a machine's Secure copy panel and that
 * panel has read the daemon's list. A fragment only picks WHICH row to show: it never reaches the daemon and never asks
 * for a passkey; the owner still taps Confirm on the row.
 */

import { type DaemonId, ruleDeepLinkFromFragment, type SignInRuleStageId } from '@ferretry/protocol';

export interface RuleDeepLink {
  readonly stage: SignInRuleStageId;
  /** The machine the link names (`?machine=<daemon id>`), when the printer knew which one holds the stage. */
  readonly machine?: DaemonId;
  /** Whether the shell has already sent the page to a machine's Secure copy panel. */
  readonly routed: boolean;
}

let pending: RuleDeepLink | null = null;
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of listeners) listener();
};

/** Reads the address bar's fragment into the pending link, and takes it out of the address bar. */
export function captureRuleDeepLink(location: Pick<Location, 'hash' | 'pathname' | 'search'> = window.location): void {
  const found = ruleDeepLinkFromFragment(location.hash);
  if (found === null) return;
  pending = { ...found, routed: false };
  // `replaceState`, so Back never returns to the link and a reload does not open the row again.
  window.history.replaceState(window.history.state, '', `${location.pathname}${location.search}`);
  notify();
}

/** Reads a link the owner followed while the app was already open (the fragment changed under the page). */
export function listenForRuleDeepLinks(
  target: Pick<Window, 'addEventListener' | 'removeEventListener' | 'location'> = window,
): () => void {
  const onChange = (): void => captureRuleDeepLink(target.location);
  target.addEventListener('hashchange', onChange);
  return () => target.removeEventListener('hashchange', onChange);
}

export const pendingRuleDeepLink = (): RuleDeepLink | null => pending;

/** Marks the link as sent to a panel; the pending value (and so the stage) stays for that panel to read. */
export const markRuleDeepLinkRouted = (): void => {
  if (pending === null || pending.routed) return;
  pending = { ...pending, routed: true };
  notify();
};

export const clearRuleDeepLink = (): void => {
  if (pending === null) return;
  pending = null;
  notify();
};

export const subscribeRuleDeepLink = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
