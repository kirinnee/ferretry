/**
 * The newest scan on one daemon, kept fresh while somebody is looking.
 *
 * One read on mount, then one every `pollMs` ONLY while that scan is running — a finished scan is not
 * polled, and nothing is read once the hub (or dialog) holding this unmounts. Starting and cancelling
 * go through here so the hub's inline bar and the dialog's progress are the same fact.
 */

import type { LessonsScanProgress, LessonsScanRequest } from '../../contract/index.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LessonsConnection } from './api.ts';
import { cancelLessonsScan, fetchLessonsScan, startLessonsScan } from './api.ts';

const SCAN_POLL_MS = 2_000;

export interface LessonsScanControl {
  readonly scan: LessonsScanProgress | null;
  /** Starts a scan; throws with the daemon's refusal (`409 scan_running` included). */
  readonly start: (request: LessonsScanRequest) => Promise<LessonsScanProgress>;
  readonly cancel: () => Promise<void>;
}

export function useLessonsScan(connection: LessonsConnection, pollMs: number = SCAN_POLL_MS): LessonsScanControl {
  const [scan, setScan] = useState<LessonsScanProgress | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    try {
      const view = await fetchLessonsScan(connection);
      if (alive.current) setScan(view.scan ?? null);
    } catch {
      // A daemon that cannot say keeps the last answer; the hub's own reads report the failure.
    }
  }, [connection]);

  useEffect(() => {
    void read();
  }, [read]);

  // Every answer is a new object, so each read arms exactly one next read while the scan runs.
  useEffect(() => {
    if (scan?.state !== 'running') return;
    const timer = setTimeout(() => void read(), pollMs);
    return () => clearTimeout(timer);
  }, [scan, read, pollMs]);

  const start = useCallback(
    async (request: LessonsScanRequest) => {
      const progress = await startLessonsScan(connection, request);
      if (alive.current) setScan(progress);
      return progress;
    },
    [connection],
  );

  const cancel = useCallback(async () => {
    const progress = await cancelLessonsScan(connection);
    if (alive.current) setScan(progress);
  }, [connection]);

  return { scan, start, cancel };
}
