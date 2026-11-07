import type { PluginClient } from '@ferretry/kernel/manifest';
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
} from '../../../daemon/lib/protocol/worktrees.ts';
import type { IWorktreeGateway } from './ports.ts';

/** The managed-worktree routes (today's paths: none of them names a replaced word). */
export const WORKTREE_ROUTES = {
  list: 'GET /v1/worktrees',
  check: 'GET /v1/worktrees/removal',
  remove: 'POST /v1/worktrees/remove',
  create: 'POST /v1/worktrees',
} as const;

/**
 * Speaks the worktree routes through the shell's client, parsing every answer.
 *
 * A worktree is addressed by its absolute path, which contains slashes, so it travels as a query parameter rather
 * than a path segment. The caller's own directory travels beside it: it can only ever ADD a refusal — the daemon reads
 * it to refuse removing the checkout somebody is standing in — so sending it costs nothing.
 */
export class ClientWorktreeGateway implements IWorktreeGateway {
  constructor(private readonly client: PluginClient) {}

  async list(): Promise<WorktreeListResponse> {
    return WorktreeListResponseSchema.parse(await this.client.call(WORKTREE_ROUTES.list));
  }

  async check(path: string, cwd?: string): Promise<WorktreeRemovalDecision> {
    const query: Record<string, string> = cwd === undefined ? { path } : { path, cwd };
    return WorktreeRemovalDecisionSchema.parse(await this.client.call(WORKTREE_ROUTES.check, { query }));
  }

  async remove(request: WorktreeRemovalRequest): Promise<RemovedWorktree> {
    const body = WorktreeRemovalRequestSchema.parse(request);
    return RemovedWorktreeSchema.parse(await this.client.call(WORKTREE_ROUTES.remove, { body }));
  }

  async create(request: CreateWorktreeRequest): Promise<CreatedWorktree> {
    const body = CreateWorktreeRequestSchema.parse(request);
    return CreatedWorktreeSchema.parse(await this.client.call(WORKTREE_ROUTES.create, { body }));
  }
}
