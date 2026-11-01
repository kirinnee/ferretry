/**
 * Stopping the background jobs a ferret started itself — what the Warden does to clear a move's way when the
 * owner set `autoMigrate.forceStopBackground`, and nothing else ever calls.
 *
 * WHICH PROCESSES, AND ONLY THOSE. A job is what `identifyAgentJobs` traced to the agent's own tool shell — a
 * `<shell> -c …` child of the harness CLI in THIS session's pane — and everything below that shell, as the first
 * look at the pane's own tree shows it. The tree is read from the session's own tmux pane on the daemon's private
 * socket, so a process of another session, of the owner's terminal or of the system is never a target. The
 * harness CLI itself, the pane's shell and any process the harness owns are not jobs. Init, the daemon and the
 * daemon's parent are never signalled whatever a tree says (`protectedPids`): a job that names one is reported
 * as a survivor, and the Warden does not move the ferret.
 *
 * FOLLOWED BY IDENTITY, NOT BY TREE. Once seen, a target is followed by its pid anywhere on the host — a child
 * whose shell died first is re-parented out of the pane's tree, and leaving it out of the count would report it
 * stopped while it runs on, unwatched, beside the relaunched agent. Before every signal the pid is looked up again
 * and signalled only while it is still the same process: the same command line, started no later than when it
 * was first seen. A pid the kernel reused for a new process started after the first look, so it has run for less
 * time than the process it replaced, and is refused. Whether a target is still ALIVE is judged more cautiously
 * than whether it may be SIGNALLED: the same pid, started no later, is alive whatever its command line reads — so
 * an unsure reading leaves the ferret where it is rather than calling a running job stopped.
 *
 * CHILDREN FIRST. The deepest processes are signalled first. SIGTERM first, then, after a grace period, SIGKILL
 * for whatever is still the same process; what survives even that is reported, and the Warden does not move the
 * ferret. A host whose processes cannot be read stops nothing it cannot account for: every job it was asked about
 * is reported as a survivor.
 */

import { type AgentJob, blockingAgentJobs } from './agent-jobs.ts';
import type { InflightReport, ProcessInfo } from './inflight-report.ts';
import type { ProcRow } from './process-table.ts';
import { verdictBlocksMigration } from './verdict.ts';

export type StopSignal = 'SIGTERM' | 'SIGKILL';

export interface AgentJobStopPorts {
  /** This session's in-flight report, read fresh: its process tree is the pane's own. The first look only. */
  inspect(): Promise<InflightReport>;
  /** These pids, read where they are on the host, whoever their parent is now. A pid not running is absent. Throws when it cannot read. */
  lookup(pids: readonly number[]): Promise<ReadonlyMap<number, ProcRow>>;
  /** Deliver one signal to one pid. Answers whether it was delivered. */
  signal(pid: number, signal: StopSignal): boolean;
  sleep(ms: number): Promise<void>;
  /** Pids never signalled, whatever a tree says: init, the daemon itself, the daemon's parent. */
  readonly protectedPids: ReadonlySet<number>;
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
    report.processes.flatMap(row =>
      row.toolShell !== undefined && verdictBlocksMigration(row.verdict) ? [row.toolShell] : [],
    ),
  );
  return report.processes.filter(row => row.toolShell !== undefined && shells.has(row.toolShell)).toReversed();
}

/** Whether `now` may be the process `seen` was: the same pid, started no later. Enough to count it alive. */
export function mayBeSameProcess(seen: Pick<ProcessInfo, 'pid' | 'startedSecondsAgo'>, now: ProcRow): boolean {
  if (seen.pid !== now.pid || seen.startedSecondsAgo === undefined) return false;
  return now.startedSecondsAgo + ELAPSED_TOLERANCE_SECONDS >= seen.startedSecondsAgo;
}

/** Whether `now` is still the process `seen` was, closely enough to signal it: the same command line too. */
export function sameProcess(seen: Pick<ProcessInfo, 'pid' | 'startedSecondsAgo' | 'argv'>, now: ProcRow): boolean {
  return mayBeSameProcess(seen, now) && seen.argv === now.argv;
}

export class AgentJobStopper {
  constructor(private readonly ports: AgentJobStopPorts) {}

  async stop(): Promise<StoppedJobs> {
    const first = await this.ports.inspect();
    const jobs = blockingAgentJobs(first);
    const all = jobProcesses(first);
    if (all.length === 0) return { stopped: [], survivors: [] };
    const guarded = all.filter(target => target.pid <= 1 || this.ports.protectedPids.has(target.pid));
    const targets = all.filter(target => !guarded.includes(target));

    let left: readonly ProcessInfo[];
    try {
      left = await this.signalAll(targets, 'SIGTERM');
      for (let waited = 0; left.length > 0 && waited < STOP_GRACE_MS; waited += STOP_POLL_MS) {
        await this.ports.sleep(STOP_POLL_MS);
        left = await this.living(left);
      }
      if (left.length > 0) {
        left = await this.signalAll(left, 'SIGKILL');
        if (left.length > 0) {
          await this.ports.sleep(KILL_GRACE_MS);
          left = await this.living(left);
        }
      }
    } catch {
      // The host stopped answering: nothing it was asked about can be shown to have stopped.
      left = targets;
    }
    // A job survives when anything of it — its shell or what the shell started — may still be itself, or was
    // never signalled because it named a protected pid.
    const surviving = new Set([...left, ...guarded].map(row => row.toolShell));
    const shellOf = new Map(first.processes.map(row => [row.pid, row.toolShell]));
    const survived = (job: AgentJob): boolean => surviving.has(shellOf.get(job.pid));
    return { stopped: jobs.filter(job => !survived(job)), survivors: jobs.filter(survived) };
  }

  /** The targets that may still be themselves, read again by pid wherever they are now. */
  private async living(targets: readonly ProcessInfo[]): Promise<readonly ProcessInfo[]> {
    const now = await this.ports.lookup(targets.map(target => target.pid));
    return targets.filter(target => {
      const row = now.get(target.pid);
      return row !== undefined && mayBeSameProcess(target, row);
    });
  }

  /**
   * Signal each target that is still the same process RIGHT NOW, deepest first, reading it again first. Answers
   * the ones that may still be running: a target gone before its signal is done with, and one that may be itself
   * but no longer reads as the same command is not signalled and is still counted.
   */
  private async signalAll(targets: readonly ProcessInfo[], signal: StopSignal): Promise<readonly ProcessInfo[]> {
    const now = await this.ports.lookup(targets.map(target => target.pid));
    const living: ProcessInfo[] = [];
    for (const target of targets) {
      const row = now.get(target.pid);
      if (row === undefined || !mayBeSameProcess(target, row)) continue;
      if (sameProcess(target, row)) this.ports.signal(target.pid, signal);
      living.push(target);
    }
    return living;
  }
}

/** What the Warden may do about a ferret's background jobs, beside a migration. No route serves either. */
export interface AgentJobControl {
  /** The ferret's own jobs that keep a move's safety check from passing. */
  blockingJobs(sessionId: string): Promise<readonly AgentJob[]>;
  /** Stop them, and nothing else under its pane. */
  stopAgentJobs(sessionId: string): Promise<StoppedJobs>;
}
