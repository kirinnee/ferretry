/**
 * PASSIVE LEARNING, PER FERRET: whether a ferret's fixed instructions tell it to file lessons.
 *
 * That is all the switch controls. Switching a running ferret re-instructs it with a queued message
 * that does not interrupt it — it costs that ferret one turn — and the daemon's own `note` says so,
 * which is why every switch here surfaces the note rather than a sentence of its own.
 */

import type { FerretLessons, FerretLessonsPatchResult } from '../../contract/index.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LessonsConnection } from './api.ts';
import { fetchFerretLessons, patchFerretLessons } from './api.ts';

/**
 * How often a list that shows the mark re-reads which ferrets learn, while the app is in view.
 *
 * The answer moves only when somebody switches a ferret: a switch made here is applied at once from its
 * own answer, so this read is for a switch made elsewhere (the CLI, another device) — which can wait a
 * few minutes to grow its mark. It is read on every machine the list shows, beside the records list
 * itself, so a quick beat here was a steady share of an idle page's traffic for an answer that almost
 * never changes.
 */
const PASSIVE_LESSONS_POLL_MS = 300_000;

export interface PassiveLessonsState {
  /** `null` until the first read answers — and for a daemon that cannot answer it. */
  readonly records: readonly FerretLessons[] | null;
  readonly passive: ReadonlySet<string>;
  readonly refresh: () => Promise<void>;
  /** Switches one ferret and returns what the daemon did; throws with its refusal. */
  readonly set: (ferretId: string, passive: boolean) => Promise<FerretLessonsPatchResult>;
}

const NOBODY: ReadonlySet<string> = new Set();

export function usePassiveLessons(
  connection: LessonsConnection,
  pollMs: number = PASSIVE_LESSONS_POLL_MS,
): PassiveLessonsState {
  const [records, setSessions] = useState<readonly FerretLessons[] | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchFerretLessons(connection);
      if (alive.current) setSessions(next);
    } catch {
      // A daemon without the route has no ferret lessons; the mark is simply absent.
    }
  }, [connection]);

  useEffect(() => {
    const tick = (): void => {
      if (document.visibilityState === 'visible') void refresh();
    };
    tick();
    const timer = setInterval(tick, pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  const set = useCallback(
    async (ferretId: string, passive: boolean) => {
      const result = await patchFerretLessons(connection, ferretId, passive);
      if (alive.current)
        setSessions(current => [...(current ?? []).filter(entry => entry.ferretId !== ferretId), result.lessons]);
      return result;
    },
    [connection],
  );

  const passive = useMemo(
    () => (records === null ? NOBODY : new Set(records.filter(entry => entry.passive).map(entry => entry.ferretId))),
    [records],
  );
  return { records, passive, refresh, set };
}
