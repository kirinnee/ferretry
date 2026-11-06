import {
  type BoardErrorCode,
  type BoardIdsResponse,
  type BoardMergeGateResponse,
  type BoardQuery,
  type BoardQueryInput,
  BoardQuerySchema,
  type BoardResponse,
  type BoardSkipRequest,
  BoardSkipRequestSchema,
  type BoardSkipResponse,
  type BoardTaskActionRequest,
  BoardTaskActionRequestSchema,
  type BoardTaskCreateRequest,
  BoardTaskCreateRequestSchema,
  type BoardTaskId,
  type BoardTaskResponse,
  type BoardTaskStartResponse,
  FY_REQUEST_ID_HEADER,
  parseTaskRef,
} from '@ferretry/protocol';
import { type ApiActor, parseActor } from '../../api/actor.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter, headerValue, queryValue } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { type BoardCaller, BoardError, BoardUnavailableError } from '../../board/index.ts';

/**
 * The project boards' HTTP surface (`board-design.md` §2): the board query, one card, a new card, every
 * action on a card, and a ferret's record that its work needs no card. `BoardService` satisfies this structurally.
 */
export interface BoardSubsystem {
  board(query: BoardQuery): Promise<BoardResponse>;
  /** Every card id on this machine, whatever its project or state. */
  ids(): Promise<BoardIdsResponse>;
  /** Whether a PR may merge as far as the board's queue goes (docs/design/clash-queue.md). */
  mergeGate(pr: string): Promise<BoardMergeGateResponse>;
  task(id: BoardTaskId): Promise<BoardTaskResponse>;
  create(request: BoardTaskCreateRequest, caller: BoardCaller): Promise<BoardTaskResponse>;
  act(id: BoardTaskId, request: BoardTaskActionRequest, caller: BoardCaller): Promise<BoardTaskResponse>;
  skip(request: BoardSkipRequest, caller: BoardCaller): Promise<BoardSkipResponse>;
  /** The owner's start of a NEW ferret on a card, or the live ferret that already holds it. */
  start(id: BoardTaskId, caller: BoardCaller, key?: string): Promise<BoardTaskStartResponse>;
}

/** The HTTP status each refusal answers with. */
export const BOARD_ERROR_STATUS: Readonly<Record<BoardErrorCode, number>> = {
  invalid: 400,
  'not-found': 404,
  forbidden: 403,
  'reason-required': 422,
  'owner-gate': 403,
  'blocked-by': 409,
  cycle: 409,
  'unknown-lane': 422,
  'no-lane-set': 409,
  'version-conflict': 409,
};

/**
 * Who is writing, from the SERVER-DERIVED actor (`api/actor.ts`), never from the body.
 *
 * - A ferret is a `peer:<session>`: an agent calling from inside its own pane — with its own session
 *   credential always, so such a caller is never the owner whatever its headers say.
 * - The owner is the human's own CLI or browser (`admin-cli`, `admin-ui`) or a paired device; the first two are
 *   recorded as `admin-token`, because a ferret holding that token looks exactly like them. A remote
 *   device reaches these routes only through the `fleet` capability, so it is the owner `docs/grants.md`
 *   lets in; a loopback caller is ungoverned, because somebody at the machine already has the machine.
 *
 * Anything else — a bare `device` with no id, a kind this build does not know — is refused, never
 * guessed at.
 */
export const boardCaller = (actor: ApiActor | undefined): BoardCaller => {
  const parsed = parseActor(actor ?? '');
  if (parsed.kind === 'peer' && parsed.id !== undefined && parsed.id !== '')
    return { kind: 'ferret', sessionId: parsed.id };
  // The host's admin token with no ferret's credential: the owner at the machine OR a ferret that left its
  // session out, and the daemon cannot tell which. It keeps the owner's authority and is RECORDED as the token.
  if (parsed.kind === 'admin-cli' || parsed.kind === 'admin-ui') return { kind: 'owner', via: 'admin-token' };
  if (parsed.kind === 'device' && parsed.id !== undefined && parsed.id !== '') return { kind: 'owner' };
  throw new ApiError(403, 'only a ferret in its own pane or the owner may write to the board', 'forbidden');
};

/** Re-raises a board refusal in the API's own terms; anything else propagates as the defect it is. */
export const reraiseBoardError = (error: unknown): never => {
  if (error instanceof BoardError) {
    throw new ApiError(
      BOARD_ERROR_STATUS[error.code],
      error.message,
      error.code,
      undefined,
      error.allowed.length === 0 ? undefined : { allowed: error.allowed },
    );
  }
  if (error instanceof BoardUnavailableError) throw new ApiError(503, error.message, 'unavailable');
  throw error;
};

const QUERY_FIELDS = [
  'project',
  'ferret',
  'kind',
  'prState',
  'activity',
  'state',
  'query',
  'visibility',
  'cursor',
] as const;

