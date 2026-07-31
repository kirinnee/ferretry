import type { IWorktreeGateway, WorktreeApiClient } from './ports.ts';
import {
  type RemovedWorktree,
  RemovedWorktreeSchema,
  type WorktreeListResponse,
  WorktreeListResponseSchema,
  type WorktreeRemovalDecision,
  WorktreeRemovalDecisionSchema,
  type WorktreeRemovalRequest,
  WorktreeRemovalRequestSchema,
} from './wire.ts';

/** The managed-worktree routes. */
export const WORKTREES_PATH = '/v1/worktrees';
export const WORKTREE_REMOVE_PATH = '/v1/worktrees/remove';

/**
 * A worktree is addressed by its absolute path, which contains slashes, so it travels as a query
 * parameter rather than a path segment — a path segment would need double encoding and every
 * intermediary would decode it differently.
 */
export function worktreeRemovalCheckPath(path: string): string {
  return `${WORKTREES_PATH}/removal?path=${encodeURIComponent(path)}`;
}

/** Speaks the worktree routes through the protocol client, parsing every response. */
export class ProtocolWorktreeGateway implements IWorktreeGateway {
  constructor(private readonly client: WorktreeApiClient) {}

  async list(): Promise<WorktreeListResponse> {
    return await this.client.request(WORKTREES_PATH, WorktreeListResponseSchema);
  }

  async check(path: string): Promise<WorktreeRemovalDecision> {
    return await this.client.request(worktreeRemovalCheckPath(path), WorktreeRemovalDecisionSchema);
  }

  async remove(request: WorktreeRemovalRequest): Promise<RemovedWorktree> {
    const body = WorktreeRemovalRequestSchema.parse(request);
    return await this.client.request(WORKTREE_REMOVE_PATH, RemovedWorktreeSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}
