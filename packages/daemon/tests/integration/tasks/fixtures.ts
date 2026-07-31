import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task, TaskActivity, TaskErrorCode, TaskId, TaskKind, TaskStatus } from '@ferretry/protocol';
import should from 'should';
import { TaskError } from '../../../src/lib/tasks/task-error.ts';

export const INSTANT = '2026-07-30T12:00:00Z';
export const LATER_INSTANT = '2026-07-30T12:01:00Z';

/**
 * A fresh temp directory per test. Nothing here ever resolves a real state home — a task test that
 * touched the operator's board would be a broken test, not a thorough one.
 */
export const withTempRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'fy-tasks-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

/** Hands out pinned scratch names so a fault test can assert on the exact file that was cleaned up. */
export class FixedTempNameSource {
  private readonly names: readonly string[];
  private index = 0;

  constructor(names: readonly string[]) {
    this.names = names;
  }

  next(): string {
    const name = this.names[this.index % this.names.length];
    this.index += 1;
    return name ?? 'fallback';
  }
}

/** Asserts the call fails as a store error carrying the expected protocol code, not just any throw. */
export const shouldRefuse = (code: TaskErrorCode, act: () => unknown): void => {
  let thrown: unknown;
  try {
    act();
  } catch (error) {
    thrown = error;
  }
  should(thrown).be.instanceof(TaskError);
  should((thrown as TaskError).code).equal(code);
};

/** The async twin of {@link shouldRefuse}, for the store's promise-returning surface. */
export const shouldReject = async (code: TaskErrorCode, act: () => Promise<unknown>): Promise<void> => {
  let thrown: unknown;
  try {
    await act();
  } catch (error) {
    thrown = error;
  }
  should(thrown).be.instanceof(TaskError);
  should((thrown as TaskError).code).equal(code);
};

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

export const createdActivity = (
  overrides: { seq?: number; kind?: TaskKind; status?: TaskStatus } = {},
): TaskActivity => ({
  v: 1,
  seq: overrides.seq ?? 1,
  time: INSTANT,
  actor: 'wilfredo',
  actorName: 'Wilfredo',
  type: 'created',
  data: {
    status: overrides.status ?? 'todo',
    phase: 'todo',
    workflow: 'quick',
    kind: overrides.kind ?? 'feature',
    title: 'Ship the task store',
    askSource: 'human',
    dependsOn: [],
    reason: 'the human asked for it',
  },
});
