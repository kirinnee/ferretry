import { SHARED_DRAFT_ERROR_CODES, SharedDraftEditSchema } from '@ferretry/protocol';
import { type ApiActor, parseActor } from '../../api/actor.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import type { SocketRoute } from '../../api/socket.ts';
import type { SentDraftClearer } from './session-send.ts';
import {
  SharedDraftError,
  type SharedDraftErrorCode,
  type SharedDraftPresence,
  type SharedDraftService,
  type SharedDraftStreamClock,
  SharedDraftStreamHandler,
  type SharedDraftStreamTarget,
  sharedDraftOrigin,
} from '../../shared-drafts/index.ts';

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
  'rate-limited': [429, SHARED_DRAFT_ERROR_CODES.rateLimited],
  invalid: [422, SHARED_DRAFT_ERROR_CODES.invalid],
};

/** Whether this caller is the owner: their own shell, or one of their paired devices. */
const isDraftOwner = (actor: ApiActor | undefined): boolean => OWNER_ACTOR_KINDS.has(parseActor(actor ?? '').kind);

/** Refuses anybody but the owner, before the draft is even looked at. */
export function assertDraftOwner(actor: ApiActor | undefined): void {
  if (!isDraftOwner(actor))
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
  // The wire answer is the edit and the draft; whether it was a repeat is the stream's business.
  const { repeatOf: _repeatOf, ...result } = await drafts.edit(sessionId, request).catch(reraise);
  return jsonResponse(result);
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

/** What the live stream needs beyond the draft itself: who is on the other end, and an id for this stream. */
export interface SharedDraftStreamSubsystem {
  readonly presence: SharedDraftPresence;
  /** The name the owner gave a paired device, or nothing when it has none (or is gone). */
  deviceName(deviceId: string): Promise<string | undefined>;
  /** A fresh id per stream: unguessable, and never reused while the daemon runs. */
  nextPeer(): string;
  readonly clock: SharedDraftStreamClock;
}

/** How the hint on the owner's other screens names this composer: "also typing on <this>". */
async function deviceLabel(subsystem: SharedDraftStreamSubsystem, actor: ApiActor | undefined): Promise<string> {
  const { kind, id } = parseActor(actor ?? '');
  if (kind === 'device' && id !== undefined) return (await subsystem.deviceName(id)) ?? 'another device';
  return 'this computer';
}

/** The three `after` coordinates, all or none: half a position is no position at all. */
function streamPosition(context: RouteContext): SharedDraftStreamTarget['position'] {
  const read = (name: string): string | undefined => {
    const values = context.request.query.get(name) ?? [];
    if (values.length > 1) throw new ApiError(400, `query parameter "${name}" may appear only once`, 'invalid_query');
    return values[0];
  };
  const generation = read('generation');
  const epoch = read('epoch');
  const rev = read('rev');
  if (generation === undefined && epoch === undefined && rev === undefined) return undefined;
  const count = (value: string | undefined): number | undefined =>
    value !== undefined && /^[0-9]{1,9}$/u.test(value) ? Number(value) : undefined;
  const epochValue = count(epoch);
  const revValue = count(rev);
  if (
    generation === undefined ||
    generation === '' ||
    generation.length > 64 ||
    epochValue === undefined ||
    revValue === undefined
  )
    throw new ApiError(400, 'generation, epoch and rev go together, as a draft position', 'invalid_query');
  return { generation, epoch: epochValue, rev: revValue };
}

/**
 * The live stream every open composer for a session holds (`shared-drafts/stream.ts`). The same owner
 * gate as the routes above, and the session is proved to exist before the protocol switches, so an
 * upgrade aimed at nothing is a 404 rather than a socket that dies.
 */
export function sharedDraftSocketRoutes(
  drafts: SharedDraftService,
  subsystem: SharedDraftStreamSubsystem,
): readonly SocketRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/shared-draft/stream',
      minimum: 'operator',
      caller: 'person',
      accept: async context => {
        assertDraftOwner(context.actor);
        const sessionId = pathSessionId(context);
        const position = streamPosition(context);
        await drafts.read(sessionId).catch(reraise);
        const target: SharedDraftStreamTarget = {
          sessionId,
          peer: subsystem.nextPeer(),
          device: await deviceLabel(subsystem, context.actor),
          author: context.actor ?? '',
          ...(position === undefined ? {} : { position }),
        };
        return async downstream =>
          new SharedDraftStreamHandler(drafts, subsystem.presence, target, downstream, subsystem.clock);
      },
    },
  ];
}

/**
 * The send route's half of the shared draft: what an accepted send carried out of it is taken out, as one
 * edit marked sent, keyed to the send's request id and its author — so the composer's own clear for the
 * same send, or a retried send, is a repeat and applies nothing. ONLY THE OWNER'S sends do this: the send
 * route serves ferrets too, and a ferret must never touch the owner's draft.
 */
export function sentDraftClearer(drafts: Pick<SharedDraftService, 'edit'>): SentDraftClearer {
  return async (sessionId, actor, requestId, sent) => {
    if (!isDraftOwner(actor) || actor === undefined) return;
    await drafts.edit(
      sessionId,
      {
        generation: sent.generation,
        epoch: sent.epoch,
        base: sent.base,
        text: sent.text,
        ...(sent.remove === undefined ? {} : { remove: sent.remove }),
        sent: true,
      },
      sharedDraftOrigin(actor, 'send', requestId),
    );
  };
}
