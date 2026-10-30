import {
  type BoardResponse,
  type BoardTaskResponse,
  type BoardTaskView,
  BoardTaskViewSchema,
} from '@ferretry/protocol';
import { FERRETRY_ID, laneSet } from '../board-lanes/fixtures';

export { FERRETRY_ID, listing } from '../board-lanes/fixtures';

const AT = '2026-05-01T10:00:00.000Z';

/** A valid card on the Ferretry board; the schema parse keeps every fixture honest. */
export const card = (overrides: Partial<BoardTaskView> = {}): BoardTaskView =>
  BoardTaskViewSchema.parse({
    v: 1,
    id: 'F412',
    machineId: 'machine-1',
    projectId: FERRETRY_ID,
    laneId: 'todo',
    kind: 'feature',
    title: 'Rename the widget',
    summary: '',
    ask: { text: 'please rename it', source: 'chat://1' },
    clarifications: [],
    premise: '',
    context: '',
    terms: [],
    brief: '',
    owner: 'session-7',
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
    createdBy: { kind: 'ferret', sessionId: 'session-7' },
    history: [{ seq: 1, at: AT, actor: { kind: 'ferret', sessionId: 'session-7' }, type: 'created', laneId: 'todo' }],
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

export const taskResponse = (overrides: Partial<BoardTaskView> = {}): BoardTaskResponse => ({
  task: card(overrides),
  laneSet: laneSet(),
});

export const boardResponse = (cards: readonly BoardTaskView[] = [card()]): BoardResponse => ({
  projectId: FERRETRY_ID as BoardResponse['projectId'],
  laneSet: laneSet(),
  cards: [...cards],
  counts: { closedHidden: 3, stale: 1, orphaned: 0, active: 2, toTest: 0, waitingOnYou: 1 },
  nextCursor: null,
  quarantined: [],
});
