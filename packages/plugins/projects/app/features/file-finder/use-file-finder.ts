/**
 * ONE PROJECT'S FILE SEARCH, READ AS THE PERSON TYPES.
 *
 * Three readings, never two: nothing read yet, a failed read (the last good answer kept on screen beside the daemon's
 * sentence, so a hiccup does not blank the list), and an answer. A read is abandoned when the text moves on, and a typed
 * burst is one read: the daemon searches in memory, but a phone over a relay pays a round trip per keystroke.
 *
 * STALE-WHILE-REVALIDATE IS THE DAEMON'S, AND THIS FOLLOWS IT. An answer carries `rebuilding: true` while a newer index is
 * being built; the page keeps showing the old one and asks the (cheap) status route until the build is over, then reads
 * again. The same is true after Rescan, which only starts a build.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ProjectFilesAnswer } from '../../../contract/index.ts';
import { type ProjectsClient, reasonOf } from '../../lib/client.ts';
import { filesStatus, findFiles, rescanFiles } from './finder-api.ts';
import { searchText } from './finder-model.ts';

/** Wait for a typed burst to stop before asking; the first read of a mount is immediate. */
const FINDER_DEBOUNCE_MS = 150;
/** How often a running build is asked about. */
const FINDER_POLL_MS = 1_500;

export interface FileFinderState {
  /** The last good answer, whatever it was for: it stays while a newer one is read. */
  readonly answer: ProjectFilesAnswer | null;
  /** The search text `answer` is for. */
  readonly answeredFor: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  /** A build is running, started by this page or noticed on an answer. */
  readonly rebuilding: boolean;
  readonly rescan: () => void;
}

export interface FileFinderTimings {
  readonly debounceMs?: number;
  readonly pollMs?: number;
}

export function useFileFinder(
  client: ProjectsClient,
  projectId: string,
  rawQuery: string,
  timings: FileFinderTimings = {},
): FileFinderState {
  const debounceMs = timings.debounceMs ?? FINDER_DEBOUNCE_MS;
  const pollMs = timings.pollMs ?? FINDER_POLL_MS;
  const query = searchText(rawQuery);
  const [answer, setAnswer] = useState<ProjectFilesAnswer | null>(null);
  const [answeredFor, setAnsweredFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [tick, setTick] = useState(0);
  const [first, setFirst] = useState(true);

  // A different project is a different list: nothing of the last one is kept.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `projectId` is the trigger; the body only resets
  useEffect(() => {
    setAnswer(null);
    setAnsweredFor(null);
    setError(null);
    setRescanning(false);
    setFirst(true);
  }, [projectId, client]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the re-read trigger; the read itself does not use it
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    const timer = setTimeout(
      () => {
        void findFiles(client, projectId, query, undefined, abort.signal)
          .then(read => {
            if (abort.signal.aborted) return;
            setAnswer(read);
            setAnsweredFor(query);
            setError(null);
            setLoading(false);
            setFirst(false);
          })
          .catch((cause: unknown) => {
            if (abort.signal.aborted) return;
            setError(reasonOf(cause));
            setLoading(false);
            setFirst(false);
          });
      },
      first ? 0 : debounceMs,
    );
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [client, projectId, query, tick, debounceMs, first]);

  const rebuilding = rescanning || answer?.rebuilding === true;
  useEffect(() => {
    if (!rebuilding) return;
    const abort = new AbortController();
    const timer = setInterval(() => {
      void filesStatus(client, projectId, abort.signal)
        .then(status => {
          if (abort.signal.aborted || status.rebuilding) return;
          setRescanning(false);
          setTick(value => value + 1);
        })
        .catch(() => {
          // A failed look at a running build is tried again on the next beat; the read that follows says why if it matters.
        });
    }, pollMs);
    return () => {
      clearInterval(timer);
      abort.abort();
    };
  }, [rebuilding, client, projectId, pollMs]);

  const rescan = useCallback(() => {
    setRescanning(true);
    void rescanFiles(client, projectId)
      .then(status => {
        if (status.rebuilding) return;
        setRescanning(false);
        setTick(value => value + 1);
      })
      .catch((cause: unknown) => {
        setRescanning(false);
        setError(reasonOf(cause));
      });
  }, [client, projectId]);

  return { answer, answeredFor, loading, error, rebuilding, rescan };
}
