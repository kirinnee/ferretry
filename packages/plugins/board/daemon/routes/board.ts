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
  type TaskActionRequest,
  CardActionRequestSchema,
  type TaskCreateRequest,
  CardCreateRequestSchema,
  type TaskId,
  type TaskResponse,
  type TaskStartResponse,
  type FormerPath,
  parseTaskRef,
  taskWire,
  withFormerPaths,
} from '../../contract/index.ts';
import type { BoardCaller } from '../lib/board/index.ts';
import { answer, boardCaller, FY_REQUEST_ID_HEADER, parseBody, pathParameter } from './http.ts';

/** The project boards' HTTP surface: the board query, one task, a new task, every action on a task, a ferret's skip. */
export interface BoardSubsystem {
  board(query: BoardQuery): Promise<BoardResponse>;
  /** Every task id on this machine, whatever its project or state. */
  ids(): Promise<BoardIdsResponse>;
  /** Whether a PR may merge as far as the board's queue goes (docs/design/clash-queue.md). */
  mergeGate(pr: string): Promise<BoardMergeGateResponse>;
  card(id: TaskId): Promise<TaskResponse>;
  create(request: TaskCreateRequest, caller: BoardCaller): Promise<TaskResponse>;
  act(id: TaskId, request: TaskActionRequest, caller: BoardCaller): Promise<TaskResponse>;
  skip(request: BoardSkipRequest, caller: BoardCaller): Promise<BoardSkipResponse>;
  /** The owner's start of a NEW ferret on a task, or the live ferret that already holds it. */
  start(id: TaskId, caller: BoardCaller, key?: string): Promise<TaskStartResponse>;
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

/** The task id in the path: `F12`, and the `&F12` / `f12` spellings a person types. */
const pathTaskId = (call: Parameters<RouteHandler>[0]): TaskId => {
  const parsed = parseTaskRef(
    pathParameter(call, call.params.get('taskId') === undefined ? 'cardId' : 'taskId', 'task id'),
  );
  if (!parsed.ok) throw new ApiError(400, 'the task id in the path is not usable', 'invalid');
  return parsed.value.id;
};

/** The routes about one task, each answered again under its former path. */
type TaskRoutes = {
  readonly [Key in
    | 'GET /v1/board/tasks'
    | 'POST /v1/board/tasks'
    | 'GET /v1/board/tasks/:taskId'
    | 'POST /v1/board/tasks/:taskId'
    | 'POST /v1/board/tasks/:taskId/start']: RouteHandler;
};
type BoardRoutes = TaskRoutes & {
  readonly [Key in keyof TaskRoutes as FormerPath<Key>]: RouteHandler;
} & {
  readonly [Key in
    | 'GET /v1/board'
    | 'GET /v1/board/ids'
    | 'GET /v1/board/merge-gate'
    | 'POST /v1/board/skip']: RouteHandler;
};

/**
 * `operator` throughout, plus the `fleet` capability (the manifest): a remote caller reaches the board only if the owner
 * lets the fleet be used from there, and a loopback caller is ungoverned. Who may write WHICH task is the board's own
 * decision — ownership and lineage — made inside the service.
 */
export function boardRoutes(board: BoardSubsystem): BoardRoutes {
  const taskRoutes = {
    'GET /v1/board/tasks': async (call: Parameters<RouteHandler>[0]) =>
      await answer(async () => taskWire.board(await board.board(boardQueryOf(call)))),
    'POST /v1/board/tasks': async (call: Parameters<RouteHandler>[0]) => {
      const caller = boardCaller(call);
      const request = await parseBody(call, CardCreateRequestSchema);
      return await answer(async () => taskWire.card(await board.create(request, caller)));
    },
    'GET /v1/board/tasks/:taskId': async (call: Parameters<RouteHandler>[0]) =>
      await answer(async () => taskWire.card(await board.card(pathTaskId(call)))),
    'POST /v1/board/tasks/:taskId': async (call: Parameters<RouteHandler>[0]) => {
      const caller = boardCaller(call);
      const id = pathTaskId(call);
      const request = await parseBody(call, CardActionRequestSchema);
      return await answer(async () => taskWire.card(await board.act(id, request, caller)));
    },
    // A person's act only: a ferret hands a task down (`fy task assign`, `fy new --task`), it does not start one here.
    'POST /v1/board/tasks/:taskId/start': async (call: Parameters<RouteHandler>[0]) => {
      const caller = boardCaller(call);
      const id = pathTaskId(call);
      // The click's own key is the request id the app reuses on a retry: a retry gets the first start's answer.
      const key = headerValue(call.request, FY_REQUEST_ID_HEADER)?.trim();
      return await answer(async () => taskWire.start(await board.start(id, caller, key === '' ? undefined : key)));
    },
  } as const;
  return {
    ...withFormerPaths(taskRoutes),
    'GET /v1/board': async call => await answer(async () => taskWire.board(await board.board(boardQueryOf(call)))),
    'GET /v1/board/ids': async () => await answer(async () => await board.ids()),
    'GET /v1/board/merge-gate': async call => {
      const pr = queryValue(call.request, 'pr');
      if (pr === undefined) throw new ApiError(400, 'name the pull request: ?pr=<url>', 'invalid');
      return await answer(async () => taskWire.mergeGate(await board.mergeGate(pr)));
    },
    'POST /v1/board/skip': async call => {
      const caller = boardCaller(call);
      const request = await parseBody(call, BoardSkipRequestSchema);
      return await answer(async () => await board.skip(request, caller));
    },
  };
}
