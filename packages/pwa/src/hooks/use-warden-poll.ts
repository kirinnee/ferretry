/**
 * Polls one paired daemon for a Warden read — the status, or the "who needs you" feed — and says
 * honestly what it knows.
 *
 * `useWardenStatus` answers `null` for both "not read yet" and "could not read", which suits a strip
 * that hides itself. The Warden PAGE cannot: a failed read there must be said out loud, and a failed
 * refresh after a good one must keep that answer while marking it stale, never turn it into an
 * all-clear. So this hook keeps four states, and the same two keying rules as the status hook:
 *
 *   1. The state is keyed by `daemonId`. Changing daemon starts again from `loading`, never from the
 *      other daemon's last answer.
 *   2. An answer that arrives after a switch or an unmount is discarded.
 *
 * Kept: the 30 s cadence and the skip while the tab is hidden. Added: `revision`, which reads again at
 * once — after a sweep the owner asked for — and restarts the cadence from that read.
 */

import { useEffect, useState } from 'react';
import type { DaemonConnection, DaemonId } from '../lib/daemon-connection.ts';
import { WARDEN_POLL_MS } from './use-warden-status.ts';

export type WardenReadState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly reason: string }
  | { readonly status: 'stale'; readonly view: T; readonly reason: string }
  | { readonly status: 'ready'; readonly view: T };

/** A transient fault keeps a useful answer, but marks it untrustworthy. */
export const nextStateOnFailure = <T>(state: WardenReadState<T>, reason: string): WardenReadState<T> =>
  state.status === 'ready' || state.status === 'stale'
    ? { status: 'stale', view: state.view, reason }
    : { status: 'error', reason };

/** The answer, when there is one to show: fresh or stale. */
export const readView = <T>(state: WardenReadState<T>): T | undefined =>
  state.status === 'ready' || state.status === 'stale' ? state.view : undefined;

export interface WardenPollOptions {
  readonly pollMs?: number;
  /** Defaults to the document's own visibility; injected for tests. */
  readonly isHidden?: () => boolean;
  /** Bump to read again now. */
  readonly revision?: number;
}

const documentHidden = (): boolean => typeof document !== 'undefined' && document.hidden;

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

interface Held<T> {
  readonly daemonId: DaemonId;
  readonly state: WardenReadState<T>;
}

/** The caller must keep `read` stable (`useCallback`): a new reader restarts the poll. */
export function useWardenPoll<T>(
  daemon: DaemonConnection,
  read: (daemon: DaemonConnection) => Promise<T>,
  options: WardenPollOptions = {},
): WardenReadState<T> {
  const { pollMs = WARDEN_POLL_MS, isHidden = documentHidden, revision = 0 } = options;
  const [held, setHeld] = useState<Held<T>>({ daemonId: daemon.daemonId, state: { status: 'loading' } });

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the deliberate "read again now" trigger
  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      if (isHidden()) return;
      try {
        const view = await read(daemon);
        if (!cancelled) setHeld({ daemonId: daemon.daemonId, state: { status: 'ready', view } });
      } catch (cause) {
        if (cancelled) return;
        setHeld(current => ({
          daemonId: daemon.daemonId,
          state: nextStateOnFailure(
            current.daemonId === daemon.daemonId ? current.state : { status: 'loading' },
            reasonOf(cause),
          ),
        }));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [daemon, read, pollMs, isHidden, revision]);

  return held.daemonId === daemon.daemonId ? held.state : { status: 'loading' };
}
