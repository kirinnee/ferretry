import type { TaskActivity, TaskLive, TaskSummary, TaskView } from '@ferretry/protocol';

/** A live block with nothing derived; individual tests override only what they exercise. */
export const quietLive: TaskLive = {
  assigneeSessionId: null,
  assigneeName: null,
  assigneeStatus: null,
  assigneeHealth: null,
  assigneeDoneMarker: false,
  assigneeLastActivityAt: null,
  staleness: null,
};

export function summary(overrides: Partial<TaskSummary> = {}): TaskSummary {
  const base: TaskSummary = {
    v: 1,
    id: 'F1',
    kind: 'feature',
    title: 'Rename the widget',
    workflow: 'quick',
    phase: 'todo',
    dependsOn: [],
    status: 'todo',
    statusReason: null,
    assignee: null,
    repo: null,
    files: [],
    links: { prs: [], branch: null, commits: [], docs: [] },
    order: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'human',
    updatedAt: '2026-01-02T00:00:00.000Z',
    live: quietLive,
    blocked: false,
    blockedReason: null,
    blockedSince: null,
    blockedBy: [],
    descriptionChars: 0,
    askChars: 12,
    askSource: 'chat://1',
    clarificationCount: 0,
  };
  return { ...base, ...overrides };
}

export function view(overrides: Partial<TaskView> = {}): TaskView {
  const base: TaskView = {
    v: 1,
    id: 'F1',
    kind: 'feature',
    title: 'Rename the widget',
    description: '',
    ask: { text: 'please rename it', source: 'chat://1' },
    clarifications: [],
    workflow: 'quick',
    phase: 'todo',
    dependsOn: [],
    status: 'todo',
    statusReason: null,
    assignee: null,
    repo: null,
    files: [],
    links: { prs: [], branch: null, commits: [], docs: [] },
    order: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'human',
    updatedAt: '2026-01-02T00:00:00.000Z',
    live: quietLive,
    blocked: false,
    blockedReason: null,
    blockedSince: null,
    blockedBy: [],
  };
  return { ...base, ...overrides };
}

export function noteActivity(overrides: Partial<Extract<TaskActivity, { type: 'note' }>> = {}): TaskActivity {
  return {
    v: 1,
    seq: 1,
    time: '2026-01-02T00:00:00.000Z',
    actor: 'agent-1',
    actorName: null,
    type: 'note',
    data: { text: 'looked at it' },
    ...overrides,
  };
}
