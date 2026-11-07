/**
 * WORK SEARCH ON THE WIRE, one daemon at a time: `GET /v1/search` through the half's own client, parsed with the
 * contract's schema (parse, don't validate), plus the small pure rules the command bar and the composer pickers share.
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  type WorkHit,
  type WorkKind,
  type WorkSearchResponse,
  WorkSearchResponseSchema,
} from '../../contract/index.ts';

/** What one search asks. `open` keeps only work still to do; `kind` narrows to cards or asks. */
export interface WorkSearchRequest {
  readonly q: string;
  readonly kind?: WorkKind;
  readonly open?: boolean;
  /** Also closed work older than the daemon's 30-day window. */
  readonly all?: boolean;
  readonly limit?: number;
}

/** A search bound to one daemon. Aborting `signal` abandons the answer (the call itself is the client's). */
export interface WorkSearchPort {
  search(request: WorkSearchRequest, signal?: AbortSignal): Promise<WorkSearchResponse>;
}

const searchQuery = (request: WorkSearchRequest): Record<string, string> => ({
  q: request.q.trim(),
  ...(request.kind === undefined ? {} : { kind: request.kind }),
  ...(request.open === true ? { open: 'true' } : {}),
  ...(request.all === true ? { all: 'true' } : {}),
  ...(request.limit === undefined ? {} : { limit: String(request.limit) }),
});

/** Read through a function, so a check after an `await` is not narrowed by the one before it. */
const aborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

const abandoned = (): Error => new DOMException('The search was abandoned.', 'AbortError');

/** `GET /v1/search?q=&kind=&open=&limit=` on one daemon. */
export const fetchWorkSearch = async (
  client: Pick<PluginClient, 'call'>,
  request: WorkSearchRequest,
  signal?: AbortSignal,
): Promise<WorkSearchResponse> => {
  if (aborted(signal)) throw abandoned();
  const answer = await client.call('GET /v1/search', { query: searchQuery(request) });
  if (aborted(signal)) throw abandoned();
  return WorkSearchResponseSchema.parse(answer);
};

/** The search port of the daemon this client reaches. */
export const workSearchPort = (client: Pick<PluginClient, 'call'>): WorkSearchPort => ({
  search: (request, signal) => fetchWorkSearch(client, request, signal),
});

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

/** The key an ask hit is known by: its id is per ferret. */
export const workHitKey = (hit: WorkHit): string =>
  hit.kind === 'ask' ? `ask:${hit.ferret}:${hit.id}` : `card:${hit.id}`;

const FIELD_LABELS: Readonly<Record<WorkHit['match']['field'], string>> = {
  id: 'id',
  title: 'title',
  summary: 'summary',
  ask: 'ask',
  premise: 'premise',
  context: 'context',
  brief: 'brief',
  howToTest: 'how to test',
  progress: 'progress',
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
