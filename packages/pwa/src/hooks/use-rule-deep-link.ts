import type { DaemonId } from '@ferretry/protocol';
import { useEffect, useSyncExternalStore } from 'react';
import {
  clearRuleDeepLink,
  markRuleDeepLinkRouted,
  pendingRuleDeepLink,
  subscribeRuleDeepLink,
} from '../lib/rule-deep-link.ts';

/** A paired machine a `#rules/<stage>` link can open on, and where its Secure copy panel is. */
export interface RuleLinkMachine {
  readonly daemonId: DaemonId;
  /** Its Settings path and the hash that opens the panel. */
  readonly secureCopyPath: string;
}

/**
 * Sends a `#rules/<stage>` link to the machine's Secure copy panel, once. A link that names a machine opens on that
 * one; a link that names none opens on the selected machine, else the first. A link that names a machine this device is
 * not paired with is dropped and said so (`onElsewhere`), and with no paired machine there is nowhere to look. The
 * panel itself decides whether the stage is listed.
 */
export function useRuleDeepLink(
  machines: readonly RuleLinkMachine[],
  selected: DaemonId | undefined,
  navigate: (to: string, options?: { readonly replace?: boolean }) => void,
  onElsewhere: (machine: DaemonId) => void,
): void {
  const link = useSyncExternalStore(subscribeRuleDeepLink, pendingRuleDeepLink, pendingRuleDeepLink);
  useEffect(() => {
    if (link === null || link.routed) return;
    if (machines.length === 0) {
      clearRuleDeepLink();
      return;
    }
    const target =
      link.machine === undefined
        ? (machines.find(each => each.daemonId === selected) ?? machines[0])
        : machines.find(each => each.daemonId === link.machine);
    if (target === undefined) {
      clearRuleDeepLink();
      if (link.machine !== undefined) onElsewhere(link.machine);
      return;
    }
    markRuleDeepLinkRouted();
    navigate(target.secureCopyPath);
  }, [link, machines, selected, navigate, onElsewhere]);
}
