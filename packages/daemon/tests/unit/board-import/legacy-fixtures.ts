import type { Task, TaskId } from '@ferretry/protocol';
import { TASK_SNAPSHOT_SCHEMA_VERSION, type TaskSnapshot } from '../../../src/lib/board-import/legacy-snapshot.ts';

const INSTANT = '2026-07-30T12:00:00Z';

export const task = (overrides: Partial<Task> = {}): Task => ({
  v: 1,
  id: 'F1' as TaskId,
  kind: 'feature',
  title: 'Ship the task store',
  description: 'A durable session board.',
  ask: { text: 'build the store', source: 'human' },
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
  createdAt: INSTANT,
  createdBy: 'wilfredo',
  updatedAt: INSTANT,
  ...overrides,
});

/** A board holding exactly these tasks, each with the minimum history the schema accepts. */
export const snapshotOf = (...tasks: readonly Task[]): TaskSnapshot => ({
  v: TASK_SNAPSHOT_SCHEMA_VERSION,
  tasks: tasks.map(record => ({
    task: record,
    activity: [
      {
        v: 1,
        seq: 1,
        time: INSTANT,
        actor: 'wilfredo',
        actorName: 'Wilfredo',
        type: 'created',
        data: {
          status: record.status,
          phase: record.phase,
          workflow: record.workflow,
          kind: record.kind,
          title: record.title,
          askSource: record.ask.source,
          dependsOn: [...record.dependsOn],
          reason: record.statusReason ?? 'Task created.',
        },
      },
    ],
  })),
});

/** The bytes an old daemon left in `sessions/<id>/tasks.json`, for the importer to read back. */
export const serializeLegacySnapshot = (snapshot: TaskSnapshot): string => `${JSON.stringify(snapshot, null, 2)}\n`;
