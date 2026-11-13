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
