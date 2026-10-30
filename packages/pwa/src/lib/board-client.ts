/**
 * THE BOARD'S WIRE, one paired daemon at a time: `GET /v1/board`, `GET|POST /v1/board/tasks/:id` and
 * `GET /v1/board/projects`, each answer parsed with the protocol's own schema (parse, don't validate).
 *
 * EVERY CALL NAMES A DAEMON. A card id is unique on its machine only, so there is no daemon-free read and
 * no way to ask "which card is `F12`" of the fleet. The store above this keys everything `(daemonId, id)`.
 *
 * A REFUSAL IS A VALUE. Reads throw `DaemonResponseError` like every other store's port; a write answers
 * `BoardResult` so the caller can show "needs a reason" or "owner only" without a try/catch, and the
 * daemon's own error `code` rides along as `boardCode`.
 */

import {
  type BoardErrorCode,
  BoardErrorCodeSchema,
  type BoardProject,
  type BoardProjectId,
  BoardProjectsResponseSchema,
  type BoardResponse,
  BoardResponseSchema,
  type BoardResult,
  type BoardTaskActionRequestInput,
  BoardTaskActionRequestSchema,
  type BoardTaskCreateRequestInput,
  BoardTaskCreateRequestSchema,
  type BoardTaskId,
  type BoardTaskResponse,
  BoardTaskResponseSchema,
  boardErr,
  boardOk,
  FY_REQUEST_ID_HEADER,
  HealthViewSchema,
  type LaneSetActionRequestInput,
  LaneSetActionRequestSchema,
  type LaneSetChangeResponse,
  LaneSetChangeResponseSchema,
} from '@ferretry/protocol';
import { type BoardServerQuery, boardQueryParams } from './board-model.ts';
import type { DaemonConnection } from './daemon-connection.ts';
import { daemonRequest } from './daemon-transport.ts';
import { browserFetch, type DaemonFetch, DaemonResponseError } from './runtime-models.ts';

/** The most cards one page asks for; a board larger than a few pages is shown as partial, not paged on. */
const BOARD_PAGE_SIZE = 500;
/** How many pages one read follows before it reports the board as partial. */
export const BOARD_MAX_PAGES = 4;

/** One board read, every page followed: the cards and the numbers of the first page. */
export interface BoardRead {
  readonly response: BoardResponse;
  /** The board has more cards than the pages read; the counts still cover all of it. */
  readonly truncated: boolean;
}

/** Why a board write was not applied. */
export interface BoardWriteError {
  /** HTTP status, or `0` when the request never got an answer. */
  readonly status: number;
  readonly message: string;
  /** The daemon's refusal (`reason-required`, `owner-gate`, `blocked-by`, …), when it named one. */
  readonly boardCode: BoardErrorCode | null;
}

/** Why a lane-set change was not applied: the daemon's own `code` (`version-conflict`, `owner-only`, …) rides along. */
export interface LaneWriteError {
  /** HTTP status, or `0` when the request never got an answer. */
  readonly status: number;
  readonly message: string;
  readonly code: string | null;
}

/** The daemon reads and writes the board needs, injected rather than imported. */
export interface BoardPort {
  /** One page of a board; `cursor` continues the one before, `limit` shrinks the page. */
  board(daemon: DaemonConnection, query: BoardServerQuery, cursor?: string, limit?: number): Promise<BoardResponse>;
  /** One card in full, or `null` when the daemon has no such card. */
  task(daemon: DaemonConnection, id: BoardTaskId): Promise<BoardTaskResponse | null>;
  /** The projects with their lane sets, or `null` when the daemon does not serve them. */
  projects(daemon: DaemonConnection): Promise<readonly BoardProject[] | null>;
  /** The daemon's own version, or `null` when it cannot be read. */
  version(daemon: DaemonConnection): Promise<string | null>;
  act(
    daemon: DaemonConnection,
    id: BoardTaskId,
    request: BoardTaskActionRequestInput,
  ): Promise<BoardResult<BoardTaskResponse, BoardWriteError>>;
  /** Opens a card the owner writes, on the machine that will hold it. */
  create(
    daemon: DaemonConnection,
    request: BoardTaskCreateRequestInput,
  ): Promise<BoardResult<BoardTaskResponse, BoardWriteError>>;
  /** Proposes, edits or confirms one project's lanes. */
  lanes(
    daemon: DaemonConnection,
    projectId: BoardProjectId,
    request: LaneSetActionRequestInput,
  ): Promise<BoardResult<LaneSetChangeResponse, LaneWriteError>>;
}

