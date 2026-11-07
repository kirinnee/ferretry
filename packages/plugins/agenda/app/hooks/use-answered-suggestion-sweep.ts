/**
 * Reads the owner's list of ferrets' rule suggestions (`GET /v1/sign-in-rules/suggestions`) for each machine whose
 * Inbox holds a suggestion card, and marks the ones it no longer holds as answered (R1, C2): a suggestion the owner
 * dismissed or approved on another device, or before this page loaded, leaves the Inbox though its card stays open on
 * the ferret's agenda. A machine that cannot answer (an older daemon, a device that may not see accounts) hides nothing.
 *
 * The list is Accounts' (its sign-in rule routes): this half reads it through {@link RuleClient}, a port the host binds
 * to the machine's client, and reads only the suggestions' ids from the answer.
 */

import { useEffect } from 'react';
import { z } from 'zod';
import type { InboxCard } from '../lib/agenda-inbox.ts';
import { type AnsweredSuggestions, answeredSuggestions } from '../lib/answered-suggestions.ts';
import type { DaemonConnection, DaemonId } from '../lib/machine.ts';

/** The owner's suggestion list route. */
export const SIGN_IN_RULE_SUGGESTIONS_PATH = '/v1/sign-in-rules/suggestions';

/** A machine's client for the suggestion list: one read by path, parsed with the caller's schema. */
export interface RuleClient {
  readonly request: <T>(path: string, schema: { readonly parse: (value: unknown) => T }) => Promise<T>;
}

/** The part of the owner's list the sweep reads: each open suggestion's id. */
const SuggestionIdsSchema = z.object({ suggestions: z.array(z.object({ id: z.string().min(1) })) });

export function useAnsweredSuggestionSweep(
  cards: readonly InboxCard[],
  connectionFor: (daemonId: DaemonId) => DaemonConnection | undefined,
  createClient: (connection: DaemonConnection) => Promise<RuleClient>,
  answered: AnsweredSuggestions = answeredSuggestions,
): void {
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
      void createClient(connection)
        .then(async client => await client.request(SIGN_IN_RULE_SUGGESTIONS_PATH, SuggestionIdsSchema))
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
  }, [key, createClient, connectionFor, answered]);
}
