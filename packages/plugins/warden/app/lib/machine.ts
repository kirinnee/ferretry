/**
 * THE DAEMON A WARDEN VIEW READS: its id and the name it is known by. The app shell hands this half one generated
 * client per daemon (§9.6), already bound to that daemon and its session; a daemon here is only the identity a
 * section, a poll and a draft are keyed by. It carries no address and no credential — nothing in this half reaches a
 * daemon but through a client.
 */

export type DaemonId = string & { readonly daemonId: unique symbol };

export interface DaemonConnection {
  readonly daemonId: DaemonId;
  readonly daemonName?: string;
}

export interface DaemonConnectionInput {
  readonly daemonId: string;
  readonly daemonName?: string | undefined;
}

/** A daemon by its id (and the name its reader knows it by, when known). */
export const daemonConnection = (input: DaemonConnectionInput): DaemonConnection => {
  if (input.daemonId.trim() === '') throw new Error('daemonId must not be empty');
  const name = input.daemonName?.trim() || undefined;
  return { daemonId: input.daemonId as DaemonId, ...(name === undefined ? {} : { daemonName: name }) };
};
