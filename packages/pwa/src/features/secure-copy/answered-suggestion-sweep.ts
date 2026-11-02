/**
 * Reads the owner's list of ferrets' rule suggestions (`GET /v1/sign-in-rules/suggestions`) for each machine whose
 * Inbox holds a suggestion card, and marks the ones it no longer holds as answered (R1, C2): a suggestion the owner
 * dismissed or approved on another device, or before this page loaded, leaves the Inbox though its card stays open on
 * the ferret's agenda. A machine that cannot answer (an older daemon, a device that may not see accounts) hides nothing.
 */

import { useEffect } from 'react';
import type { InboxCard } from '../../lib/agenda-inbox.ts';
import { type AnsweredSuggestions, answeredSuggestions } from '../../lib/answered-suggestions.ts';
import type { DaemonConnection, DaemonId } from '../../lib/daemon-connection.ts';
import { listSuggestions, type RuleClient } from '../../lib/sign-in-rules.ts';
import { useDaemonClient } from '../../lib/store.tsx';

export function useAnsweredSuggestionSweep(
  cards: readonly InboxCard[],
  connectionFor: (daemonId: DaemonId) => DaemonConnection | undefined,
  createClient?: (connection: DaemonConnection) => Promise<RuleClient>,
  answered: AnsweredSuggestions = answeredSuggestions,
): void {
  const routed = useDaemonClient();
  const clientOf = createClient ?? routed;
  const wanted = new Map<DaemonId, string[]>();
  for (const card of cards) {
    const suggestion = card.item.signInRuleSuggestion?.suggestion;
    if (suggestion !== undefined) wanted.set(card.daemonId, [...(wanted.get(card.daemonId) ?? []), suggestion]);
  }
  const key = JSON.stringify([...wanted].sort(([a], [b]) => a.localeCompare(b)));

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the cards' suggestions, read once per change
  useEffect(() => {
    let current = true;
    for (const [daemonId, suggestions] of wanted) {
      const connection = connectionFor(daemonId);
      if (connection === undefined) continue;
      void clientOf(connection)
        .then(async client => await listSuggestions(client))
        .then(
          list => {
            if (!current) return;
            const open = new Set(list.suggestions.map(each => each.id));
            answered.mark(
              daemonId,
              suggestions.filter(each => !open.has(each)),
            );
          },
          () => undefined,
        );
    }
    return () => {
      current = false;
    };
  }, [key, clientOf, connectionFor, answered]);
}
