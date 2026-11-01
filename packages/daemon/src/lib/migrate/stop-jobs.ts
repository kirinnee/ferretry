/**
 * Stopping the background jobs a ferret started itself — what the Warden does to clear a move's way when the
 * owner set `autoMigrate.forceStopBackground`, and nothing else ever calls.
 *
 * WHICH PROCESSES, AND ONLY THOSE. A job is what `identifyAgentJobs` traced to the agent's own tool shell — a
 * `<shell> -c …` child of the harness CLI in THIS session's pane — and everything below that shell. The process
 * tree is read from the session's own tmux pane on the daemon's private socket, so a process of another session,
 * of the owner's terminal or of the system is never in it. The harness CLI itself, the pane's shell and any
 * process the harness owns are not jobs and are never signalled.
 *
 * NEVER A STALE PID. The tree is read again immediately before every signal, and a pid is signalled only while
 * it is still in this pane's tree as the same process: the same command, a tool shell of the same job, and
 * started no later than when it was first seen. A pid the kernel reused for a new process started after the
 * first look, so it has run for less time than the process it replaced and is refused.
 *
 * CHILDREN FIRST. A shell killed before its children leaves them re-parented to init — out of the pane's tree,
 * where nothing could find them again — so the deepest processes are signalled first. SIGTERM first, then, after
 * a grace period, SIGKILL for whatever is still the same process. What survives even that is reported, and the
 * Warden does not move the ferret.
 */

import { type AgentJob, blockingAgentJobs } from './agent-jobs.ts';
import type { InflightReport, ProcessInfo } from './inflight-report.ts';
import { verdictBlocksMigration } from './verdict.ts';

export type StopSignal = 'SIGTERM' | 'SIGKILL';

export interface AgentJobStopPorts {
  /** This session's in-flight report, read fresh: its process tree is the pane's own. */
  inspect(): Promise<InflightReport>;
  /** Deliver one signal to one pid. Answers whether it was delivered; a process already gone is `false`. */
  signal(pid: number, signal: StopSignal): boolean;
  sleep(ms: number): Promise<void>;
}

export interface StoppedJobs {
  readonly stopped: readonly AgentJob[];
  readonly survivors: readonly AgentJob[];
}

/** How long a job has to exit after SIGTERM, how often it is looked at, and how long SIGKILL gets. */
export const STOP_GRACE_MS = 5_000;
export const STOP_POLL_MS = 500;
export const KILL_GRACE_MS = 1_000;

/** `ps` reports whole seconds: a process looked at twice can read one second "younger" the second time. */
const ELAPSED_TOLERANCE_SECONDS = 1;

/**
 * Every process of the jobs that block the move: each blocking job's tool shell and everything below it, the
 * deepest first. The report lists parents before children, so the reverse is children before parents.
 */
export function jobProcesses(report: InflightReport): readonly ProcessInfo[] {
  const shells = new Set(
    report.processes.flatMap(process =>
      process.toolShell !== undefined && verdictBlocksMigration(process.verdict) ? [process.toolShell] : [],
    ),
  );
  return report.processes
    .filter(process => process.toolShell !== undefined && shells.has(process.toolShell))
    .toReversed();
}

/** Whether `now` is still the process `seen` was, by the rules in this module's header. */
export function sameProcess(seen: ProcessInfo, now: ProcessInfo): boolean {
  if (seen.pid !== now.pid || seen.argv !== now.argv || seen.toolShell !== now.toolShell) return false;
  if (seen.startedSecondsAgo === undefined || now.startedSecondsAgo === undefined) return false;
  return now.startedSecondsAgo + ELAPSED_TOLERANCE_SECONDS >= seen.startedSecondsAgo;
}

/** The processes of `targets` that are still themselves in `report`. */
function stillRunning(targets: readonly ProcessInfo[], report: InflightReport): readonly ProcessInfo[] {
  const byPid = new Map(report.processes.map(process => [process.pid, process]));
  return targets.filter(target => {
    const now = byPid.get(target.pid);
    return now !== undefined && sameProcess(target, now);
  });
}

export class AgentJobStopper {
  constructor(private readonly ports: AgentJobStopPorts) {}

  async stop(): Promise<StoppedJobs> {
    const first = await this.ports.inspect();
    const jobs = blockingAgentJobs(first);
    const targets = jobProcesses(first);
    if (targets.length === 0) return { stopped: [], survivors: [] };

    let left = await this.signalAll(targets, 'SIGTERM');
    for (let waited = 0; left.length > 0 && waited < STOP_GRACE_MS; waited += STOP_POLL_MS) {
      await this.ports.sleep(STOP_POLL_MS);
      left = stillRunning(left, await this.ports.inspect());
    }
    if (left.length > 0) {
      left = await this.signalAll(left, 'SIGKILL');
      if (left.length > 0) {
        await this.ports.sleep(KILL_GRACE_MS);
        left = stillRunning(left, await this.ports.inspect());
      }
    }
    // A job survives when anything of it — its shell or what the shell started — is still itself.
    const surviving = new Set(left.map(process => process.toolShell));
    const shellOf = new Map(first.processes.map(process => [process.pid, process.toolShell]));
    const survived = (job: AgentJob): boolean => surviving.has(shellOf.get(job.pid));
    return { stopped: jobs.filter(job => !survived(job)), survivors: jobs.filter(survived) };
  }

  /**
   * Signal each target that is still itself RIGHT NOW, deepest first, reading the tree again first. Answers the
   * ones still running after delivery was attempted — a target that was gone before its signal is done with.
   */
  private async signalAll(targets: readonly ProcessInfo[], signal: StopSignal): Promise<readonly ProcessInfo[]> {
    const current = stillRunning(targets, await this.ports.inspect());
    for (const target of current) this.ports.signal(target.pid, signal);
    return current;
  }
}

/** What the Warden may do about a ferret's background jobs, beside a migration. No route serves either. */
export interface AgentJobControl {
  /** The ferret's own jobs that keep a move's safety check from passing. */
  blockingJobs(sessionId: string): Promise<readonly AgentJob[]>;
  /** Stop them, and nothing else under its pane. */
  stopAgentJobs(sessionId: string): Promise<StoppedJobs>;
}
