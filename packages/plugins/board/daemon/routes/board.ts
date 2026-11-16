import { ApiError, headerValue, queryValue, type RouteHandler } from '@ferretry/kernel/contract';
import {
  type BoardIdsResponse,
  type BoardMergeGateResponse,
  type BoardQuery,
  BoardQuerySchema,
  type BoardResponse,
  type BoardSkipRequest,
  BoardSkipRequestSchema,
  type BoardSkipResponse,
  type CardActionRequest,
  CardActionRequestSchema,
  type CardCreateRequest,
  CardCreateRequestSchema,
  type CardId,
  type CardResponse,
  type CardStartResponse,
  parseCardRef,
} from '../../contract/index.ts';
import type { BoardCaller } from '../lib/board/index.ts';
import { answer, boardCaller, FY_REQUEST_ID_HEADER, parseBody, pathParameter } from './http.ts';

/** The project boards' HTTP surface: the board query, one card, a new card, every action on a card, a ferret's skip. */
export interface BoardSubsystem {
  board(query: BoardQuery): Promise<BoardResponse>;
  /** Every card id on this machine, whatever its project or state. */
  ids(): Promise<BoardIdsResponse>;
  /** Whether a PR may merge as far as the board's queue goes (docs/design/clash-queue.md). */
  mergeGate(pr: string): Promise<BoardMergeGateResponse>;
  card(id: CardId): Promise<CardResponse>;
  create(request: CardCreateRequest, caller: BoardCaller): Promise<CardResponse>;
  act(id: CardId, request: CardActionRequest, caller: BoardCaller): Promise<CardResponse>;
  skip(request: BoardSkipRequest, caller: BoardCaller): Promise<BoardSkipResponse>;
  /** The owner's start of a NEW ferret on a card, or the live ferret that already holds it. */
  start(id: CardId, caller: BoardCaller, key?: string): Promise<CardStartResponse>;
}

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
const boardQueryOf = (call: Parameters<RouteHandler>[0]): BoardQuery => {
  const input: Record<string, unknown> = {};
  for (const field of QUERY_FIELDS) {
    const value = queryValue(call.request, field);
    if (value !== undefined && value !== '') input[field] = value;
  }
  const limit = queryValue(call.request, 'limit');
  if (limit !== undefined && limit !== '') input.limit = /^[0-9]+$/u.test(limit) ? Number(limit) : limit;
  const parsed = BoardQuerySchema.safeParse(input);
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

/** The card id in the path: `F12`, and the `&F12` / `f12` spellings a person types. */
const pathCardId = (call: Parameters<RouteHandler>[0]): CardId => {
  const parsed = parseCardRef(pathParameter(call, 'cardId', 'card id'));
  if (!parsed.ok) throw new ApiError(400, 'the card id in the path is not usable', 'invalid');
  return parsed.value.id;
};

/**
 * `operator` throughout, plus the `fleet` capability (the manifest): a remote caller reaches the board only if the owner
 * lets the fleet be used from there, and a loopback caller is ungoverned. Who may write WHICH card is the board's own
 * decision — ownership and lineage — made inside the service.
 */
export function boardRoutes(board: BoardSubsystem): {
  readonly 'GET /v1/board': RouteHandler;
  readonly 'GET /v1/board/ids': RouteHandler;
  readonly 'GET /v1/board/merge-gate': RouteHandler;
  readonly 'GET /v1/board/cards': RouteHandler;
  readonly 'POST /v1/board/cards': RouteHandler;
  readonly 'GET /v1/board/cards/:cardId': RouteHandler;
  readonly 'POST /v1/board/cards/:cardId': RouteHandler;
  readonly 'POST /v1/board/cards/:cardId/start': RouteHandler;
  readonly 'POST /v1/board/skip': RouteHandler;
} {
  return {
    'GET /v1/board': async call => await answer(async () => await board.board(boardQueryOf(call))),
    'GET /v1/board/ids': async () => await answer(async () => await board.ids()),
    'GET /v1/board/merge-gate': async call => {
      const pr = queryValue(call.request, 'pr');
      if (pr === undefined) throw new ApiError(400, 'name the pull request: ?pr=<url>', 'invalid');
      return await answer(async () => await board.mergeGate(pr));
    },
    // The same read as the board: the cards the query names, with the counts and lanes beside them.
    'GET /v1/board/cards': async call => await answer(async () => await board.board(boardQueryOf(call))),
    'POST /v1/board/cards': async call => {
      const caller = boardCaller(call);
      const request = await parseBody(call, CardCreateRequestSchema);
      return await answer(async () => await board.create(request, caller));
    },
    'GET /v1/board/cards/:cardId': async call => await answer(async () => await board.card(pathCardId(call))),
    'POST /v1/board/cards/:cardId': async call => {
      const caller = boardCaller(call);
      const id = pathCardId(call);
      const request = await parseBody(call, CardActionRequestSchema);
      return await answer(async () => await board.act(id, request, caller));
    },
    // A person's act only: a ferret hands a card down (`fy card assign`, `fy new --card`), it does not start one here.
    'POST /v1/board/cards/:cardId/start': async call => {
      const caller = boardCaller(call);
      const id = pathCardId(call);
      // The click's own key is the request id the app reuses on a retry: a retry gets the first start's answer.
      const key = headerValue(call.request, FY_REQUEST_ID_HEADER)?.trim();
      return await answer(async () => await board.start(id, caller, key === '' ? undefined : key));
    },
    'POST /v1/board/skip': async call => {
      const caller = boardCaller(call);
      const request = await parseBody(call, BoardSkipRequestSchema);
      return await answer(async () => await board.skip(request, caller));
    },
  };
}
