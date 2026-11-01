import type { StopSignal } from '../../lib/migrate/stop-jobs.ts';

/**
 * One signal to one pid, for `AgentJobStopper` — which chose the pid from this session's own pane tree and
 * re-read that tree a moment ago. A process already gone is `false`; any other refusal is a real fault and
 * throws, so a job the Warden could not signal is never reported as stopped.
 */
export function deliverStopSignal(pid: number, signal: StopSignal): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
