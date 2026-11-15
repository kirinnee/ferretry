import { z } from 'zod';
import type { FerretsClient } from './client.ts';
import { displayCallsign } from './callsign.ts';

/**
 * WHOSE ASK a work search found, for Conversation's rows (its app hook `conversation.ask-owners`): a ferret id to the
 * callsign it is shown by. An ask hit carries only its ferret's id, which no reader can use.
 *
 * Only the id and the callsign are read from the list; nothing else of a ferret's record leaves this half. The list is
 * read ONCE per daemon, when the search first asks, and kept: a listing never fetches. A read that fails leaves the map
 * empty and is not repeated, so the search shows an ask without an owner rather than a guess.
 */
export const ASK_OWNERS_ROUTE = 'GET /v1/ferrets';

const FerretNamesSchema = z.array(z.looseObject({ id: z.string().min(1), name: z.string() }));

/** Ferret id to callsign for the ferrets listed; a ferret with no callsign is left out. */
export const askOwners = (
  ferrets: readonly { readonly id: string; readonly name: string }[],
): ReadonlyMap<string, string> =>
  new Map(
    ferrets.flatMap(ferret => {
      const callsign = displayCallsign(ferret.name);
      return callsign === '' ? [] : [[ferret.id, callsign] as const];
    }),
  );

export const readAskOwners = async (client: FerretsClient): Promise<ReadonlyMap<string, string>> =>
  askOwners(FerretNamesSchema.parse(await client.call(ASK_OWNERS_ROUTE)));

/** `conversation.ask-owners`: {@link readAskOwners}, read once on the first ask and kept. */
export const askOwnersList = (
  client: FerretsClient,
): {
  readonly subscribe: (listener: () => void) => () => void;
  readonly names: () => ReadonlyMap<string, string>;
} => {
  let known: ReadonlyMap<string, string> = new Map();
  let started = false;
  const listeners = new Set<() => void>();
  return {
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    names: () => {
      if (!started) {
        started = true;
        readAskOwners(client).then(
          read => {
            known = read;
            for (const listener of [...listeners]) listener();
          },
          () => undefined,
        );
      }
      return known;
    },
  };
};
