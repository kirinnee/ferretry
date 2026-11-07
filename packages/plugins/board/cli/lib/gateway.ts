/**
 * The board's routes as the plugin client speaks them: the only place the CLI half knows a route key. Everything
 * above depends on {@link BoardGateway} / {@link LaneGateway}. The client attaches the caller's own credential, so
 * the acting ferret is never a parameter.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import type {
  BoardMergeGateResponse,
  BoardProject,
  BoardProjectId,
  BoardProjectsResponse,
  BoardQueryInput,
  BoardResponse,
  BoardSkipRequest,
  BoardSkipResponse,
  BoardSwitch,
  CardActionRequestInput,
  CardCreateRequestInput,
  CardResponse,
  LaneSetActionRequestInput,
  LaneSetChangeResponse,
} from '../../contract/index.ts';
import type { BoardGateway, FerretDirectoryEntry, LaneGateway } from './ports.ts';
import type { RelatedResponse } from './related.ts';

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
  'limit',
] as const;

const queryOf = (query: BoardQueryInput): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const field of QUERY_FIELDS) {
    const value = query[field];
    if (value !== undefined) out[field] = String(value);
  }
  return out;
};

/** What `GET /v1/ferrets` answers, read for names only: a list of ferret records, bare or under `ferrets`. */
const directoryOf = (answer: unknown): readonly FerretDirectoryEntry[] => {
  const rows = Array.isArray(answer)
    ? answer
    : typeof answer === 'object' && answer !== null && Array.isArray((answer as { ferrets?: unknown }).ferrets)
      ? ((answer as { ferrets: unknown[] }).ferrets as unknown[])
      : [];
  return rows.flatMap(row => {
    if (typeof row !== 'object' || row === null) return [];
    const { id, name } = row as { id?: unknown; name?: unknown };
    return typeof id === 'string' ? [{ id, name: typeof name === 'string' ? name : undefined }] : [];
  });
};

export class ClientBoardGateway implements BoardGateway {
  constructor(private readonly client: PluginClient) {}

  async board(query: BoardQueryInput) {
    return await this.client.call<BoardResponse>('GET /v1/board', { query: queryOf(query) });
  }

  async card(id: string) {
    return await this.client.call<CardResponse>('GET /v1/board/cards/:cardId', { params: { cardId: id } });
  }

  async create(request: CardCreateRequestInput) {
    return await this.client.call<CardResponse>('POST /v1/board/cards', { body: request });
  }

  async act(id: string, request: CardActionRequestInput) {
    return await this.client.call<CardResponse>('POST /v1/board/cards/:cardId', {
      params: { cardId: id },
      body: request,
    });
  }

  async skip(request: BoardSkipRequest) {
    return await this.client.call<BoardSkipResponse>('POST /v1/board/skip', { body: request });
  }

  async projects() {
    return await this.client.call<BoardProjectsResponse>('GET /v1/board/projects');
  }

  async ferrets(): Promise<readonly FerretDirectoryEntry[]> {
    return directoryOf(await this.client.call<unknown>('GET /v1/ferrets'));
  }

  async mergeGate(pr: string) {
    return await this.client.call<BoardMergeGateResponse>('GET /v1/board/merge-gate', { query: { pr } });
  }

  async related(request: { kind: 'card'; title: string; ask?: string }) {
    return await this.client.call<RelatedResponse>('POST /v1/search/related', { body: request });
  }
}

export class ClientLaneGateway implements LaneGateway {
  constructor(private readonly client: PluginClient) {}

  async projects() {
    return await this.client.call<BoardProjectsResponse>('GET /v1/board/projects');
  }

  async project(projectId: BoardProjectId) {
    return await this.client.call<BoardProject>('GET /v1/board/projects/:projectId/lanes', { params: { projectId } });
  }

  async change(projectId: BoardProjectId, request: LaneSetActionRequestInput) {
    return await this.client.call<LaneSetChangeResponse>('POST /v1/board/projects/:projectId/lanes', {
      params: { projectId },
      body: request,
    });
  }

  async switchOf(projectId: BoardProjectId) {
    return await this.client.call<BoardSwitch>('GET /v1/board/projects/:projectId/switch', { params: { projectId } });
  }

  async setSwitch(projectId: BoardProjectId, on: boolean) {
    return await this.client.call<BoardSwitch>('PUT /v1/board/projects/:projectId/switch', {
      params: { projectId },
      body: { on },
    });
  }
}
