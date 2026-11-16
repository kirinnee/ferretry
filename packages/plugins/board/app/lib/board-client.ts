/**
 * THE BOARD'S WIRE, through the one generated client this half is given (§9.6): `GET /v1/board`,
 * `GET|POST /v1/board/cards/:cardId` and `GET /v1/board/projects`, each answer parsed with the board's own schema
 * (parse, don't validate).
 *
 * A card id is unique on its machine only, so the store above this keys everything `(daemonId, id)`. The client is
 * already bound to one daemon and its credential; the machine argument names the slice the answer belongs to.
 *
 * A REFUSAL IS A VALUE. Reads throw {@link BoardReadError}; a write answers `BoardResult` so the caller can show
 * "needs a reason" or "owner only" without a try/catch, and the daemon's own error `code` rides along as `boardCode`.
 * There is no answer verb: a card never asks (#1552), so there is no route to answer one.
 */

import { type AskListSnapshot, AskListSnapshotSchema } from '@ferretry/core-asks/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { type BoardServerQuery, boardQueryParams } from './board-model.ts';
import type { DaemonConnection } from './machine.ts';
import {
  type BoardErrorCode,
  BoardErrorCodeSchema,
  BoardIdsResponseSchema,
  type BoardProject,
  type BoardProjectId,
  BoardProjectsResponseSchema,
  type BoardResponse,
  BoardResponseSchema,
  type BoardResult,
  boardErr,
  boardOk,
  type CardActionRequestInput,
  CardActionRequestSchema,
  type CardCreateRequestInput,
  CardCreateRequestSchema,
  type CardId,
  type CardResponse,
  CardResponseSchema,
  type CardStartResponse,
  CardStartResponseSchema,
  type LaneSetActionRequestInput,
  LaneSetActionRequestSchema,
  type LaneSetChangeResponse,
  LaneSetChangeResponseSchema,
} from '../../contract/index.ts';

/** The most cards one page asks for; a board larger than a few pages is shown as partial, not paged on. */
const BOARD_PAGE_SIZE = 500;
/** How many pages one read follows before it reports the board as partial. */
export const BOARD_MAX_PAGES = 4;

/** The header that makes a retry of one click safe: the daemon answers a repeat of it with the first answer. */
export const REQUEST_ID_HEADER = 'x-fy-request-id';

/** A read the daemon refused or could not answer. */
export class BoardReadError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'BoardReadError';
  }
}

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
  card(daemon: DaemonConnection, id: CardId): Promise<CardResponse | null>;
  /** One ferret's agenda (`GET /v1/ferrets/:ferretId/agenda`), or `null` when the daemon will not say: the card reads its asks from it. */
  agenda(daemon: DaemonConnection, ferret: string): Promise<AskListSnapshot | null>;
  /** Every card id on the machine. */
  ids(daemon: DaemonConnection): Promise<readonly CardId[]>;
  /** The projects with their lane sets. */
  projects(daemon: DaemonConnection): Promise<readonly BoardProject[]>;
  /** The daemon's own version, or `null` when it cannot be read. */
  version(daemon: DaemonConnection): Promise<string | null>;
  act(
    daemon: DaemonConnection,
    id: CardId,
    request: CardActionRequestInput,
  ): Promise<BoardResult<CardResponse, BoardWriteError>>;
  /** Starts a NEW ferret on the card, as the owner (`POST /v1/board/cards/:cardId/start`). */
  start(daemon: DaemonConnection, id: CardId, key?: string): Promise<BoardResult<CardStartResponse, BoardWriteError>>;
  /** Opens a card the owner writes, on the machine that will hold it. */
  create(
    daemon: DaemonConnection,
    request: CardCreateRequestInput,
  ): Promise<BoardResult<CardResponse, BoardWriteError>>;
  /** Proposes, edits or confirms one project's lanes. */
  lanes(
    daemon: DaemonConnection,
    projectId: BoardProjectId,
    request: LaneSetActionRequestInput,
  ): Promise<BoardResult<LaneSetChangeResponse, LaneWriteError>>;
}

/** What the generated client throws for an answer that was not a success: a status, the sentence and the code. */
const refusalOf = (reason: unknown): { readonly status: number; readonly message: string; readonly code?: string } => {
  const carried = reason as { readonly status?: unknown; readonly code?: unknown } | null;
  return {
    status: typeof carried?.status === 'number' ? carried.status : 0,
    message: reason instanceof Error ? reason.message : String(reason),
    ...(typeof carried?.code === 'string' ? { code: carried.code } : {}),
  };
};

/** A read that throws {@link BoardReadError}; a `404` answers `null` when the caller says an absent one is fine. */
const read = async <Answer>(
  client: Pick<PluginClient, 'call'>,
  route: string,
  init: Parameters<PluginClient['call']>[1],
  absent: boolean,
): Promise<Answer | null> => {
  try {
    return await client.call<Answer>(route, init);
  } catch (reason) {
    const refusal = refusalOf(reason);
    if (absent && refusal.status === 404) return null;
    throw new BoardReadError(refusal.status, refusal.message, refusal.code);
  }
};

