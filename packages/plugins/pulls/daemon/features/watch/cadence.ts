import { WATCH_CADENCE_MS, type WatchedRepo } from '../../../contract/index.ts';

/** How long to wait before looking at a project again: 30 s with CI running, 60 s with a screen open, else 5 min. */
export function intervalFor(repos: readonly WatchedRepo[], viewed: boolean): number {
  const running = repos.some(repo => repo.pulls.some(pull => pull.ci === 'running' || pull.ci === 'queued'));
  if (running) return WATCH_CADENCE_MS.running;
  return viewed ? WATCH_CADENCE_MS.viewed : WATCH_CADENCE_MS.idle;
}

/** Whether some device read the status recently enough to count as having the PRs screen open. */
export const isViewed = (lastReadMs: number | undefined, nowMs: number): boolean =>
  lastReadMs !== undefined && nowMs - lastReadMs <= WATCH_CADENCE_MS.viewedWithinMs;
