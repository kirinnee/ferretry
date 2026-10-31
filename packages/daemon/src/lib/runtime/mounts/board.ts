import {
  type BoardErrorCode,
  BoardImportRequestSchema,
  type BoardImportSummary,
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
  parseTaskRef,
} from '@ferretry/protocol';
import { type ApiActor, parseActor } from '../../api/actor.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter, queryValue } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { type BoardCaller, BoardError, BoardUnavailableError } from '../../board/index.ts';
import { parseLegacyRef } from '../../board-import/index.ts';

/**
 * The project boards' HTTP surface (`board-design.md` §2): the board query, one card, a new card, every
 * action on a card, and a ferret's record that its work needs no card. `BoardService` satisfies this structurally.
 */
export interface BoardSubsystem {
  board(query: BoardQuery): Promise<BoardResponse>;
  task(id: BoardTaskId): Promise<BoardTaskResponse>;
  /** The card an old task became, by `<session>:<old id>`; `not-found` when none did. */
  taskByLegacyRef(legacyRef: string): Promise<BoardTaskResponse>;
  /** Runs the one-time import of the old task files; with `dryRun` it only says what it would do. */
  importLegacy(options: { readonly dryRun: boolean }): Promise<BoardImportSummary>;
  create(request: BoardTaskCreateRequest, caller: BoardCaller): Promise<BoardTaskResponse>;
  act(id: BoardTaskId, request: BoardTaskActionRequest, caller: BoardCaller): Promise<BoardTaskResponse>;
  skip(request: BoardSkipRequest, caller: BoardCaller): Promise<BoardSkipResponse>;
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
 * - A ferret is a `peer:<session>`: an agent calling from inside its own pane.
 * - The owner is the human's own CLI or browser (`admin-cli`, `admin-ui`) or a paired device. A remote
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
  if (parsed.kind === 'admin-cli' || parsed.kind === 'admin-ui') return { kind: 'owner' };
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

const QUERY_FIELDS = ['project', 'ferret', 'kind', 'prState', 'activity', 'state', 'query', 'cursor'] as const;

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

/** The old reference in the query: `?legacyRef=<session>:<F12>`, with any sigil and case a person types. */
const legacyRefOf = (context: RouteContext): string => {
  const raw = queryValue(context.request, 'legacyRef');
  const parsed = raw === undefined ? undefined : parseLegacyRef(raw);
  if (parsed === undefined) {
    throw new ApiError(400, 'legacyRef must be <session id>:<old task id>, such as abc123:F12', 'invalid');
  }
  return parsed;
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
      capability: fleet,
      noStore: true,
      compress: true,
      handle: async context => await answer(async () => await board.board(boardQueryOf(context))),
    },
    {
      method: 'POST',
      path: '/v1/board/tasks',
      minimum: 'operator',
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
      path: '/v1/board/tasks',
      minimum: 'operator',
      capability: fleet,
      noStore: true,
      handle: async context => await answer(async () => await board.taskByLegacyRef(legacyRefOf(context))),
    },
    {
      method: 'POST',
      path: '/v1/board/import',
      minimum: 'operator',
      capability: fleet,
      noStore: true,
      handle: async context => {
        if (boardCaller(context.actor).kind !== 'owner') {
          throw new ApiError(403, 'only the owner may import the old task files', 'forbidden');
        }
        const request = await parseBody(context.request, BoardImportRequestSchema);
        return await answer(async () => await board.importLegacy({ dryRun: request.dryRun === true }));
      },
    },
    {
      method: 'GET',
      path: '/v1/board/tasks/:taskId',
      minimum: 'operator',
      capability: fleet,
      noStore: true,
      handle: async context => await answer(async () => await board.task(pathTaskId(context))),
    },
    {
      method: 'POST',
      path: '/v1/board/tasks/:taskId',
      minimum: 'operator',
      capability: fleet,
      noStore: true,
      handle: async context => {
        const caller = boardCaller(context.actor);
        const id = pathTaskId(context);
        const request = await parseBody(context.request, BoardTaskActionRequestSchema);
        return await answer(async () => await board.act(id, request, caller));
      },
    },
  ];
}
