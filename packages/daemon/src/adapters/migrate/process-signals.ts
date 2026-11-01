import type { StopSignal } from '../../lib/migrate/stop-jobs.ts';

/**
 * One signal to one pid, for `AgentJobStopper` — which chose the pid from this session's own pane tree and
 * re-read that tree a moment ago. Answers whether the signal was delivered. A process already gone, or one this
 * daemon may not signal, is `false`: the stopper never trusts this answer about what stopped, it reads the tree
 * again, so a job that could not be signalled is still there and is reported as a survivor.
 */
export function deliverStopSignal(pid: number, signal: StopSignal): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}
