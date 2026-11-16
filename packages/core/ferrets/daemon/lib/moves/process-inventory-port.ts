import type { ProcessObservation } from './inflight-report.ts';
import type { ProcRow } from './process-table.ts';

/**
 * The system process table, or the reason it could not be read.
 *
 * The seam names the one reading it needs rather than accepting an arbitrary command, so no caller
 * can widen it into a general shell and reach the fleet's tmux server or anything else on `$PATH`.
 */
export type ProcessTableRead =
  | { readonly kind: 'read'; readonly stdout: string }
  | { readonly kind: 'failed'; readonly reason: string };

/** Narrow OS boundary for inspecting local processes. */
export interface ProcessProbePort {
  processTable(): Promise<ProcessTableRead>;
  /**
   * The descendants of one process, read without reading every process on the machine — in the order
   * `descendantsOf` would list them from the full table — or `undefined` where this host cannot do that,
   * and the full table must be read instead.
   */
  descendants?(rootPid: number): Promise<readonly ProcRow[] | undefined>;
  /** The process working directory, or undefined when it is not readable. */
  workingDirectory(pid: number): Promise<string | undefined>;
  /**
   * Which of these processes hold a listening TCP socket — a server — or `undefined` where this host
   * cannot tell. The Warden reads a server the agent left up as deliberate, never as a stuck command.
   */
  listening?(pids: readonly number[]): Promise<ReadonlySet<number> | undefined>;
}

export interface ProcessInventoryPort {
  collect(tmuxSession: string): Promise<ProcessObservation>;
}
