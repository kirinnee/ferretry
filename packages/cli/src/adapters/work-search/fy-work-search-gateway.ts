import {
  BoardProjectsResponseSchema,
  type IFyApiClient,
  WORK_RELATED_PATH,
  WORK_SEARCH_PATH,
  type WorkRelatedRequest,
  WorkRelatedRequestSchema,
  WorkRelatedResponseSchema,
  type WorkSearchQueryInput,
  WorkSearchResponseSchema,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { SessionDirectoryEntry } from '../../lib/board/ports';
import { FY_CLIENT_HEADER, FY_CLIENT_NAME, FY_SESSION_ID_HEADER } from '../../lib/session/connection';
import type { IWorkSearchGateway } from '../../lib/work-search/ports';

/** The acting ferret rides on the session header; with none the daemon reads the caller as the owner. */
const actingAs = (as: string | undefined): Record<string, string> => ({
  [FY_CLIENT_HEADER]: FY_CLIENT_NAME,
  ...(as === undefined || as === '' ? {} : { [FY_SESSION_ID_HEADER]: as }),
});

const queryString = (query: WorkSearchQueryInput): string => {
  const parameters = new URLSearchParams({ q: query.q });
  if (query.kind !== undefined) parameters.set('kind', query.kind);
  if (query.open === true) parameters.set('open', 'true');
  if (query.project !== undefined) parameters.set('project', query.project);
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));
  return `?${parameters.toString()}`;
};

/**
 * The work-search routes of the daemon API. The only place the search commands know about URLs and headers:
 * everything above depends on {@link IWorkSearchGateway}.
 */
export class FyWorkSearchGateway implements IWorkSearchGateway {
  constructor(private readonly client: Pick<IFyApiClient, 'request' | 'list'>) {}

  async search(query: WorkSearchQueryInput, as: string | undefined) {
    return await this.client.request(`${WORK_SEARCH_PATH}${queryString(query)}`, WorkSearchResponseSchema, {
      headers: actingAs(as),
    });
  }

  async related(request: WorkRelatedRequest, as: string | undefined) {
    try {
      return await this.client.request(WORK_RELATED_PATH, WorkRelatedResponseSchema, {
        method: 'POST',
        body: JSON.stringify(WorkRelatedRequestSchema.parse(request)),
        headers: { 'content-type': 'application/json', ...actingAs(as) },
      });
    } catch (error) {
      if (error instanceof FyHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  async projects(as: string | undefined) {
    return await this.client.request('/v1/board/projects', BoardProjectsResponseSchema, { headers: actingAs(as) });
  }

  async sessions(): Promise<readonly SessionDirectoryEntry[]> {
    return (await this.client.list()).map(session => ({ id: session.config.id, callsign: session.config.teammate }));
  }
}
