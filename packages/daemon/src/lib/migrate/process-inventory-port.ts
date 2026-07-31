import type { ProcessInfo } from './inflight-report.ts';

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Narrow shell boundary for safely inspecting a migration target. */
export interface CommandPort {
  execute(command: string, arguments_: readonly string[]): Promise<CommandResult>;
}

export interface ProcessInventoryPort {
  collect(tmuxSession: string): Promise<readonly ProcessInfo[]>;
}
