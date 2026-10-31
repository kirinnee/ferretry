import { loopbackListenersOn } from '@ferretry/protocol';

/**
 * WHETHER THE PROGRAM THE DAEMON JUST STARTED IS THE ONE LISTENING on the loopback port it was told to take.
 *
 * The agent Chrome's DevTools port and the login window's x11vnc port are picked free, released, and only
 * then bound by the child — and on a host several people share, any local account can bind a free loopback
 * port in between. The daemon would then drive (or show a person) whatever answered: a squatter's endpoint
 * instead of the browser it launched. Nothing in TCP tells the two apart, but the kernel does: the socket
 * table names each listener's uid and inode (`@ferretry/protocol`'s `parseTcpListeners`), and the process
 * that holds a socket has a `socket:[<inode>]` link in `/proc/<pid>/fd`.
 *
 * So a listener is PROVEN only when every listener a loopback connection to the port could reach is this
 * user's AND is held by the process the daemon spawned (or one it started — x11vnc runs under `timeout(1)`).
 * Root is not trusted here, unlike the CLI's credential check: root's listener is still not this browser.
 * The decision is pure — the tables and the inodes are passed in — so it is tested on fixture text.
 *
 * GAP — macOS IS NOT CHECKED. It has no `/proc`, so the proof is `unknown` and the launch proceeds as it did
 * before this check existed — the same GAP the CLI's credential check declares. A shared macOS host would need
 * `lsof -nP -iTCP:<port> -sTCP:LISTEN` (or `proc_pidinfo`) to read the same two facts.
 */

export type ListenerProof =
  /** Every reachable listener on the port is the spawned process's own socket. */
  | { readonly kind: 'proven' }
  /** Nothing listens there yet: a child that binds a moment after spawn is still starting. */
  | { readonly kind: 'absent' }
  /** Something other than the spawned process holds the port, or shares it. */
  | { readonly kind: 'foreign'; readonly uid: number }
  /** This host publishes no socket table, or this process has no uid, so nothing can be proven. */
  | { readonly kind: 'unknown' };

/** What one look at the host found: its socket tables, and the socket inodes the spawned process holds. */
export interface ListenerEvidence {
  /** `undefined` on a host that publishes none (macOS). */
  readonly tables: readonly string[] | undefined;
  readonly inodes: ReadonlySet<number>;
}

/** Judges `port` against what the host showed, for a process running as `ownUid`. */
export function proveListener(port: number, ownUid: number | undefined, evidence: ListenerEvidence): ListenerProof {
  if (evidence.tables === undefined || ownUid === undefined) return { kind: 'unknown' };
  const reachable = loopbackListenersOn(port, evidence.tables);
  if (reachable.length === 0) return { kind: 'absent' };
  const strangers = reachable.filter(listener => listener.uid !== ownUid || !evidence.inodes.has(listener.inode));
  // Another account's listener is the one worth naming: it is the squatter, where a second program of this
  // user's is only a collision.
  const named = strangers.find(listener => listener.uid !== ownUid) ?? strangers[0];
  return named === undefined ? { kind: 'proven' } : { kind: 'foreign', uid: named.uid };
}

/**
 * The refusal, in the one sentence every listener the daemon starts gives: the port, who holds it, and what to
 * do. `uid` is absent when the holder could not be read (a bind that failed on a port no table shows).
 */
export function listenerHeldRefusal(port: number, uid?: number): string {
  const holder = uid === undefined ? 'another program' : `another program (uid ${String(uid)})`;
  return `port ${String(port)} is held by ${holder}, not this browser — someone may be squatting it; pick another port base or free it`;
}
