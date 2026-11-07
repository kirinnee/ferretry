/**
 * THIS MACHINE'S ARCHIVED FINISHED SESSIONS, as the sessions bar's footer reads them
 * (docs/session-archive.md): how many there are, on a quiet beat, and the rows themselves only when
 * the reader presses "Show".
 *
 * TWO READS, TWO CADENCES. The count is one number (`limit=0`) asked on mount and at most every
 * {@link ARCHIVED_COUNT_POLL_MS} — slower than the list's own beat, because the daemon archives hourly and the idle request budget is held in CI (`idle-request-budget.test.tsx`: a minute-beat
 * cost the fleet page 1.0 of its 4 requests a minute), so a count that lags ten minutes
 * hurts nobody — and never while the tab is hidden, with one read owed when it is shown again. The
 * rows are the reader's OWN act: one `limit=100` read per "Show", never a poll. Pressing Show again
 * after a Hide re-reads only when the count has moved since the rows were loaded, so the list never
 * grows stale behind a number that changed.
 *
 * A DAEMON FROM BEFORE THE ROUTE is not an error. `404`/`405` means "not served"
 * (`background-fresh.ts` reads the same statuses the same way), so the beat stops asking and the
 * count stays unread — the footer is simply absent, and a reader on an older machine is never shown a
 * promise their daemon cannot keep. A transient fault keeps the last count; the next beat asks again.
 *
 * Keyed on the machine, not the connection object: a daemon that republishes its carriers hands the
 * app a new object for the same machine, which must not restart the beat — the reads go through
 * whichever object is current when they fire (`latest.current`), the state discards an answer that
 * arrives after a switch, and a switch of machine starts from unread.
 */

import type { IFyApiClient } from '@ferretry/app';
import type { SessionView } from '../../contract/index.ts';
import { FyHttpError } from '@ferretry/app';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonConnection, DaemonId } from '../lib/daemon-connection.ts';
import type { SessionsBarArchived } from '../shell/sessions-bar-archived.tsx';

/** What the hook reads: the one protocol method it needs, so a suite doubles nothing else. */
export type ArchivedSessionsClient = Pick<IFyApiClient, 'archivedSessions'>;

/** The count's beat: at most this often, and never while the tab is hidden. */
export const ARCHIVED_COUNT_POLL_MS = 10 * 60_000;

/** How many archived rows one "Show" lists: the newest, as the route's own default caps it. */
export const ARCHIVED_SESSIONS_LIMIT = 100;

/** The browser seams the beat needs, injectable so a suite drives both timers and visibility. */
export interface ArchivedSessionsEnvironment {
  readonly visible: () => boolean;
  readonly setInterval: (callback: () => void, milliseconds: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  readonly onVisibility: (listener: () => void) => () => void;
}

export const browserArchivedSessionsEnvironment: ArchivedSessionsEnvironment = {
  visible: () => document.visibilityState !== 'hidden',
  setInterval: (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
  clearInterval: handle => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
  onVisibility: listener => {
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
};

interface Held {
  readonly daemonId: DaemonId;
  readonly count: number | null;
  readonly sessions: readonly SessionView[] | null;
  readonly shown: boolean;
  readonly loading: boolean;
}

const unread = (daemonId: DaemonId): Held => ({ daemonId, count: null, sessions: null, shown: false, loading: false });

export function useArchivedSessions(
  daemon: DaemonConnection,
  clientFor: (daemon: DaemonConnection) => Promise<ArchivedSessionsClient>,
  environment: ArchivedSessionsEnvironment = browserArchivedSessionsEnvironment,
): SessionsBarArchived {
  const [held, setHeld] = useState<Held>(unread(daemon.daemonId));
  const latest = useRef(daemon);
  latest.current = daemon;
  const actions = useRef<Pick<SessionsBarArchived, 'onShow' | 'onHide'>>({
    onShow: () => undefined,
    onHide: () => undefined,
  });
  const onShow = useCallback(() => actions.current.onShow(), []);
  const onHide = useCallback(() => actions.current.onHide(), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the machine's identity is the deliberate key
  useEffect(() => {
    const { daemonId } = daemon;
    let cancelled = false;
    /** False once a 404/405 said this daemon does not serve the route. */
    let served = true;
    /** The count as this beat last learned it, and the count the loaded rows answered. */
    let known: number | null = null;
    let loadedFor: number | null = null;
    setHeld(current => (current.daemonId === daemonId ? current : unread(daemonId)));

    const publish = (patch: Partial<Omit<Held, 'daemonId'>>): void => {
      setHeld(current => (current.daemonId === daemonId ? { ...current, ...patch } : current));
    };

    const readCount = async (): Promise<void> => {
      if (cancelled || !served || !environment.visible()) return;
      try {
        const client = await clientFor(latest.current);
        const count = (await client.archivedSessions(0)).count;
        if (cancelled) return;
        known = count;
        publish({ count });
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof FyHttpError && (cause.status === 404 || cause.status === 405)) served = false;
      }
    };

    const loadRows = async (): Promise<void> => {
      if (cancelled) return;
      publish({ loading: true });
      try {
        const client = await clientFor(latest.current);
        const answer = await client.archivedSessions(ARCHIVED_SESSIONS_LIMIT);
        if (cancelled) return;
        known = answer.count;
        loadedFor = answer.count;
        publish({ count: answer.count, sessions: answer.sessions, loading: false });
      } catch {
        if (!cancelled) publish({ loading: false });
      }
    };

    actions.current = {
      onShow: () => {
        // A daemon that does not serve the route has no rows to list; the footer never offered the press.
        if (cancelled || !served) return;
        publish({ shown: true });
        if (loadedFor === null || loadedFor !== known) void loadRows();
      },
      onHide: () => {
        if (!cancelled) publish({ shown: false });
      },
    };

    void readCount();
    const timer = environment.setInterval(() => void readCount(), ARCHIVED_COUNT_POLL_MS);
    const release = environment.onVisibility(() => void readCount());
    return () => {
      cancelled = true;
      environment.clearInterval(timer);
      release();
    };
  }, [daemon.daemonId, clientFor, environment]);

  return held.daemonId === daemon.daemonId
    ? { ...held, onShow, onHide }
    : { ...unread(daemon.daemonId), onShow, onHide };
}
