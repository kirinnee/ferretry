import { useEffect, useSyncExternalStore } from 'react';
import {
  clearRuleDeepLink,
  markRuleDeepLinkRouted,
  pendingRuleDeepLink,
  subscribeRuleDeepLink,
} from '../lib/rule-deep-link.ts';

/** The machine a `#rules/<stage>` link opens on: the link names none, so it is the selected one, else the only one. */
export interface RuleLinkMachine {
  /** Where that machine's Secure copy panel is: its Settings path and the hash that opens the panel. */
  readonly secureCopyPath: string;
}

/**
 * Sends a `#rules/<stage>` link to the active machine's Secure copy panel, once. With no paired machine there is
 * nowhere to look, so the link is dropped rather than held. The panel itself decides whether the stage is listed.
 */
export function useRuleDeepLink(
  machine: RuleLinkMachine | null,
  paired: boolean,
  navigate: (to: string, options?: { readonly replace?: boolean }) => void,
): void {
  const link = useSyncExternalStore(subscribeRuleDeepLink, pendingRuleDeepLink, pendingRuleDeepLink);
  useEffect(() => {
    if (link === null || link.routed) return;
    if (!paired) {
      clearRuleDeepLink();
      return;
    }
    if (machine === null) return;
    markRuleDeepLinkRouted();
    navigate(machine.secureCopyPath);
  }, [link, machine, paired, navigate]);
}