/** The board query, from the URL's query string. A field given empty is a field not given. */
const boardQueryOf = (context: RouteContext): BoardQuery => {
  const input: Record<string, unknown> = {};
  for (const field of QUERY_FIELDS) {
    const value = queryValue(context.request, field);
    if (value !== undefined && value !== '') input[field] = value;
  }
  const limit = queryValue(context.request, 'limit');
  if (limit !== undefined && limit !== '') input.limit = /^[0-9]+$/u.test(limit) ? Number(limit) : limit;
  const parsed = BoardQuerySchema.safeParse(input as BoardQueryInput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError(
      400,
      `the board query is not usable: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
      'invalid',
    );
  }
  return parsed.data;
};

/** The card id in the path: `F12`, and the `&F12` / `#F12` / `f12` spellings a person types. */
const pathTaskId = (context: RouteContext): BoardTaskId => {
  const decoded = decodeParameter(context.params.get('taskId') ?? '');
  const parsed = decoded === undefined ? undefined : parseTaskRef(decoded);
  if (parsed === undefined || !parsed.ok) throw new ApiError(400, 'the card id in the path is not usable', 'invalid');
  return parsed.value.id;
};

const answer = async (work: () => Promise<unknown>): Promise<ApiResponse> =>
  jsonResponse(await work().catch(reraiseBoardError));

/**
 * `operator` throughout, plus the `fleet` capability: a remote caller reaches the board only if the
 * owner lets the fleet be used from there, and a loopback caller is ungoverned (`docs/grants.md`). Who
 * may write WHICH card is the board's own decision — ownership and lineage — made inside the service.
 *
 * `noStore` because a board is what a person watches to know whether work moved.
 *
 * The fixed literals are registered before the patterns under them.
 */
export function boardRoutes(board: BoardSubsystem): readonly ApiRoute[] {
  const fleet = { capability: 'fleet', axis: 'use' } as const;
  return [
    {
      method: 'GET',
      path: '/v1/board',
      minimum: 'operator',
      caller: 'any',
      capability: fleet,
      noStore: true,
      compress: true,
      handle: async context => await answer(async () => await board.board(boardQueryOf(context))),
    },
    {
      method: 'GET',
      path: '/v1/board/ids',
      minimum: 'operator',
      caller: 'any',
      capability: fleet,
      noStore: true,
      compress: true,
      handle: async () => await answer(async () => await board.ids()),
    },
    {
      method: 'GET',
      path: '/v1/board/merge-gate',
      minimum: 'operator',
      caller: 'any',
      capability: fleet,
      noStore: true,
      handle: async context => {
        const pr = queryValue(context.request, 'pr');
        if (pr === undefined) throw new ApiError(400, 'name the pull request: ?pr=<url>', 'invalid');
        return await answer(async () => await board.mergeGate(pr));
      },
    },
    {
      method: 'POST',
      path: '/v1/board/tasks',
      minimum: 'operator',
      caller: 'any',
      capability: fleet,
      noStore: true,
      handle: async context => {
        const caller = boardCaller(context.actor);
        const request = await parseBody(context.request, BoardTaskCreateRequestSchema);
        return await answer(async () => await board.create(request, caller));
      },
    },
    {
      method: 'POST',
      path: '/v1/board/skip',
      minimum: 'operator',
      caller: 'any',
      capability: fleet,
      noStore: true,
      handle: async context => {
        const caller = boardCaller(context.actor);
        const request = await parseBody(context.request, BoardSkipRequestSchema);
        return await answer(async () => await board.skip(request, caller));
      },
    },
    {
      method: 'GET',
      path: '/v1/board/tasks/:taskId',
      minimum: 'operator',
      caller: 'any',
      capability: fleet,
      noStore: true,
      handle: async context => await answer(async () => await board.task(pathTaskId(context))),
    },
    {
      method: 'POST',
      path: '/v1/board/tasks/:taskId',
      minimum: 'operator',
      caller: 'any',
      capability: fleet,
      noStore: true,
      handle: async context => {
        const caller = boardCaller(context.actor);
        const id = pathTaskId(context);
        const request = await parseBody(context.request, BoardTaskActionRequestSchema);
        return await answer(async () => await board.act(id, request, caller));
      },
    },
    {
      // A person's act only: a ferret hands a card down (`fy task assign`, `fy new --card`), it does not start one here.
      method: 'POST',
      path: '/v1/board/tasks/:taskId/start',
      minimum: 'operator',
      caller: 'person',
      capability: fleet,
      noStore: true,
      handle: async context => {
        const caller = boardCaller(context.actor);
        const id = pathTaskId(context);
        // The click's own key is the request id the app reuses on a retry: a retry gets the first start's answer.
        const key = headerValue(context.request, FY_REQUEST_ID_HEADER)?.trim();
        return await answer(async () => await board.start(id, caller, key === '' ? undefined : key));
      },
    },
  ];
}
