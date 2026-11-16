/**
 * THE MACHINE an agenda is read from, and the ferret scope inside it. The app shell hands this half one generated
 * client per daemon (§9.6), already bound to that daemon and its session, so a machine here is only the identity the
 * stores key their slices by (`daemonOfClient`), and its name for a line that says where an ask came from. It carries
 * no address and no credential: nothing in this half reaches a daemon but through its client.
 */

import type { AgendaId } from '@ferretry/core-asks/contract';

export type DaemonId = string & { readonly daemonId: unique symbol };

export interface DaemonConnection {
  readonly daemonId: DaemonId;
  readonly daemonName?: string;
}

export interface DaemonConnectionInput {
  readonly daemonId: string;
  readonly daemonName?: string | undefined;
}

const requireNonEmpty = (value: string, name: string): string => {
  if (value.trim() === '') throw new Error(`${name} must not be empty`);
  return value;
};

/** Validates a daemon identity. */
export const daemonId = (value: string): DaemonId => requireNonEmpty(value, 'daemonId') as DaemonId;

/** The machine one half's client is bound to, by its id (and the name the reader knows it by, when known). */
export const daemonConnection = (input: DaemonConnectionInput): DaemonConnection => {
  const name = input.daemonName?.trim() || undefined;
  return { daemonId: daemonId(input.daemonId), ...(name === undefined ? {} : { daemonName: name }) };
};

/** The identity a client the shell did not make is keyed by (a harness, a test). */
export const THIS_MACHINE: DaemonConnection = Object.freeze({ daemonId: 'this' as DaemonId });

export interface DaemonSessionScope {
  readonly daemonId: DaemonId;
  readonly sessionId: string;
  /** The draft slot inside the ferret: the ask whose own composer this is. Absent is the ferret's chat. */
  readonly item?: AgendaId;
}

/** Creates the required `(daemonId, ferretId)` identity for UI state; `item` names an ask's own draft slot. */
export const daemonSessionScope = (
  daemon: Pick<DaemonConnection, 'daemonId'>,
  sessionId: string,
  item?: AgendaId,
): DaemonSessionScope => ({
  daemonId: daemon.daemonId,
  sessionId: requireNonEmpty(sessionId, 'sessionId'),
  ...(item === undefined ? {} : { item }),
});

/** A collision-safe key for persisted or in-memory ferret state. */
export const daemonSessionKey = (scope: DaemonSessionScope): string =>
  JSON.stringify(
    scope.item === undefined ? [scope.daemonId, scope.sessionId] : [scope.daemonId, scope.sessionId, scope.item],
  );