const failure = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

const send = async (
  daemon: DaemonConnection,
  path: string,
  init: RequestInit,
  fetcher: DaemonFetch,
): Promise<Response> => {
  const request = daemonRequest(daemon, path, init);
  return await fetcher(request.url, request.init);
};

const readJson = async (daemon: DaemonConnection, path: string, fetcher: DaemonFetch): Promise<unknown> => {
  const response = await send(daemon, path, { method: 'GET' }, fetcher);
  if (!response.ok) throw await failure(response);
  return await response.json();
};

/** One page of `GET /v1/board`. */
export const fetchBoardPage = async (
  daemon: DaemonConnection,
  query: BoardServerQuery,
  cursor: string | undefined,
  fetcher: DaemonFetch = browserFetch,
  limit: number = BOARD_PAGE_SIZE,
): Promise<BoardResponse> => {
  const path = `/v1/board?${boardQueryParams(query, cursor, limit).toString()}`;
  const response = await send(daemon, path, { method: 'GET' }, fetcher);
  if (!response.ok) throw await failure(response);
  return BoardResponseSchema.parse(await response.json());
};

/** `GET /v1/board/tasks/:id`; a `404` is an absent card, not an error. */
export const fetchBoardTask = async (
  daemon: DaemonConnection,
  id: BoardTaskId,
  fetcher: DaemonFetch = browserFetch,
): Promise<BoardTaskResponse | null> => {
  const response = await send(daemon, `/v1/board/tasks/${encodeURIComponent(id)}`, { method: 'GET' }, fetcher);
  if (response.status === 404) return null;
  if (!response.ok) throw await failure(response);
  return BoardTaskResponseSchema.parse(await response.json());
};

/**
 * `GET /v1/board/projects`. A daemon from before that route answers `404` (or `405`), which is "not
 * served" rather than a failure: the lane sets are then read one project at a time instead.
 */
export const fetchBoardProjects = async (
  daemon: DaemonConnection,
  fetcher: DaemonFetch = browserFetch,
): Promise<readonly BoardProject[] | null> => {
  const response = await send(daemon, '/v1/board/projects', { method: 'GET' }, fetcher);
  if (response.status === 404 || response.status === 405) return null;
  if (!response.ok) throw await failure(response);
  return BoardProjectsResponseSchema.parse(await response.json()).projects;
};

/** The daemon's version from `GET /v1/health`; `null` when it cannot be read, never a throw. */
export const fetchDaemonVersion = async (
  daemon: DaemonConnection,
  fetcher: DaemonFetch = browserFetch,
): Promise<string | null> => {
  try {
    return HealthViewSchema.parse(await readJson(daemon, '/v1/health', fetcher)).version;
  } catch {
    return null;
  }
};

const writeError = (status: number, message: string, code: unknown): BoardWriteError => {
  const named = BoardErrorCodeSchema.safeParse(code);
  return { status, message, boardCode: named.success ? named.data : null };
};

/**
 * `POST /v1/board/tasks/:id`. The request is parsed with the protocol's action schema BEFORE it is sent,
 * so a malformed one never leaves the browser; the answer is the card as the daemon now holds it.
 */
