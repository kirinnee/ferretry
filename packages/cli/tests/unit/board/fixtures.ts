import {
  type BoardProject,
  type BoardProjectsResponse,
  type BoardResponse,
  BoardResponseSchema,
  type BoardTaskEvent,
  type BoardTaskResponse,
  type BoardTaskView,
  BoardTaskViewSchema,
  LANE_TEMPLATES,
  type LaneSet,
  type PrLink,
  PrLinkSchema,
} from '@ferretry/protocol';
import type { SessionDirectoryEntry } from '../../../src/lib/board/ports';

export const FERRETRY_ID = '0b1f6d1e-6c1b-4f0c-8f4e-2f6f2a3c9a10';
export const OTHER_ID = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

export const DENISHA = 'sess-denisha-0001';
export const KIRIN = 'sess-kirin-0002';
export const ANON = 'sess-anon-0003';

export const AT = '2026-01-02T03:04:05.000Z';

export const directory: readonly SessionDirectoryEntry[] = [
  { id: DENISHA, callsign: 'denisha' },
  { id: KIRIN, callsign: 'Kirin' },
  { id: ANON, callsign: undefined },
];

export const laneSet = (overrides: Partial<LaneSet> = {}): LaneSet => ({
  projectId: FERRETRY_ID as LaneSet['projectId'],
  version: 3,
  confirmedBy: null,
  proposedBy: 'denisha',
  ...LANE_TEMPLATES.pr,
  ...overrides,
});

export const project = (overrides: Partial<BoardProject> = {}): BoardProject => ({
  id: FERRETRY_ID as BoardProject['id'],
  name: 'Ferretry',
  path: '/work/ferretry',
  laneSet: laneSet(),
  ...overrides,
});

export const otherProject = (overrides: Partial<BoardProject> = {}): BoardProject =>
  project({
    id: OTHER_ID as BoardProject['id'],
    name: 'Other',
    path: '/work/other',
    laneSet: laneSet({ projectId: OTHER_ID as LaneSet['projectId'], ...LANE_TEMPLATES.ops }),
    ...overrides,
  });

export const listing = (overrides: Partial<BoardProjectsResponse> = {}): BoardProjectsResponse => ({
  projects: [project({ id: 'unfiled' as BoardProject['id'], name: 'Unfiled', path: null, laneSet: null }), project()],
  current: null,
  ...overrides,
});

export const pr = (overrides: Partial<PrLink> = {}): PrLink =>
  PrLinkSchema.parse({
    url: 'https://github.com/kirinnee/ferretry/pull/42',
    number: 42,
    repo: 'kirinnee/ferretry',
    state: 'open',
    draft: false,
    checks: 'passing',
    mergedAt: null,
    mergeSha: null,
    releasedIn: null,
    polledAt: AT,
    ...overrides,
  });

export const mergedPr = (overrides: Partial<PrLink> = {}): PrLink =>
  pr({ state: 'merged', mergedAt: AT, mergeSha: 'a'.repeat(40), ...overrides });

const created = (): BoardTaskEvent => ({
  seq: 1,
  at: AT,
  actor: { kind: 'ferret', sessionId: DENISHA },
  type: 'created',
  laneId: 'todo',
});

/** A valid card, checked against the wire schema so a fixture can never drift from what the daemon sends. */
export const card = (overrides: Partial<BoardTaskView> = {}): BoardTaskView =>
  BoardTaskViewSchema.parse({
    v: 1,
    id: 'F1',
    machineId: 'mac',
    projectId: FERRETRY_ID,
    laneId: 'todo',
    kind: 'feature',
    title: 'Rename the widget',
    summary: '',
    ask: { text: 'rename it please', source: 'chat://1' },
    clarifications: [],
    premise: '',
    context: '',
    terms: [],
    brief: '',
    owner: DENISHA,
    assignee: null,
    parent: null,
    dependsOn: [],
    blocked: null,
    dropped: null,
    workflow: 'quick',
    links: { prs: [], branch: null, commits: [], docs: [] },
    files: [],
    order: null,
    createdAt: AT,
    createdBy: { kind: 'ferret', sessionId: DENISHA },
    history: [created()],
    lastTouchedAt: null,
    touchedBy: null,
    activity: 'idle',
    rollup: {
      children: 0,
      byCategory: { backlog: 0, active: 0, review: 0, shipped: 0, verify: 0, closed: 0 },
      active: 0,
      lastTouchedAt: null,
    },
    suggestedLane: null,
    waitingOnOwner: [],
    openAsks: [],
    blockedBy: [],
    blocks: [],
    shippedIn: null,
    ...overrides,
  });

export const counts = (overrides: Partial<BoardResponse['counts']> = {}): BoardResponse['counts'] => ({
  closedHidden: 0,
  stale: 0,
  orphaned: 0,
  active: 0,
  toTest: 0,
  waitingOnYou: 0,
  ...overrides,
});

export const response = (overrides: Partial<BoardResponse> = {}): BoardResponse =>
  BoardResponseSchema.parse({
    projectId: FERRETRY_ID,
    laneSet: laneSet(),
    cards: [],
    counts: counts(),
    nextCursor: null,
    quarantined: [],
    ...overrides,
  });

export const taskResponse = (task: BoardTaskView = card(), set: LaneSet | null = laneSet()): BoardTaskResponse => ({
  task,
  laneSet: set,
});
