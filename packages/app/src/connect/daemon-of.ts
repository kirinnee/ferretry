/**
 * WHICH DAEMON A HALF WAS BUILT FOR (lead decision 22). A half is built once per (daemon, package) against that
 * daemon's guarded client (`surfaces/halves.ts`), but the kernel's `AppContext` names no daemon. Connections' app half
 * needs the one fact — whose carrier its Connection panel and preference describe — so the shell records the daemon
 * of every client it hands out, and a half asks with the client it was given. An id, never a credential.
 */
const daemons = new WeakMap<object, string>();

/** The shell runtime records the daemon of each package client it makes. */
export function noteClientDaemon(client: object, daemon: string): void {
  daemons.set(client, daemon);
}

/** The daemon a half's client talks to, or `undefined` for a client the shell did not make. */
export function daemonOfClient(client: object): string | undefined {
  return daemons.get(client);
}