const writeError = (status: number, message: string, code: unknown): BoardWriteError => {
  const named = BoardErrorCodeSchema.safeParse(code);
  return { status, message, boardCode: named.success ? named.data : null };
};

/** One write: sent with the action key, its refusal returned as a value. */
const write = async <Answer, Error>(
  client: Pick<PluginClient, 'call'>,
  route: string,
  init: Parameters<PluginClient['call']>[1] & { readonly headers: Readonly<Record<string, string>> },
  parse: (answer: unknown) => Answer | undefined,
  failed: (status: number, message: string, code: unknown) => Error,
  unreadable: string,
): Promise<BoardResult<Answer, Error>> => {
  let answer: unknown;
  try {
    answer = await client.call(route, init as Parameters<PluginClient['call']>[1]);
  } catch (reason) {
    const refusal = refusalOf(reason);
    return boardErr(failed(refusal.status, refusal.message, refusal.code));
  }
  const parsed = parse(answer);
  return parsed === undefined ? boardErr(failed(0, unreadable, undefined)) : boardOk(parsed);
};

const queryRecord = (params: URLSearchParams): Readonly<Record<string, string>> => Object.fromEntries(params);

/** The port over the generated client. The machine argument is the identity of the slice; the client is the wire. */
export const clientBoardPort = (client: Pick<PluginClient, 'call'>): BoardPort => ({
  board: async (_daemon, query, cursor, limit = BOARD_PAGE_SIZE) => {
    const answer = await read<unknown>(
      client,
      'GET /v1/board',
      { query: queryRecord(boardQueryParams(query, cursor, limit)) },
      false,
    );
    return BoardResponseSchema.parse(answer);
  },
  card: async (_daemon, id) => {
    const answer = await read<unknown>(client, 'GET /v1/board/cards/:cardId', { params: { cardId: id } }, true);
    return answer === null ? null : CardResponseSchema.parse(answer);
  },
  ids: async () => BoardIdsResponseSchema.parse(await read<unknown>(client, 'GET /v1/board/ids', {}, false)).ids,
  projects: async () =>
    BoardProjectsResponseSchema.parse(await read<unknown>(client, 'GET /v1/board/projects', {}, false)).projects,
  agenda: async (_daemon, ferret) => {
    try {
      const answer = await client.call<unknown>('GET /v1/ferrets/:ferretId/agenda', { params: { ferretId: ferret } });
      const parsed = AskListSnapshotSchema.safeParse(answer);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  },
  version: async () => {
    try {
      const health = await client.call<{ readonly version?: unknown }>('GET /v1/health');
      return typeof health.version === 'string' ? health.version : null;
    } catch {
      return null;
    }
  },
  act: async (_daemon, id, request) => {
    const checked = CardActionRequestSchema.safeParse(request);
    if (!checked.success) return boardErr(writeError(0, checked.error.message, 'invalid'));
    return await write(
      client,
      'POST /v1/board/cards/:cardId',
      { params: { cardId: id }, body: checked.data, headers: { [REQUEST_ID_HEADER]: crypto.randomUUID() } },
      answer => {
        const parsed = CardResponseSchema.safeParse(answer);
        return parsed.success ? parsed.data : undefined;
      },
      writeError,
      'the daemon answered with a card this app cannot read',
    );
  },
  start: async (_daemon, id, key = crypto.randomUUID()) =>
    await write(
      client,
      'POST /v1/board/cards/:cardId/start',
      { params: { cardId: id }, headers: { [REQUEST_ID_HEADER]: key } },
      answer => {
        const parsed = CardStartResponseSchema.safeParse(answer);
        return parsed.success ? parsed.data : undefined;
      },
      writeError,
      'the daemon answered with a start this app cannot read',
    ),
  create: async (_daemon, request) => {
    const checked = CardCreateRequestSchema.safeParse(request);
    if (!checked.success) return boardErr(writeError(0, checked.error.message, 'invalid'));
    return await write(
      client,
      'POST /v1/board/cards',
      { body: checked.data, headers: { [REQUEST_ID_HEADER]: crypto.randomUUID() } },
      answer => {
        const parsed = CardResponseSchema.safeParse(answer);
        return parsed.success ? parsed.data : undefined;
      },
      writeError,
      'the daemon answered with a card this app cannot read',
    );
  },
  lanes: async (_daemon, projectId, request) => {
    const checked = LaneSetActionRequestSchema.safeParse(request);
    if (!checked.success) return boardErr({ status: 0, message: checked.error.message, code: 'invalid' });
    return await write(
      client,
      'POST /v1/board/projects/:projectId/lanes',
      { params: { projectId }, body: checked.data, headers: { [REQUEST_ID_HEADER]: crypto.randomUUID() } },
      answer => {
        const parsed = LaneSetChangeResponseSchema.safeParse(answer);
        return parsed.success ? parsed.data : undefined;
      },
      (status, message, code): LaneWriteError => ({ status, message, code: typeof code === 'string' ? code : null }),
      'the daemon answered with lanes this app cannot read',
    );
  },
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
