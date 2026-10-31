/**
 * WHOSE PROGRAM IS LISTENING on the loopback port a credential is about to be sent to.
 *
 * On a host several people share, `127.0.0.1:7432` is not "my daemon" — it is whichever process bound
 * it, and any local account can bind a free loopback port. A daemon that is down (stopped, restarting,
 * updating, or never started because its owner is not logged in) leaves its recorded port free, and the
 * next `fy` would hand the admin token, or an agent's session credential, to whoever took it. Nothing in
 * HTTP can tell the two apart, but the kernel can: every socket in `/proc/net/tcp` names the uid that
 * opened it.
 *
 * So a credential goes to a loopback listener only when every listener that a loopback connection to
 * that port could reach belongs to this user — or to root, which can read the token file anyway, and is
 * who a container's port forward or a socket-activated unit listens as. The decision is pure — the socket tables are passed in —
 * so it is tested on fixture text rather than on a real port.
 *
 * WHAT IT DOES NOT CLOSE: the instant between this read and the connection. A squatter would have to
 * bind in that window, after the owner's daemon released the port, which is a far narrower thing than
 * "any time the daemon is down".
 *
 * GAP — macOS IS NOT CHECKED. It has no `/proc/net`, so the verdict is `unknown` and the credential is sent
 * exactly as it was before this check existed: refusing there would break every call on the owner's Mac,
 * and a Mac is a one-person machine in every setup this product documents. A shared macOS host would need
 * `lsof -nP -iTCP:<port> -sTCP:LISTEN` (or `proc_pidinfo`) here; `docs/multi-user-host.md` declares the
 * shared host as Linux-only until then.
 */

/** One listening socket, as the kernel's table records it. */
export interface TcpListener {
  readonly port: number;
  /** Whether a connection to a loopback address can land on it: bound to loopback or to the wildcard. */
  readonly reachableFromLoopback: boolean;
  readonly uid: number;
}

export type ListenerOwnerVerdict =
  /** Every reachable listener on the port is this user's (or root's). */
  | { readonly kind: 'own' }
  /** Nothing listens there; a connection is refused before any credential is written. */
  | { readonly kind: 'absent' }
  /** Somebody else holds the port, or shares it. */
  | { readonly kind: 'foreign'; readonly uids: readonly number[] }
  /** This host publishes no socket table to read. */
  | { readonly kind: 'unknown' };

/** Root can already read every user's token file, so its listener learns nothing new. */
const ROOT_UID = 0;

/** `0A` is TCP_LISTEN in the kernel's state numbering. */
const LISTEN_STATE = '0A';

/**
 * Parses `/proc/net/tcp` or `/proc/net/tcp6` text into its listening sockets.
 *
 * The local address is `<hex address>:<hex port>`. The address is the raw `in_addr` (or `in6_addr`)
 * printed as 32-bit words in host byte order, so on every little-endian host `127.0.0.1` reads
 * `0100007F`; each word is reversed back into network order before it is judged. A line that does not
 * have the table's shape is skipped, never guessed at.
 */
export function parseTcpListeners(table: string): readonly TcpListener[] {
  const listeners: TcpListener[] = [];
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/u);
    const [, local, , state, , , , uid] = fields;
    if (local === undefined || state !== LISTEN_STATE || uid === undefined || !/^\d+$/u.test(uid)) continue;
    const match = /^([0-9A-Fa-f]{8}|[0-9A-Fa-f]{32}):([0-9A-Fa-f]{4})$/u.exec(local);
    if (match === null) continue;
    const [, address = '', port = ''] = match;
    listeners.push({
      port: Number.parseInt(port, 16),
      reachableFromLoopback: reachableFromLoopback(networkOrderBytes(address)),
      uid: Number(uid),
    });
  }
  return listeners;
}

/** The address's bytes in network order, from the kernel's host-order 32-bit words. */
function networkOrderBytes(hex: string): readonly number[] {
  const bytes: number[] = [];
  for (let word = 0; word < hex.length; word += 8) {
    const chunk = hex.slice(word, word + 8);
    for (let index = 6; index >= 0; index -= 2) bytes.push(Number.parseInt(chunk.slice(index, index + 2), 16));
  }
  return bytes;
}

function reachableFromLoopback(bytes: readonly number[]): boolean {
  if (bytes.every(byte => byte === 0)) return true; // 0.0.0.0 or ::
  if (bytes.length === 4) return bytes[0] === 127;
  const prefix = bytes.slice(0, 15);
  if (prefix.every(byte => byte === 0) && bytes[15] === 1) return true; // ::1
  // ::ffff:127.x.y.z and ::ffff:0.0.0.0 — a v4 loopback or wildcard bind seen through a v6 socket.
  const mapped = bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  return mapped && (bytes[12] === 127 || bytes.slice(12).every(byte => byte === 0));
}

/**
 * Whether a credential may be sent to a loopback listener on `port`, given this user's uid and the
 * kernel's tables (`undefined` when the host publishes none).
 */
export function listenerOwnerVerdict(
  port: number,
  ownUid: number,
  tables: readonly string[] | undefined,
): ListenerOwnerVerdict {
  if (tables === undefined) return { kind: 'unknown' };
  const reachable = tables
    .flatMap(parseTcpListeners)
    .filter(listener => listener.port === port && listener.reachableFromLoopback);
  if (reachable.length === 0) return { kind: 'absent' };
  const foreign = [
    ...new Set(
      reachable.filter(listener => listener.uid !== ownUid && listener.uid !== ROOT_UID).map(listener => listener.uid),
    ),
  ];
  return foreign.length === 0 ? { kind: 'own' } : { kind: 'foreign', uids: foreign };
}

/** The port a loopback daemon URL names, defaulting the way `URL` does for its scheme. */
export function daemonUrlPort(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.port !== '') return Number(parsed.port);
    if (parsed.protocol === 'http:') return 80;
    if (parsed.protocol === 'https:') return 443;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The refusal, in the one sentence every caller gives: what was not sent, why, and what to do.
 * `undefined` means the credential may go.
 */
export function foreignListenerRefusal(
  url: string,
  credential: string,
  verdict: ListenerOwnerVerdict,
): string | undefined {
  if (verdict.kind !== 'foreign') return undefined;
  const owners = verdict.uids.map(String).join(', ');
  return `refusing to send ${credential} to ${url}: that port on this machine is held by another user (uid ${owners}), not by your daemon. Start your own daemon, or check FY_HOME and its config/daemon.json.`;
}
