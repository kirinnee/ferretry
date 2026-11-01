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
  /** Wall-clock milliseconds: when the first look and every later one were taken, to pin each start to an instant. */
  nowMs(): number;
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

/**
 * How far apart two readings of one process's START may fall and still be the same process: each is a whole-second
 * age subtracted from when it was read, so each may be off by up to a second.
 */
const START_TOLERANCE_SECONDS = 2;

/** A process as first seen, pinned to when it STARTED — an instant, not an age, so a later look compares like with like. */
export interface SeenProcess {
  readonly pid: number;
  readonly argv: string;
  readonly toolShell?: number;
  /** Seconds since the epoch, or `undefined` when the first look could not tell its age. */
  readonly startedAt: number | undefined;
}

/** When `row`, read at `readAtMs`, started, in seconds since the epoch. */
const startOf = (row: ProcRow, readAtMs: number): number => readAtMs / 1000 - row.startedSecondsAgo;

/**
 * Whether `now` may be the process `seen` was: the same pid, started no later than it did (within the tolerance).
 * Enough to count it ALIVE — a pid the kernel reused started after the first look, later than the tolerance once
 * the stop has been running for a while, and is not counted. One whose start the first look could not tell is
 * counted alive: an unsure reading keeps the ferret where it is.
 */
export function mayBeSameProcess(seen: SeenProcess, now: ProcRow, readAtMs: number): boolean {
  if (seen.pid !== now.pid) return false;
  return seen.startedAt === undefined || startOf(now, readAtMs) <= seen.startedAt + START_TOLERANCE_SECONDS;
}

/** Whether `now` is still the process `seen` was, closely enough to SIGNAL it: the same start and command line. */
export function sameProcess(seen: SeenProcess, now: ProcRow, readAtMs: number): boolean {
  if (seen.pid !== now.pid || seen.startedAt === undefined || seen.argv !== now.argv) return false;
  return Math.abs(startOf(now, readAtMs) - seen.startedAt) <= START_TOLERANCE_SECONDS;
}

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

export class AgentJobStopper {
  constructor(private readonly ports: AgentJobStopPorts) {}

  async stop(): Promise<StoppedJobs> {
    const first = await this.ports.inspect();
    const firstAtMs = this.ports.nowMs();
    const jobs = blockingAgentJobs(first);
    const all: readonly SeenProcess[] = jobProcesses(first).map(row => ({
      pid: row.pid,
      argv: row.argv,
      ...(row.toolShell === undefined ? {} : { toolShell: row.toolShell }),
      startedAt: row.startedSecondsAgo === undefined ? undefined : firstAtMs / 1000 - row.startedSecondsAgo,
    }));
    if (all.length === 0) return { stopped: [], survivors: [] };
    const guarded = all.filter(target => target.pid <= 1 || this.ports.protectedPids.has(target.pid));
    const targets = all.filter(target => !guarded.includes(target));

    let left: readonly SeenProcess[];
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
  private async living(targets: readonly SeenProcess[]): Promise<readonly SeenProcess[]> {
    const now = await this.ports.lookup(targets.map(target => target.pid));
    const readAtMs = this.ports.nowMs();
    return targets.filter(target => {
      const row = now.get(target.pid);
      return row !== undefined && mayBeSameProcess(target, row, readAtMs);
    });
  }

  /**
   * Signal each target that is still the same process RIGHT NOW, deepest first, reading it again first. Answers
   * the ones that may still be running: a target gone before its signal is done with, and one that may be itself
   * but no longer reads as the same process closely enough is not signalled and is still counted.
   */
  private async signalAll(targets: readonly SeenProcess[], signal: StopSignal): Promise<readonly SeenProcess[]> {
    const now = await this.ports.lookup(targets.map(target => target.pid));
    const readAtMs = this.ports.nowMs();
    const living: SeenProcess[] = [];
    for (const target of targets) {
      const row = now.get(target.pid);
      if (row === undefined || !mayBeSameProcess(target, row, readAtMs)) continue;
      if (sameProcess(target, row, readAtMs)) this.ports.signal(target.pid, signal);
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
