import type { BoardActor, Task, TaskActivity, TaskStatus, TaskPhase } from '@ferretry/protocol';
import type { TaskEntry } from '../../../src/lib/board-import/legacy-snapshot.ts';

const SESSION = 'lead';
export const WHEN = '2026-10-01T10:00:00.000Z';
export const LATER = '2026-10-02T10:00:00.000Z';

const PHASE_OF: Readonly<Record<Exclude<TaskStatus, 'blocked'>, TaskPhase>> = {
  todo: 'todo',
  researched: 'research',
  designed: 'design',
  in_progress: 'build',
  built: 'built',
  live: 'live',
  done: 'done',
  dropped: 'dropped',
};

const phaseOf = (status: Exclude<TaskStatus, 'blocked'>): TaskPhase => PHASE_OF[status];

/** An old task, coherent unless told otherwise. */
export const oldTask = (overrides: Partial<Task> = {}): Task => ({
  v: 1,
  id: 'F1',
  kind: 'feature',
  title: 'Ship the thing',
  description: 'details',
  ask: { text: 'ship it', source: 'human' },
  clarifications: [],
  workflow: 'design-first',
  phase: 'todo',
  dependsOn: [],
  status: 'todo',
  statusReason: null,
  assignee: null,
  repo: null,
  files: [],
  links: { prs: [], branch: null, commits: [], docs: [] },
  order: null,
  createdAt: WHEN,
  createdBy: SESSION,
  updatedAt: LATER,
  ...overrides,
});

/** An old task at a status, with the phase that status means. */
export const taskAt = (status: Exclude<TaskStatus, 'blocked'>, overrides: Partial<Task> = {}): Task =>
  oldTask({ status, phase: phaseOf(status), ...overrides });

const base = (seq: number, actor = SESSION, time = WHEN) => ({ v: 1 as const, seq, time, actor, actorName: null });

export const createdAct = (task: Task, seq = 1): TaskActivity => ({
  ...base(seq, task.createdBy ?? SESSION, task.createdAt),
  type: 'created',
  data: {
    status: task.status,
    phase: task.phase,
    workflow: task.workflow,
    kind: task.kind,
    title: task.title,
    askSource: task.ask.source,
    dependsOn: [...task.dependsOn],
    reason: 'Task created.',
  },
});

export const statusAct = (
  seq: number,
  from: TaskStatus,
  to: TaskStatus,
  phaseTo: TaskPhase,
  extra: { reason?: string; reopened?: true; actor?: string; time?: string } = {},
): TaskActivity => ({
  ...base(seq, extra.actor, extra.time ?? LATER),
  type: 'status',
  data: {
    from,
    to,
    phaseFrom: 'todo',
    phaseTo,
    reason: extra.reason ?? 'because',
    ...(extra.reopened === true ? { reopened: true as const } : {}),
  },
});

export const noteAct = (seq: number, text: string, actor = SESSION): TaskActivity => ({
  ...base(seq, actor),
  type: 'note',
  data: { text },
});

/** An entry holding a task and its creating activity plus `more`. */
export const entryOf = (task: Task, more: readonly TaskActivity[] = []): TaskEntry => ({
  task,
  activity: [createdAct(task), ...more],
});

const owner: BoardActor = { kind: 'owner' };
export const daemonActor: BoardActor = { kind: 'daemon' };
export const actorOf = (raw: string | null): BoardActor =>
  raw === null || raw === 'daemon' ? daemonActor : raw === 'human' ? owner : { kind: 'ferret', sessionId: raw };
