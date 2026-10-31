/**
 * THE KERNEL'S LISTENING SOCKETS, read from `/proc/net/tcp` and `/proc/net/tcp6`.
 *
 * On a host several people share, a loopback port is not "my program" — it is whichever process bound
 * it, and any local account can bind a free loopback port. Nothing in TCP can tell the two apart, but the
 * kernel's table names the uid that opened every socket, and the socket's inode, which the owning process
 * holds as a `socket:[<inode>]` link under `/proc/<pid>/fd`.
 *
 * ONE PARSER, two judges: the CLI asks whose daemon a credential is about to be sent to
 * (`packages/cli/src/lib/daemon/listener-owner.ts`), and the daemon asks whether the browser it just
 * spawned is the program that took its port (`packages/daemon/src/lib/browser/control/listener-proof.ts`).
 * The text is passed in, so this is tested on fixture text rather than on a real port.
 */

/** Where Linux publishes its TCP socket tables; a host with neither (macOS) publishes none. */
export const PROC_TCP_TABLES = ['/proc/net/tcp', '/proc/net/tcp6'] as const;

/** One listening socket, as the kernel's table records it. */
export interface TcpListener {
  readonly port: number;
  /** Whether a connection to a loopback address can land on it: bound to loopback or to the wildcard. */
  readonly reachableFromLoopback: boolean;
  readonly uid: number;
  /** The socket's inode: the process holding it has a `socket:[<inode>]` link in `/proc/<pid>/fd`. */
  readonly inode: number;
}

/** `0A` is TCP_LISTEN in the kernel's state numbering. */
const LISTEN_STATE = '0A';

/**
 * Parses `/proc/net/tcp` or `/proc/net/tcp6` text into its listening sockets.
 *
 * The local address is `<hex address>:<hex port>`. The address is the raw `in_addr` (or `in6_addr`)
 * printed as 32-bit words in host byte order, so on every little-endian host `127.0.0.1` reads
 * `0100007F`; each word is reversed back into network order before it is judged. The uid is the eighth
 * column and the inode the tenth. A line that does not have the table's shape is skipped, never guessed at.
 */
export function parseTcpListeners(table: string): readonly TcpListener[] {
  const listeners: TcpListener[] = [];
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/u);
    const [, local, , state, , , , uid, , inode] = fields;
    if (local === undefined || state !== LISTEN_STATE || !decimal(uid) || !decimal(inode)) continue;
    const match = /^([0-9A-Fa-f]{8}|[0-9A-Fa-f]{32}):([0-9A-Fa-f]{4})$/u.exec(local);
    if (match === null) continue;
    const [, address = '', port = ''] = match;
    listeners.push({
      port: Number.parseInt(port, 16),
      reachableFromLoopback: reachableFromLoopback(networkOrderBytes(address)),
      uid: Number(uid),
      inode: Number(inode),
    });
  }
  return listeners;
}

function decimal(field: string | undefined): field is string {
  return field !== undefined && /^\d+$/u.test(field);
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

/** Every listener a loopback connection to `port` could land on, across the tables given. */
export function loopbackListenersOn(port: number, tables: readonly string[]): readonly TcpListener[] {
  return tables.flatMap(parseTcpListeners).filter(listener => listener.port === port && listener.reachableFromLoopback);
}
