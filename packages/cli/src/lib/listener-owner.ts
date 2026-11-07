/**
 * WHOSE PROGRAM IS LISTENING on the loopback port a credential is about to be sent to (S57).
 *
 * On a shared host any local account can bind a free loopback port, and a stopped daemon leaves its port free. The
 * kernel's table (`/proc/net/tcp*`) names the uid that opened every socket, so a credential goes to a loopback
 * listener only when every listener a loopback connection could reach belongs to this user, or to root. Pure: the
 * tables are passed in.
 *
 * GAP: macOS publishes no such table, so the verdict is `unknown` and the credential is sent as before.
 */
import { DAEMON_RUN_FILE } from '@ferretry/kernel/contract';

export const PROC_TCP_TABLES = ['/proc/net/tcp', '/proc/net/tcp6'] as const;

export interface TcpListener {
  readonly port: number;
  readonly reachableFromLoopback: boolean;
  readonly uid: number;
}

const LISTEN_STATE = '0A';

function decimal(field: string | undefined): field is string {
  return field !== undefined && /^\d+$/u.test(field);
}

function networkOrderBytes(hex: string): readonly number[] {
  const bytes: number[] = [];
  for (let word = 0; word < hex.length; word += 8) {
    const chunk = hex.slice(word, word + 8);
    for (let index = 6; index >= 0; index -= 2) bytes.push(Number.parseInt(chunk.slice(index, index + 2), 16));
  }
  return bytes;
}

function reachableFromLoopback(bytes: readonly number[]): boolean {
  if (bytes.every(byte => byte === 0)) return true;
  if (bytes.length === 4) return bytes[0] === 127;
  const prefix = bytes.slice(0, 15);
  if (prefix.every(byte => byte === 0) && bytes[15] === 1) return true;
  const mapped = bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  return mapped && (bytes[12] === 127 || bytes.slice(12).every(byte => byte === 0));
}

/** The listening sockets of one `/proc/net/tcp` or `tcp6` text. A line without the table's shape is skipped. */
export function parseTcpListeners(table: string): readonly TcpListener[] {
  const listeners: TcpListener[] = [];
  for (const line of table.split('\n').slice(1)) {
    const [, local, , state, , , , uid, , inode] = line.trim().split(/\s+/u);
    if (local === undefined || state !== LISTEN_STATE || !decimal(uid) || !decimal(inode)) continue;
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

export type ListenerOwnerVerdict =
  | { readonly kind: 'own' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'foreign'; readonly uids: readonly number[] }
  | { readonly kind: 'unknown' };

const ROOT_UID = 0;

export function listenerOwnerVerdict(
  port: number,
  ownUid: number,
  tables: readonly string[] | undefined,
): ListenerOwnerVerdict {
  if (tables === undefined) return { kind: 'unknown' };
  const reachable = tables.flatMap(parseTcpListeners).filter(l => l.port === port && l.reachableFromLoopback);
  if (reachable.length === 0) return { kind: 'absent' };
  const foreign = [...new Set(reachable.filter(l => l.uid !== ownUid && l.uid !== ROOT_UID).map(l => l.uid))];
  return foreign.length === 0 ? { kind: 'own' } : { kind: 'foreign', uids: foreign };
}

/** The port a daemon URL names, defaulting the way `URL` does for its scheme. */
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

/** The one refusal sentence; `undefined` means the credential may go. */
export function foreignListenerRefusal(
  url: string,
  credential: string,
  verdict: ListenerOwnerVerdict,
): string | undefined {
  if (verdict.kind !== 'foreign') return undefined;
  return `refusing to send ${credential} to ${url}: that port on this machine is held by another user (uid ${verdict.uids.map(String).join(', ')}), not by your daemon. Start your own daemon, or check FY_HOME and its ${DAEMON_RUN_FILE}.`;
}
