/**
 * Reads the Warden status of several paired daemons at once, each answer kept under its own daemon id.
 * Same honesty and cadence as `useWardenPoll`: a failed read keeps the last good answer marked stale, an
 * answer that arrives after the set of daemons changed is discarded.
 */

import type { WardenStatusView } from '@ferretry/protocol';
import { useEffect, useState } from 'react';
import type { DaemonConnection, DaemonId } from '../lib/daemon-connection.ts';
import { nextStateOnFailure, type WardenPollOptions, type WardenReadState } from './use-warden-poll.ts';

const POLL_MS = 30_000;
const documentHidden = (): boolean => typeof document !== 'undefined' && document.hidden;

export function useWardenStatuses(
  daemons: readonly DaemonConnection[],
  read: (daemon: DaemonConnection) => Promise<WardenStatusView>,
  options: Omit<WardenPollOptions, 'revision'> = {},
): ReadonlyMap<DaemonId, WardenReadState<WardenStatusView>> {
  const { pollMs = POLL_MS, isHidden = documentHidden } = options;
  const [held, setHeld] = useState<ReadonlyMap<DaemonId, WardenReadState<WardenStatusView>>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const poll = async (daemon: DaemonConnection): Promise<void> => {
      if (isHidden()) return;
      try {
        const view = await read(daemon);
        if (!cancelled) setHeld(current => new Map(current).set(daemon.daemonId, { status: 'ready', view }));
      } catch (cause) {
        if (cancelled) return;
        const reason = cause instanceof Error ? cause.message : String(cause);
        setHeld(current =>
          new Map(current).set(
            daemon.daemonId,
            nextStateOnFailure(current.get(daemon.daemonId) ?? { status: 'loading' }, reason),
          ),
        );
      }
    };
    const pollAll = (): void => {
      for (const daemon of daemons) void poll(daemon);
    };
    pollAll();
    const timer = setInterval(pollAll, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [daemons, read, pollMs, isHidden]);

  return held;
}
