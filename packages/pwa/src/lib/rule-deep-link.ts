/**
 * THE APPROVAL A LINK OPENS (`<app>/#rules/<stage>`, printed by `fy rules add`). The fragment is read once, before the
 * router can redirect away from it, then held here until the shell has routed to a machine's Secure copy panel and that
 * panel has read the daemon's list. A fragment only picks WHICH row to show: it never reaches the daemon and never asks
 * for a passkey; the owner still taps Confirm on the row.
 */

import { type SignInRuleStageId, SignInRuleStageIdSchema } from '@ferretry/protocol';

export interface RuleDeepLink {
  readonly stage: SignInRuleStageId;
  /** Whether the shell has already sent the page to a machine's Secure copy panel. */
  readonly routed: boolean;
}

let pending: RuleDeepLink | null = null;
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of listeners) listener();
};

/** The stage a `#rules/<stage>` fragment names, or `null` for any other address or a stage id that is not one. */
export function ruleStageFromHash(hash: string): SignInRuleStageId | null {
  const [section, segment, ...rest] = hash.replace(/^#/u, '').split('/');
  if (section !== 'rules' || segment === undefined || segment === '' || rest.length > 0) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  const parsed = SignInRuleStageIdSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

/** Reads the address bar's fragment into the pending link, and takes it out of the address bar. */
export function captureRuleDeepLink(location: Pick<Location, 'hash' | 'pathname' | 'search'> = window.location): void {
  const stage = ruleStageFromHash(location.hash);
  if (stage === null) return;
  pending = { stage, routed: false };
  // `replaceState`, so Back never returns to the link and a reload does not open the row again.
  window.history.replaceState(window.history.state, '', `${location.pathname}${location.search}`);
  notify();
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
