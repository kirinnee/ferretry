/**
 * Polls one paired daemon's warden status.
 *
 * Ported from the effect inside kteam `ui/src/components/WardenStrip.tsx`, with
 * the single-daemon assumption removed. kteam polled an ambient `api` singleton
 * and kept the last successful status in component state; with several paired
 * daemons that state is a cache that outlives its daemon, and a reader who
 * switches connection would be shown the previous daemon's sweep as though it
 * were this one's. Two rules fix it, and both are tested:
 *
 *   1. The state is keyed by `daemonId`. Changing daemon resets to `null`
 *      (unknown), never to the other daemon's last known good value.
 *   2. Every in-flight read remembers which daemon asked. A response that
 *      arrives after a switch is DISCARDED, not applied.
 *
 * Kept from the original: the 30s cadence, the skip while the tab is hidden
 * (the perf budget), and self-hiding rather than erroring on a daemon too old
 * to serve the route — a failed first read leaves the status `null` and the
 * strip renders nothing.
 */

import { useEffect, useState } from 'react';
import type { WardenStatusView } from '@ferretry/protocol';
import type { DaemonConnection, DaemonId } from '../lib/daemon-connection.ts';

export const WARDEN_POLL_MS = 30_000;

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
  const { pollMs = WARDEN_POLL_MS, isHidden = documentHidden } = options;
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
        // Deliberately silent: an absent route on an older daemon is not an
        // error the reader can act on, and the strip self-hides.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [daemon, read, pollMs, isHidden]);

  return held.daemonId === daemon.daemonId ? held.status : null;
}
