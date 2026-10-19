/**
 * PASSIVE LEARNING, PER FERRET: whether a ferret's fixed instructions tell it to file lessons.
 *
 * That is all the switch controls. Switching a running ferret re-instructs it with a queued message
 * that does not interrupt it — it costs that ferret one turn — and the daemon's own `note` says so,
 * which is why every switch here surfaces the note rather than a sentence of its own.
 */

import type { SessionLearning, SessionLearningPatchResult } from '@ferretry/protocol';
import { GraduationCap } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { fetchSessionLearning, patchSessionLearning } from '../../lib/learning-api.ts';
import type { DaemonFetch } from '../../lib/runtime-models.ts';

/** How often a list that shows the mark re-reads which ferrets learn. */
export const PASSIVE_LEARNING_POLL_MS = 30_000;

export interface PassiveLearningState {
  /** `null` until the first read answers — and for a daemon that cannot answer it. */
  readonly sessions: readonly SessionLearning[] | null;
  readonly passive: ReadonlySet<string>;
  readonly refresh: () => Promise<void>;
  /** Switches one ferret and returns what the daemon did; throws with its refusal. */
  readonly set: (sessionId: string, passive: boolean) => Promise<SessionLearningPatchResult>;
}

const NOBODY: ReadonlySet<string> = new Set();

export function usePassiveLearning(
  connection: DaemonConnection,
  fetcher: DaemonFetch,
  pollMs: number = PASSIVE_LEARNING_POLL_MS,
): PassiveLearningState {
  const [sessions, setSessions] = useState<readonly SessionLearning[] | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchSessionLearning(connection, fetcher);
      if (alive.current) setSessions(next);
    } catch {
      // A daemon without the route has no ferret learning; the mark is simply absent.
    }
  }, [connection, fetcher]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  const set = useCallback(
    async (sessionId: string, passive: boolean) => {
      const result = await patchSessionLearning(connection, sessionId, passive, fetcher);
      if (alive.current)
        setSessions(current => [...(current ?? []).filter(entry => entry.sessionId !== sessionId), result.learning]);
      return result;
    },
    [connection, fetcher],
  );

  const passive = useMemo(
    () => (sessions === null ? NOBODY : new Set(sessions.filter(entry => entry.passive).map(entry => entry.sessionId))),
    [sessions],
  );
  return { sessions, passive, refresh, set };
}

/** What the mark says in words: its accessible name, and the tooltip a pointer reads. */
export const PASSIVE_LEARNING_LABEL = 'Learning: passive — instructed to file lessons with fy lesson suggest';

/**
 * The mark a ferret's list row carries while it is instructed to learn: the graduation cap alone, since
 * a row has room for one small mark and the words ("Learning: passive") were wider than the ferret's
 * name. The full state is the mark's accessible name and its tooltip. It is not a control: a tap on it
 * is a tap on the row, which opens the session.
 */
export function PassiveLearningMark() {
  return (
    <span
      aria-label={PASSIVE_LEARNING_LABEL}
      className="inline-flex shrink-0 items-center text-accent"
      data-learning-passive=""
      role="img"
      title={PASSIVE_LEARNING_LABEL}
    >
      <GraduationCap aria-hidden="true" size={14} />
    </span>
  );
}
