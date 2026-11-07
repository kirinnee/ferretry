import {
  type CreatedWorktree,
  CreatedWorktreeSchema,
  type CreateWorktreeRequest,
  CreateWorktreeRequestSchema,
  type RemovedWorktree,
  RemovedWorktreeSchema,
  type WorktreeListResponse,
  WorktreeListResponseSchema,
  type WorktreeRemovalDecision,
  WorktreeRemovalDecisionSchema,
  type WorktreeRemovalRequest,
  WorktreeRemovalRequestSchema,
} from '@ferretry/protocol';
import type { IWorktreeGateway, WorktreeApiClient } from './ports.ts';

/** The managed-worktree routes. */
export const WORKTREES_PATH = '/v1/worktrees';
export const WORKTREE_REMOVE_PATH = '/v1/worktrees/remove';

/**
 * A worktree is addressed by its absolute path, which contains slashes, so it travels as a query
 * parameter rather than a path segment — a path segment would need double encoding and every
 * intermediary would decode it differently.
 *
 * The caller's own directory travels beside it. It can only ever ADD a refusal — the daemon reads it
 * to refuse removing the checkout somebody is standing in — so sending it costs nothing, and
 * omitting it is how a caller deletes the tree under their own feet.
 */
export function worktreeRemovalCheckPath(path: string, cwd?: string): string {
  // Composed as literals rather than through a query builder so the address stays READABLE to
  // `scripts/validate/route-agreement.sh`: a path this repository's own gate cannot resolve is one
  // it cannot hold either end to, and this exact route shipped as a 404 once already.
  return `${WORKTREES_PATH}/removal?path=${encodeURIComponent(path)}${cwd === undefined ? '' : `&cwd=${encodeURIComponent(cwd)}`}`;
}

const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Speaks the worktree routes through the protocol client, parsing every response. */
export class ProtocolWorktreeGateway implements IWorktreeGateway {
  constructor(private readonly client: WorktreeApiClient) {}

  async list(): Promise<WorktreeListResponse> {
    return await this.client.request(WORKTREES_PATH, WorktreeListResponseSchema);
  }

  async check(path: string, cwd?: string): Promise<WorktreeRemovalDecision> {
    return await this.client.request(worktreeRemovalCheckPath(path, cwd), WorktreeRemovalDecisionSchema);
  }

  async remove(request: WorktreeRemovalRequest): Promise<RemovedWorktree> {
    const body = WorktreeRemovalRequestSchema.parse(request);
    return await this.client.request(WORKTREE_REMOVE_PATH, RemovedWorktreeSchema, jsonPost(body));
  }

  async create(request: CreateWorktreeRequest): Promise<CreatedWorktree> {
    const body = CreateWorktreeRequestSchema.parse(request);
    return await this.client.request(WORKTREES_PATH, CreatedWorktreeSchema, jsonPost(body));
  }
}
