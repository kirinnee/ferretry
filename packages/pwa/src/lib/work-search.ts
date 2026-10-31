/**
 * WORK SEARCH ON THE WIRE, one paired daemon at a time: `GET /v1/search`, parsed with the protocol's own
 * schema (parse, don't validate), plus the small pure rules the finder and the composer pickers share.
 *
 * THE APP SHIPS BEFORE THE DAEMON. A machine that does not list `DAEMON_FEATURES.workSearch` answers `404`,
 * so {@link workSearchPortFor} hands out a port only for a machine known to offer it; every surface keeps its
 * old behaviour exactly when it gets `undefined`.
 */

import { type WorkHit, type WorkKind, type WorkSearchResponse, WorkSearchResponseSchema } from '@ferretry/protocol';
import type { DaemonConnection } from './daemon-connection.ts';
import { daemonRequest } from './daemon-transport.ts';
import { browserFetch, type DaemonFetch, DaemonResponseError } from './runtime-models.ts';

/** What one search asks. `open` keeps only work still to do; `kind` narrows to cards or agenda items. */
export interface WorkSearchRequest {
  readonly q: string;
  readonly kind?: WorkKind;
  readonly open?: boolean;
  readonly limit?: number;
}

/** A search bound to one daemon. Aborting `signal` abandons the request. */
export interface WorkSearchPort {
  search(request: WorkSearchRequest, signal?: AbortSignal): Promise<WorkSearchResponse>;
}

const searchParams = (request: WorkSearchRequest): string => {
  const params = new URLSearchParams({ q: request.q.trim() });
  if (request.kind !== undefined) params.set('kind', request.kind);
  if (request.open === true) params.set('open', 'true');
  if (request.limit !== undefined) params.set('limit', String(request.limit));
  return params.toString();
};

/** `GET /v1/search?q=&kind=&open=&limit=` on one daemon. */
export const fetchWorkSearch = async (
  daemon: DaemonConnection,
  request: WorkSearchRequest,
  fetcher: DaemonFetch = browserFetch,
  signal?: AbortSignal,
): Promise<WorkSearchResponse> => {
  const prepared = daemonRequest(daemon, `/v1/search?${searchParams(request)}`, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  });
  const response = await fetcher(prepared.url, prepared.init);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
    throw new DaemonResponseError(
      response.status,
      typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
      typeof body.code === 'string' ? body.code : undefined,
    );
  }
  return WorkSearchResponseSchema.parse(await response.json());
};

/** The search port of one daemon, over the carrier its traffic rides (`useDaemonFetch`). */
const createWorkSearchPort = (daemon: DaemonConnection, fetcher: DaemonFetch): WorkSearchPort => ({
  search: (request, signal) => fetchWorkSearch(daemon, request, fetcher, signal),
});

/**
 * The port for a machine, or `undefined` unless its health SAID it can search (`offers === true`). A read
 * that has not finished or failed offers nothing: the app cannot tell an old machine from a slow one, so it
 * keeps the older behaviour.
 */
export const workSearchPortFor = (
  offers: boolean | undefined,
  daemon: DaemonConnection,
  fetcher: DaemonFetch,
): WorkSearchPort | undefined => (offers === true ? createWorkSearchPort(daemon, fetcher) : undefined);

/** How long a keystroke waits for the next before it asks the daemon. */
export const WORK_SEARCH_DEBOUNCE_MS = 120;

/** The fewest characters worth asking the daemon about; one letter would match half the board. */
export const WORK_SEARCH_MIN_LENGTH = 2;

/**
 * Whether typed text is WORDS rather than the start of an id (`F3`, `A1`, `f`, `12`). An id prefix keeps the
 * instant local list; words are what only the daemon's body text index can answer.
 */
export const isWorkSearchWords = (text: string): boolean => {
  const trimmed = text.trim();
  return trimmed.length >= WORK_SEARCH_MIN_LENGTH && !/^[a-z]?\d*$/i.test(trimmed);
};

/** A project id to its name, for the projects a machine listed. */
export const workProjectNames = (
  projects: readonly { readonly id: string; readonly name: string }[],
): ReadonlyMap<string, string> => new Map(projects.map(project => [project.id, project.name] as const));

/**
 * The name a card's project goes by, or `''` to show nothing: a project id is a UUID no reader can use, so an
 * id with no known name is left out rather than shown.
 */
export const workProjectLabel = (projectId: string, names: ReadonlyMap<string, string> | undefined): string =>
  projectId === 'unfiled' ? 'Unfiled' : (names?.get(projectId) ?? '');

/** The key an agenda hit is known by: its id is per session. */
export const workHitKey = (hit: WorkHit): string =>
  hit.kind === 'agenda' ? `agenda:${hit.sessionId}:${hit.id}` : `task:${hit.id}`;

const FIELD_LABELS: Readonly<Record<WorkHit['match']['field'], string>> = {
  id: 'id',
  title: 'title',
  summary: 'summary',
  ask: 'ask',
  premise: 'premise',
  context: 'context',
  brief: 'brief',
  howToTest: 'how to test',
  note: 'note',
  body: 'text',
  history: 'history',
  resolution: 'resolution',
};

/**
 * The line a hit matched, for a row's description. A title or id hit says nothing the row's title does not
 * already say; any other field is named, so a passing mention in a note reads as one.
 */
export const workHitDescription = (hit: WorkHit): string => {
  const { field, line } = hit.match;
  const trimmed = line.trim();
  if (trimmed === '' || field === 'title' || field === 'id') return '';
  return `${FIELD_LABELS[field]}: ${trimmed}`;
};

export type { WorkHit, WorkSearchResponse };
