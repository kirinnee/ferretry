/**
 * The newest scan on one daemon, kept fresh while somebody is looking.
 *
 * One read on mount, then one every `pollMs` ONLY while that scan is running — a finished scan is not
 * polled, and nothing is read once the hub (or dialog) holding this unmounts. Starting and cancelling
 * go through here so the hub's inline bar and the dialog's progress are the same fact.
 */

import type { LearningScanProgress, LearningScanRequest } from '@ferretry/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { cancelLearningScan, fetchLearningScan, startLearningScan } from '../../lib/learning-api.ts';
import type { DaemonFetch } from '../../lib/runtime-models.ts';

export const SCAN_POLL_MS = 2_000;

export interface LearningScanControl {
  readonly scan: LearningScanProgress | null;
  /** Starts a scan; throws with the daemon's refusal (`409 scan_running` included). */
  readonly start: (request: LearningScanRequest) => Promise<LearningScanProgress>;
  readonly cancel: () => Promise<void>;
}

export function useLearningScan(
  connection: DaemonConnection,
  fetcher: DaemonFetch,
  pollMs: number = SCAN_POLL_MS,
): LearningScanControl {
  const [scan, setScan] = useState<LearningScanProgress | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    try {
      const view = await fetchLearningScan(connection, fetcher);
      if (alive.current) setScan(view.scan ?? null);
    } catch {
      // A daemon that cannot say keeps the last answer; the hub's own reads report the failure.
    }
  }, [connection, fetcher]);

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
    async (request: LearningScanRequest) => {
      const progress = await startLearningScan(connection, request, fetcher);
      if (alive.current) setScan(progress);
      return progress;
    },
    [connection, fetcher],
  );

  const cancel = useCallback(async () => {
    const progress = await cancelLearningScan(connection, fetcher);
    if (alive.current) setScan(progress);
  }, [connection, fetcher]);

  return { scan, start, cancel };
}
