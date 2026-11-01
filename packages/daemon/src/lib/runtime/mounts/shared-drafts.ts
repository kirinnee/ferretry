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
 * OWNER-ONLY, TWICE. `operator` keeps out the warden token and anonymous callers, the dispatcher
 * refuses a member session before any main-table route is looked up, and `caller: 'person'` has the
 * boundary refuse every ferret (`owner_only`) before the handler runs — a draft is exactly what an agent
 * must not read before it is sent. The handler then checks the actor again, narrower still: the owner's own shell (`admin-cli`) or one of the owner's paired devices
 * (`device:<id>`), and nobody else. `admin-ui` is deliberately NOT admitted: every browser is a paired
 * device now, so that actor only ever means an admin token sent with no client header at all — a bare
 * request, which is what an agent that found the token would send. Like `isHumanAdminActor`, this is a
 * boundary for honest clients sharing one machine, not a cryptographic one.
 *
 * The gate runs BEFORE the body is read, so a refused caller learns nothing — not even whether its edit
 * would have parsed.
 *
 * `noStore` because a draft is live and private: no cache should ever hold one.
 */

const OWNER_ACTOR_KINDS: ReadonlySet<string> = new Set(['admin-cli', 'device']);

/**
 * An edit is at most one draft's worth of escaped text plus twenty items, far under this. A text route
 * must not inherit the attachment-sized default ceiling (`api/body.ts`).
 */
export const SHARED_DRAFT_MAX_BODY_BYTES = 128 * 1024;

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
  const request = await parseBody(context.request, SharedDraftEditSchema, { maxBytes: SHARED_DRAFT_MAX_BODY_BYTES });
  return jsonResponse(await drafts.edit(sessionId, request).catch(reraise));
}

export function sharedDraftRoutes(drafts: SharedDraftService): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/shared-draft',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      handle: async context => await read(drafts, context),
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/shared-draft',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      handle: async context => await edit(drafts, context),
    },
  ];
}
