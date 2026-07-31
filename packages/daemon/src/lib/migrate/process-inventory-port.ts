import type { ProcessObservation } from './inflight-report.ts';

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
  /** The process working directory, or undefined when it is not readable. */
  workingDirectory(pid: number): Promise<string | undefined>;
}

export interface ProcessInventoryPort {
  collect(tmuxSession: string): Promise<ProcessObservation>;
}
