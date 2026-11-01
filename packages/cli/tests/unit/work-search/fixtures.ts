import type {
  BoardProjectsResponse,
  WorkHit,
  WorkRelatedRequest,
  WorkRelatedResponse,
  WorkSearchQueryInput,
  WorkSearchResponse,
} from '@ferretry/protocol';
import type { SessionDirectoryEntry } from '../../../src/lib/board/ports';
import type { IWorkSearchGateway, IWorkSearchOutput } from '../../../src/lib/work-search/ports';
import { directory, FERRETRY_ID, listing } from '../board/fixtures';

export const LIZZETTE = 'mvgt2oz9-1111aaaa';
const ADRIENNE = 'mvwwvnpi-dce37c6f';

const sessions: readonly SessionDirectoryEntry[] = [
  ...directory,
  { id: LIZZETTE, callsign: 'lizzette' },
  { id: ADRIENNE, callsign: 'adrienne' },
];

const BASE = { state: 'open' as const, updatedAt: '2026-10-30T10:00:00.000Z', score: 4 };

export const taskHit = (overrides: Partial<Extract<WorkHit, { kind: 'task' }>> = {}): WorkHit => ({
  kind: 'task',
  id: 'F303',
  projectId: FERRETRY_ID as Extract<WorkHit, { kind: 'task' }>['projectId'],
  sessionId: null,
  title: 'Work search',
  standing: 'In progress',
  match: { field: 'ask', line: 'make search easy and fast' },
  ...BASE,
  ...overrides,
});

export const agendaHit = (overrides: Partial<Extract<WorkHit, { kind: 'agenda' }>> = {}): WorkHit => ({
  kind: 'agenda',
  id: 'A3',
  sessionId: LIZZETTE,
  title: 'Pick a relay',
  standing: 'open',
  match: { field: 'title', line: 'Pick a relay' },
  ...BASE,
  ...overrides,
});

export const response = (hits: readonly WorkHit[], total = hits.length): WorkSearchResponse => ({
  hits: [...hits],
  total,
  indexed: { tasks: 10, agenda: 4 },
});

export class FakeWorkSearchGateway implements IWorkSearchGateway {
  readonly searches: { query: WorkSearchQueryInput; as: string | undefined }[] = [];
  readonly relatedCalls: { request: WorkRelatedRequest; as: string | undefined }[] = [];
  answer: WorkSearchResponse = response([]);
  /** `undefined` plays a daemon with no related check (a 404). */
  relatedAnswer: WorkRelatedResponse | undefined = { matches: [] };
  relatedError: unknown;
  projectList: BoardProjectsResponse = listing();

  search(query: WorkSearchQueryInput, as: string | undefined) {
    this.searches.push({ query, as });
    return Promise.resolve(this.answer);
  }

  related(request: WorkRelatedRequest, as: string | undefined) {
    this.relatedCalls.push({ request, as });
    if (this.relatedError !== undefined) return Promise.reject(this.relatedError);
    return Promise.resolve(this.relatedAnswer);
  }

  projects() {
    return Promise.resolve(this.projectList);
  }

  sessions() {
    return Promise.resolve(sessions);
  }
}

export class CapturingOutput implements IWorkSearchOutput {
  readonly lines: string[] = [];
  readonly notices: string[] = [];

  success(message: string) {
    this.lines.push(message);
  }

  diagnostic(message: string) {
    this.notices.push(message);
  }
}
