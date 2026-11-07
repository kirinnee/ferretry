/**
 * THE MACHINE a board is read from. The app shell hands this half one generated client per daemon (§9.6), already
 * bound to that daemon and its credential, so a machine here is only the identity the store keys its slices by.
 */
export type DaemonId = string & { readonly daemonId: unique symbol };

export interface DaemonConnection {
  readonly daemonId: DaemonId;
}

/** The one machine this half's client is bound to. */
export const THIS_MACHINE: DaemonConnection = Object.freeze({ daemonId: 'this' as DaemonId });

/** A stable key for a set of machines: what a hook re-subscribes on. */
export const pairingKey = (machines: readonly DaemonConnection[]): string =>
  machines
    .map(machine => machine.daemonId)
    .sort()
    .join('\u0000');

/** A ferret on a machine: the identity a ferret-side panel, a chat origin and a composer hand-off share. */
export interface FerretScope {
  readonly daemonId: DaemonId;
  readonly ferret: string;
}

/** The hand-off to the ferret's composer: a card reference to type into it. Conversation listens for it. */
export const COMPOSE_REFERENCE_EVENT = 'ferretry:compose-reference';

export interface ComposeReference {
  readonly ferret: string;
  readonly reference: string;
}

/** Asks the ferret's composer to add `reference` (e.g. `&F12`). Answers a sentence for a status line. */
export const addReferenceToComposer = (scope: FerretScope, reference: string): string => {
  const browser = globalThis as unknown as {
    readonly dispatchEvent?: (event: unknown) => boolean;
    readonly CustomEvent?: new (type: string, init: { detail: ComposeReference }) => unknown;
  };
  if (browser.CustomEvent === undefined || browser.dispatchEvent === undefined) return `Could not add ${reference} to the chat.`;
  browser.dispatchEvent(new browser.CustomEvent(COMPOSE_REFERENCE_EVENT, { detail: { ferret: scope.ferret, reference } }));
  return `Added ${reference} to the chat.`;
};
