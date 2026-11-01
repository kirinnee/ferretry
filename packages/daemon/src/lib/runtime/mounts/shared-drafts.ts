import { SHARED_DRAFT_ERROR_CODES, SharedDraftEditSchema } from '@ferretry/protocol';
import { type ApiActor, parseActor } from '../../api/actor.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { SharedDraftError, type SharedDraftErrorCode, type SharedDraftService } from '../../shared-drafts/index.ts';

/**
 * The shared draft's surface: one session's unsent composer, read and edited by the owner's devices.
 *
 * OWNER-ONLY, AND SAID AT THE ROUTE. `operator` already keeps out the warden token and anonymous
 * callers, and the dispatcher refuses a member session before any main-table route is looked up. That
 * leaves an AGENT using the admin bearer from inside its own pane, which the boundary attributes as
 * `peer:<its session>` — and a draft is exactly what an agent must not read before it is sent. So the
 * actor is checked here too: the owner's own shell (`admin-cli`), the owner's app (`admin-ui`) or one
 * of the owner's paired devices (`device:<id>`), and nobody else. Like `isHumanAdminActor`, this
 * is a boundary for honest clients sharing one machine, not a cryptographic one.
 *
 * `noStore` because a draft is live and private: no cache should ever hold one.
 */

const OWNER_ACTOR_KINDS: ReadonlySet<string> = new Set(['admin-cli', 'admin-ui', 'device']);

const ERROR_STATUS: Readonly<Record<SharedDraftErrorCode, readonly [number, string]>> = {
  'not-found': [404, 'not-found'],
  stale: [409, SHARED_DRAFT_ERROR_CODES.stale],
  'too-long': [413, SHARED_DRAFT_ERROR_CODES.tooLong],
  'too-many-items': [413, SHARED_DRAFT_ERROR_CODES.tooManyItems],
  invalid: [422, SHARED_DRAFT_ERROR_CODES.invalid],
};

/** Refuses anybody but the owner, before the draft is even looked at. */
export function assertDraftOwner(actor: ApiActor | undefined): void {
  if (!OWNER_ACTOR_KINDS.has(parseActor(actor ?? '').kind))
    throw new ApiError(
      403,
      'a draft belongs to its owner until it is sent, so only the owner may read or edit it',
      SHARED_DRAFT_ERROR_CODES.ownerOnly,
    );
}

function pathSessionId(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

function reraise(error: unknown): never {
  if (error instanceof SharedDraftError) {
    const [status, code] = ERROR_STATUS[error.code];
    throw new ApiError(status, error.message, code);
  }
  throw error;
}

async function read(drafts: SharedDraftService, context: RouteContext): Promise<ApiResponse> {
  assertDraftOwner(context.actor);
  return jsonResponse(await drafts.read(pathSessionId(context)).catch(reraise));
}

async function edit(drafts: SharedDraftService, context: RouteContext): Promise<ApiResponse> {
  assertDraftOwner(context.actor);
  const sessionId = pathSessionId(context);
  const request = await parseBody(context.request, SharedDraftEditSchema);
  return jsonResponse(await drafts.edit(sessionId, request).catch(reraise));
}

export function sharedDraftRoutes(drafts: SharedDraftService): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/shared-draft',
      minimum: 'operator',
      noStore: true,
      handle: async context => await read(drafts, context),
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/shared-draft',
      minimum: 'operator',
      noStore: true,
      handle: async context => await edit(drafts, context),
    },
  ];
}
