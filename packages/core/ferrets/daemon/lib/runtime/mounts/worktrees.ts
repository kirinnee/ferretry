import {
  type CreateWorktreeRequest,
  CreateWorktreeRequestSchema,
  type CreatedWorktree,
  type RemovedWorktree,
  type WorktreeListResponse,
  type WorktreeRemovalDecision,
  type WorktreeRemovalRequest,
  WorktreeRemovalRequestSchema,
} from '../../protocol/worktrees.ts';
import { ApiError, type ApiResponse, type CallContext, jsonResponse, queryValue, type RouteHandler } from '@ferretry/kernel/contract';
import { parseBody } from '../../http/body.ts';
import { WorktreeError, type WorktreeErrorCode } from '../../worktrees/index.ts';

type RouteContext = CallContext;

/**
 * The managed-worktree surface: what checkouts this daemon holds, whether one may go, removing one,
 * and forking a new one.
 *
 * THE CLIENT HAS SPOKEN THESE PATHS SINCE BEFORE THE DAEMON COULD ANSWER THEM. `fy worktree
 * ls|check|rm` shipped wired to `/v1/worktrees`, `/v1/worktrees/removal` and `/v1/worktrees/remove`,
 * and the daemon served none of the three: every invocation was a 404 that the repository's own
 * route-agreement allowlist recorded as a defect. The blocker was never the routes — it was that
 * nothing persisted a managed checkout, so even the cheapest of them had no record to decide about.
 *
 * WHY `filesystem`, AND WHY BOTH AXES. The capability set is six and closed, with a stated argument
 * against growth, and worktree lifecycle is squarely inside one of the six: reaching out of the
 * daemon's own state home onto the host to read — and here, to create and destroy — a working tree.
 * The two GETs demand `use` because they read one; the two POSTs demand `configure` because they
 * change what is on the host. A single axis for all four would either hand a remote phone the power
 * to delete a checkout in exchange for permission to list one, or refuse the list to anyone who may
 * not delete.
 *
 * EVERY ROUTE IS `noStore`. A worktree list whose whole value is "what is true right now" must never
 * be served from a cache: a stale row saying a checkout is clean is how a removal destroys work.
 *
 * THE REMOVAL PATH IS A POST WITH A BODY RATHER THAN A DELETE WITH FLAGS, because the consent
 * travels with it — which classes of loss the caller accepted, and which branch-deletion
 * confirmations they gave. A verb with no body has nowhere to carry consent, and a removal that
 * cannot carry consent ends up with a blanket force.
 */

/** The whole surface, as the routes need it. The composition root supplies the real implementation. */
export interface WorktreeSubsystem {
  list(): Promise<WorktreeListResponse>;
  checkRemoval(path: string, currentWorkingDirectory?: string): Promise<WorktreeRemovalDecision>;
  remove(request: WorktreeRemovalRequest): Promise<RemovedWorktree>;
  create(request: CreateWorktreeRequest): Promise<CreatedWorktree>;
}

/**
 * How each refusal reaches the caller.
 *
 * DISTINCT STATUSES PER REASON, because "you asked about a checkout I do not have" (404), "this
 * would destroy work you have not consented to losing" (409) and "that branch name is not a branch
 * name" (422) are three different next steps for whoever is reading. Collapsing them into one 400 is
 * what makes a client print a shrug.
 */
const STATUS: Readonly<Record<WorktreeErrorCode, number>> = {
  unknown_worktree: 404,
  no_managed_root: 409,
  unsafe_remove: 409,
  branch_in_use: 409,
  destination_exists: 409,
  registry_damaged: 500,
  verification_failed: 500,
  not_git_repository: 422,
  invalid_branch: 422,
  invalid_session_id: 422,
  invalid_ownership_token: 500,
  ambiguous_remote_branch: 422,
  unresolved_base: 422,
  unsafe_checkout_filter: 409,
};

/**
 * Restates a domain refusal in the HTTP vocabulary.
 *
 * The error envelope carries a status, a message and a code and nothing else, so a refused removal
 * names its blockers IN the message — every one of them, by code and by sentence. Flattening them
 * into "refused" would leave the caller with a verdict and no way to learn what would have been
 * destroyed, and the check route they would then have to ask is the one they just asked.
 */
function refuse(error: unknown): never {
  if (!(error instanceof WorktreeError)) throw error;
  throw new ApiError(STATUS[error.code], error.message, error.code);
}

/**
 * The checkout a request is about.
 *
 * A worktree is addressed by its absolute path, which contains slashes, so it travels as a query
 * parameter rather than a path segment — a segment would need double encoding and every intermediary
 * would decode it differently.
 */
function target(context: RouteContext): string {
  const path = queryValue(context.request, 'path')?.trim();
  if (path === undefined || path === '') {
    throw new ApiError(400, 'query parameter "path" is required', 'invalid_path');
  }
  return path;
}

async function checkRemoval(worktrees: WorktreeSubsystem, context: RouteContext): Promise<ApiResponse> {
  const cwd = queryValue(context.request, 'cwd')?.trim();
  return jsonResponse(
    await worktrees.checkRemoval(target(context), cwd === undefined || cwd === '' ? undefined : cwd).catch(refuse),
  );
}

async function remove(worktrees: WorktreeSubsystem, context: RouteContext): Promise<ApiResponse> {
  const request = await parseBody(context.request, WorktreeRemovalRequestSchema);
  return jsonResponse(await worktrees.remove(request).catch(refuse));
}

async function create(worktrees: WorktreeSubsystem, context: RouteContext): Promise<ApiResponse> {
  const request = await parseBody(context.request, CreateWorktreeRequestSchema);
  return jsonResponse(await worktrees.create(request).catch(refuse));
}

/** The four route keys, exactly as `manifest.ts` declares them (R-… rows of the parity table, paths unchanged). */
export const WORKTREE_ROUTE_KEYS = [
  'GET /v1/worktrees/removal',
  'POST /v1/worktrees/remove',
  'GET /v1/worktrees',
  'POST /v1/worktrees',
] as const;
export type WorktreeRouteKey = (typeof WORKTREE_ROUTE_KEYS)[number];

/**
 * The managed-worktree handlers, keyed as the manifest names them. The descriptors (operator, any caller, the
 * `filesystem` capability on `use` for the reads and `configure` for the writes, no-store, the one audited
 * removal) are today's and live in `manifest.ts`.
 */
export function worktreeRoutes(worktrees: WorktreeSubsystem): { readonly [K in WorktreeRouteKey]: RouteHandler } {
  return {
    'GET /v1/worktrees/removal': async context => await checkRemoval(worktrees, context),
    'POST /v1/worktrees/remove': async context => await remove(worktrees, context),
    'GET /v1/worktrees': async () => jsonResponse(await worktrees.list().catch(refuse)),
    'POST /v1/worktrees': async context => await create(worktrees, context),
  };
}
