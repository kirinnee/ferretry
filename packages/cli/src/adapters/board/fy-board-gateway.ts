import {
  type BoardProjectId,
  BoardProjectsResponseSchema,
  type BoardQueryInput,
  BoardResponseSchema,
  type BoardSkipRequest,
  BoardSkipRequestSchema,
  BoardSkipResponseSchema,
  BoardSwitchSchema,
  type BoardTaskActionRequestInput,
  BoardTaskActionRequestSchema,
  type BoardTaskCreateRequestInput,
  BoardTaskCreateRequestSchema,
  BoardTaskResponseSchema,
  type IFyApiClient,
} from '@ferretry/protocol';
import type { z } from 'zod';
import type { IBoardGateway, SessionDirectoryEntry } from '../../lib/board/ports';
import { FY_CLIENT_HEADER, FY_CLIENT_NAME, FY_SESSION_ID_HEADER } from '../../lib/session/connection';

const QUERY_FIELDS = ['project', 'ferret', 'kind', 'prState', 'activity', 'state', 'query', 'cursor', 'limit'] as const;

const queryString = (query: BoardQueryInput): string => {
  const parameters = new URLSearchParams();
  for (const field of QUERY_FIELDS) {
    const value = query[field];
    if (value !== undefined) parameters.set(field, String(value));
  }
  const text = parameters.toString();
  return text === '' ? '' : `?${text}`;
};

const taskPath = (id: string): string => `/v1/board/tasks/${encodeURIComponent(id)}`;

/** The acting ferret rides on the session header; with none the daemon reads the caller as the owner. */
const actingAs = (as: string | undefined): Record<string, string> => ({
  [FY_CLIENT_HEADER]: FY_CLIENT_NAME,
  ...(as === undefined || as === '' ? {} : { [FY_SESSION_ID_HEADER]: as }),
});

const post = <Input>(schema: z.ZodType<unknown, Input>, value: Input, as: string | undefined): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(schema.parse(value)),
  headers: { 'content-type': 'application/json', ...actingAs(as) },
});

/**
 * The board routes of the daemon API. The only place the board commands know about URLs and headers:
 * everything above depends on {@link IBoardGateway}.
 */
export class FyBoardGateway implements IBoardGateway {
  constructor(private readonly client: Pick<IFyApiClient, 'request' | 'list'>) {}

  async board(query: BoardQueryInput) {
    return await this.client.request(`/v1/board${queryString(query)}`, BoardResponseSchema);
  }

  async task(id: string) {
    return await this.client.request(taskPath(id), BoardTaskResponseSchema);
  }

  async create(as: string | undefined, request: BoardTaskCreateRequestInput) {
    return await this.client.request(
      '/v1/board/tasks',
      BoardTaskResponseSchema,
      post(BoardTaskCreateRequestSchema, request, as),
    );
  }

  async act(as: string | undefined, id: string, request: BoardTaskActionRequestInput) {
    return await this.client.request(
      taskPath(id),
      BoardTaskResponseSchema,
      post(BoardTaskActionRequestSchema, request, as),
    );
  }

  async skip(as: string | undefined, request: BoardSkipRequest) {
    return await this.client.request(
      '/v1/board/skip',
      BoardSkipResponseSchema,
      post(BoardSkipRequestSchema, request, as),
    );
  }

  async projects(as: string | undefined) {
    return await this.client.request('/v1/board/projects', BoardProjectsResponseSchema, {
      headers: actingAs(as),
    });
  }

  async switchOf(projectId: BoardProjectId) {
    return await this.client.request(`/v1/board/projects/${encodeURIComponent(projectId)}/switch`, BoardSwitchSchema);
  }

  async sessions(): Promise<readonly SessionDirectoryEntry[]> {
    return (await this.client.list()).map(session => ({ id: session.config.id, callsign: session.config.teammate }));
  }
}