export const postBoardAction = async (
  daemon: DaemonConnection,
  id: BoardTaskId,
  request: BoardTaskActionRequestInput,
  fetcher: DaemonFetch = browserFetch,
): Promise<BoardResult<BoardTaskResponse, BoardWriteError>> => {
  const parsed = BoardTaskActionRequestSchema.safeParse(request);
  if (!parsed.success) return boardErr(writeError(0, parsed.error.message, 'invalid'));
  let response: Response;
  try {
    response = await send(
      daemon,
      `/v1/board/tasks/${encodeURIComponent(id)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', [FY_REQUEST_ID_HEADER]: crypto.randomUUID() },
        body: JSON.stringify(parsed.data),
      },
      fetcher,
    );
  } catch (reason) {
    return boardErr(writeError(0, reason instanceof Error ? reason.message : String(reason), undefined));
  }
  if (!response.ok) {
    const refused = await failure(response);
    return boardErr(writeError(refused.status, refused.message, refused.code));
  }
  const answer = BoardTaskResponseSchema.safeParse(await response.json().catch(() => null));
  return answer.success
    ? boardOk(answer.data)
    : boardErr(writeError(response.status, 'the daemon answered with a card this app cannot read', undefined));
};

/** `POST /v1/board/tasks`: the card as the daemon now holds it, or the refusal as a value. */
export const postBoardCreate = async (
  daemon: DaemonConnection,
  request: BoardTaskCreateRequestInput,
  fetcher: DaemonFetch = browserFetch,
): Promise<BoardResult<BoardTaskResponse, BoardWriteError>> => {
  const parsed = BoardTaskCreateRequestSchema.safeParse(request);
  if (!parsed.success) return boardErr(writeError(0, parsed.error.message, 'invalid'));
  let response: Response;
  try {
    response = await send(
      daemon,
      '/v1/board/tasks',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', [FY_REQUEST_ID_HEADER]: crypto.randomUUID() },
        body: JSON.stringify(parsed.data),
      },
      fetcher,
    );
  } catch (reason) {
    return boardErr(writeError(0, reason instanceof Error ? reason.message : String(reason), undefined));
  }
  if (!response.ok) {
    const refused = await failure(response);
    return boardErr(writeError(refused.status, refused.message, refused.code));
  }
  const answer = BoardTaskResponseSchema.safeParse(await response.json().catch(() => null));
  return answer.success
    ? boardOk(answer.data)
    : boardErr(writeError(response.status, 'the daemon answered with a card this app cannot read', undefined));
};

/**
 * `POST /v1/board/projects/:projectId/lanes`. As with a card action the request is parsed with the
 * protocol's schema BEFORE it is sent; a refusal comes back as a value carrying the daemon's `code`.
 */
export const postLaneSetAction = async (
  daemon: DaemonConnection,
  projectId: BoardProjectId,
  request: LaneSetActionRequestInput,
  fetcher: DaemonFetch = browserFetch,
): Promise<BoardResult<LaneSetChangeResponse, LaneWriteError>> => {
  const parsed = LaneSetActionRequestSchema.safeParse(request);
  if (!parsed.success) return boardErr({ status: 0, message: parsed.error.message, code: 'invalid' });
  let response: Response;
  try {
    response = await send(
      daemon,
      `/v1/board/projects/${encodeURIComponent(projectId)}/lanes`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', [FY_REQUEST_ID_HEADER]: crypto.randomUUID() },
        body: JSON.stringify(parsed.data),
      },
      fetcher,
    );
  } catch (reason) {
    return boardErr({ status: 0, message: reason instanceof Error ? reason.message : String(reason), code: null });
  }
  if (!response.ok) {
    const refused = await failure(response);
    return boardErr({ status: refused.status, message: refused.message, code: refused.code ?? null });
  }
  const answer = LaneSetChangeResponseSchema.safeParse(await response.json().catch(() => null));
  return answer.success
    ? boardOk(answer.data)
    : boardErr({ status: response.status, message: 'the daemon answered with lanes this app cannot read', code: null });
};

/** The browser port over the functions above. */
export const daemonBoardPort = (fetcher: DaemonFetch = browserFetch): BoardPort => ({
  board: (daemon, query, cursor, limit) => fetchBoardPage(daemon, query, cursor, fetcher, limit),
  task: (daemon, id) => fetchBoardTask(daemon, id, fetcher),
  projects: daemon => fetchBoardProjects(daemon, fetcher),
  version: daemon => fetchDaemonVersion(daemon, fetcher),
  act: (daemon, id, request) => postBoardAction(daemon, id, request, fetcher),
  create: (daemon, request) => postBoardCreate(daemon, request, fetcher),
  lanes: (daemon, projectId, request) => postLaneSetAction(daemon, projectId, request, fetcher),
});

/**
 * A whole board: the first page, then each `nextCursor` up to {@link BOARD_MAX_PAGES}. The numbers
 * (`counts`, `quarantined`, the lane set) are the first page's, which the daemon computes over the whole
 * board. A board that runs past the last page is reported `truncated`, never silently cut.
 */
export const readWholeBoard = async (
  port: Pick<BoardPort, 'board'>,
  daemon: DaemonConnection,
  query: BoardServerQuery,
): Promise<BoardRead> => {
  const first = await port.board(daemon, query);
  let cards = first.cards;
  let cursor = first.nextCursor;
  let pages = 1;
  while (cursor !== null && pages < BOARD_MAX_PAGES) {
    const next = await port.board(daemon, query, cursor);
    cards = [...cards, ...next.cards];
    cursor = next.nextCursor;
    pages += 1;
  }
  return { response: { ...first, cards, nextCursor: cursor }, truncated: cursor !== null };
};
