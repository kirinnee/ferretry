import { isLoopbackHost } from './wire.ts';

/**
 * HOW TO DESCRIBE THE PATH TO A DAEMON, so no screen prints an address that means nothing to the reader.
 *
 * A daemon's own link carries the address it listens on, and that is very often `127.0.0.1:<port>`: "this computer
 * itself". On the machine that is true and readable. On a phone that reached the machine through the relay it is a
 * lie — it points back at the phone — and showing it next to a fingerprint made a relayed pairing look broken.
 * One rule, said once: a RELAYED daemon is named and described as "through the relay", never by an address; the
 * address is shown only when the path really is direct.
 */

/** The words the screens use, so they say the same thing everywhere. */
export const DAEMON_PATH_WORDS = {
  relay: 'through the relay',
  direct: 'direct',
  /** Stands in for a name nobody has told this device yet (a link carries no name; the pairing answer does). */
  unnamed: 'Your Ferretry machine',
} as const;

export type DaemonPathKind = 'relay' | 'direct';

export interface DaemonPathInput {
  /** The address the daemon was reached at, or its link carried: `http://127.0.0.1:7617`. */
  readonly address: string;
  /** The machine's name, once the daemon has said it. */
  readonly name?: string | undefined;
  /**
   * The path that actually carried the exchange, when it is known. Absent before pairing, or for a record that never
   * proved a direct path; the path is then judged from the address and where this page runs.
   */
  readonly via?: DaemonPathKind | undefined;
  /** Whether this page runs on the daemon's own machine (a loopback page). Default: it does not. */
  readonly sameMachine?: boolean | undefined;
}

export interface DaemonPath {
  readonly kind: DaemonPathKind;
  /** What to call the daemon: its name, or the address only when direct and unnamed. */
  readonly title: string;
  /** "through the relay" or "direct". */
  readonly path: string;
  /** The address to show, present ONLY when the path is direct. Never for a relayed daemon. */
  readonly address?: string;
  /** One line: `<title> · <path>`. */
  readonly summary: string;
}

const hostOf = (address: string): string => {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
};

const isLoopbackAddress = (address: string): boolean => {
  try {
    return isLoopbackHost(new URL(address).hostname);
  } catch {
    return false;
  }
};

/**
 * The kind of path, decided in one place. An exchange that was observed wins. Otherwise a loopback address seen from
 * another machine can only be reached through the relay (a direct dial would find that device itself), so that is
 * what it will be; everything else is dialled directly first.
 */
export function daemonPathKind(input: DaemonPathInput): DaemonPathKind {
  if (input.via !== undefined) return input.via;
  return isLoopbackAddress(input.address) && input.sameMachine !== true ? 'relay' : 'direct';
}

export function describeDaemonPath(input: DaemonPathInput): DaemonPath {
  const kind = daemonPathKind(input);
  const name = input.name?.trim() || undefined;
  const path = DAEMON_PATH_WORDS[kind];
  if (kind === 'relay') {
    const title = name ?? DAEMON_PATH_WORDS.unnamed;
    return { kind, title, path, summary: `${title} · ${path}` };
  }
  const address = hostOf(input.address);
  const title = name ?? address;
  return { kind, title, path, address, summary: `${title} · ${path}` };
}
