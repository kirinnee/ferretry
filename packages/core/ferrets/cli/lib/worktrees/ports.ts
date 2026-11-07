import type {
  CreatedWorktree,
  CreateWorktreeRequest,
  IFyApiClient,
  RemovedWorktree,
  WorktreeListResponse,
  WorktreeRemovalDecision,
  WorktreeRemovalRequest,
} from '@ferretry/protocol';

/**
 * Presentation port for the worktree commands — the narrowest slice of the shipped `ConsoleIo`
 * adapter this context uses, so the production adapter satisfies it structurally.
 */
export interface IWorktreeOutput {
  success(message: string): void;
  warn(message: string): void;
  /** Uncoloured stderr for JSON evidence that must not corrupt the final stdout payload. */
  diagnostic(message: string): void;
}

/** The daemon calls the worktree commands need. */
export interface IWorktreeGateway {
  /** Every worktree the daemon created and still tracks, refreshed against live Git. */
  list(): Promise<WorktreeListResponse>;
  /** Whether one worktree can be removed, and what stands in the way if not. */
  check(path: string, cwd?: string): Promise<WorktreeRemovalDecision>;
  /** Remove one worktree, carrying the overrides that clear its blockers. */
  remove(request: WorktreeRemovalRequest): Promise<RemovedWorktree>;
  /** Fork a new checkout, and answer with the directory to start work in. */
  create(request: CreateWorktreeRequest): Promise<CreatedWorktree>;
}

/** The only client capability the worktree gateway consumes. */
export type WorktreeApiClient = Pick<IFyApiClient, 'request'>;
