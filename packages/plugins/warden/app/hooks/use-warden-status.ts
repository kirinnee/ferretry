/**
 * Polls one paired daemon's warden status.
 *
 * The state is keyed by `daemonId`, with two rules, both tested:
 *
 *   1. Changing daemon resets to `null` (unknown), never to the other daemon's last known good value: with several
 *      paired daemons a cache that outlives its daemon would show the previous daemon's sweep as this one's.
 *   2. Every in-flight read remembers which daemon asked. A response that arrives after a switch is DISCARDED, not
 *      applied.
 *
 * It skips a read while the tab is hidden (the perf budget) and hides rather than errors: a failed first read leaves
 * the status `null` and the strip renders nothing.
 */

import { useEffect, useState } from 'react';
import type { WardenStatusView } from '../wire.ts';
import { type DaemonConnection, type DaemonId, shellClock } from '../shell.ts';

/**
 * A sweep result changes on the warden's own schedule, minutes apart, and its configuration arrives on
 * the config stream; a minute between reads keeps an idle page quiet.
 */
const WARDEN_POLL_MS = 60_000;

/**
 * Reads one daemon's warden status. The caller owns the transport — and must
 * keep the function identity stable (`useCallback`), because a new reader
 * restarts the poll.
 */
export type WardenStatusReader = (daemon: DaemonConnection) => Promise<WardenStatusView>;

export interface WardenStatusOptions {
  readonly pollMs?: number;
  /** Defaults to the document's own visibility; injected for tests. */
  readonly isHidden?: () => boolean;
  /** Runs a callback every `ms` until cancelled; the shell's clock unless a test drives it by hand. */
  readonly every?: (run: () => void, ms: number) => () => void;
}

interface Held {
  readonly daemonId: DaemonId;
  readonly status: WardenStatusView | null;
}

const documentHidden = (): boolean => typeof document !== 'undefined' && document.hidden;

export function useWardenStatus(
  daemon: DaemonConnection,
  read: WardenStatusReader,
  options: WardenStatusOptions = {},
): WardenStatusView | null {
  const { pollMs = WARDEN_POLL_MS, isHidden = documentHidden, every = shellClock.every } = options;
  const [held, setHeld] = useState<Held>({ daemonId: daemon.daemonId, status: null });

  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      if (isHidden()) return;
      try {
        const status = await read(daemon);
        // `cancelled` covers unmount; the daemon comparison covers the reader
        // switching connection while this request was still in flight.
        if (!cancelled) setHeld({ daemonId: daemon.daemonId, status });
      } catch {
        // Deliberately silent: a failed read is not an error the reader can act on, and the strip self-hides.
      }
    };
    void poll();
    const stop = every(() => void poll(), pollMs);
    return () => {
      cancelled = true;
      stop();
    };
  }, [daemon, read, pollMs, isHidden, every]);

  return held.daemonId === daemon.daemonId ? held.status : null;
}
