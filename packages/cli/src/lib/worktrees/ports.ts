import type { IFyApiClient } from '@ferretry/protocol';
import type { RemovedWorktree, WorktreeListResponse, WorktreeRemovalDecision, WorktreeRemovalRequest } from './wire.ts';

/**
 * Presentation port for the worktree commands — the narrowest slice of the shipped `ConsoleIo`
 * adapter this context uses, so the production adapter satisfies it structurally.
 */
export interface IWorktreeOutput {
  success(message: string): void;
  warn(message: string): void;
}

/** The daemon calls the worktree commands need. */
export interface IWorktreeGateway {
  /** Every worktree the daemon created and still tracks. */
  list(): Promise<WorktreeListResponse>;
  /** Whether one worktree can be removed, and what stands in the way if not. */
  check(path: string): Promise<WorktreeRemovalDecision>;
  /** Remove one worktree, carrying the overrides that clear its blockers. */
  remove(request: WorktreeRemovalRequest): Promise<RemovedWorktree>;
}

/** The only client capability the worktree gateway consumes. */
export type WorktreeApiClient = Pick<IFyApiClient, 'request'>;
