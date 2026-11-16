import type { RunnerPaneIdentity } from '../../../contract/index.ts';
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

/**
 * The pane a move looks at, reached through the ferret's own runner (c58-37): addressed by the ferret, never by a tmux
 * session name, so what is read is the pane the registry's handle names RIGHT NOW. Both answers are three-valued on
 * purpose: "proved absent" is an observation (an empty tree, no footer), "cannot tell" is a blind spot the gate refuses on.
 */
export interface MovePane {
  /** The pane's root process and start; `'gone'` only when PROVED absent; `undefined` when the runner cannot tell. */
  identify(): Promise<RunnerPaneIdentity | 'gone' | undefined>;
  /** What the pane last showed; `undefined` when it is PROVED absent. Rejects when the runner cannot read it. */
  screen(): Promise<string | undefined>;
}

export interface ProcessInventoryPort {
  collect(pane: MovePane): Promise<ProcessObservation>;
}
