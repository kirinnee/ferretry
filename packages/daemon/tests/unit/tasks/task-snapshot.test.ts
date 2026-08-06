import { describe, it } from 'bun:test';
import type { Task, TaskActivity } from '@ferretry/protocol';
import should from 'should';
import { TaskError } from '../../../src/lib/tasks/task-error.ts';
import {
  decodeTaskSnapshot,
  emptyTaskSnapshot,
  parseTaskSnapshot,
  serializeTaskSnapshot,
  TASK_SNAPSHOT_SCHEMA_VERSION,
  validateTaskEntry,
  validateTaskSnapshot,
  type TaskEntry,
  type TaskSnapshot,
} from '../../../src/lib/tasks/task-snapshot.ts';

const task = (overrides: Partial<Task> = {}): Task => ({
  v: 1,
  id: 'F1',
  kind: 'feature',
  title: 'Build task core',
  description: '',
  ask: { text: 'Build it', source: 'message:1' },
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
  createdAt: '2026-07-30T18:00:00.000Z',
  createdBy: 'actor-1',
  updatedAt: '2026-07-30T18:00:00.000Z',
  ...overrides,
});

const activity = (seq = 1): TaskActivity => ({
  v: 1,
  seq,
  time: '2026-07-30T18:00:00.000Z',
  actor: 'actor-1',
  actorName: null,
  type: 'note',
  data: { text: `note ${seq}` },
});

const entry = (overrides: Partial<Task> = {}, history: readonly TaskActivity[] = [activity()]): TaskEntry => ({
  task: task(overrides),
  activity: history,
});

describe('task snapshot decoding', () => {
  it('should decode a valid snapshot into fresh protocol-validated values', () => {
    // Arrange
    const input = { v: 1, tasks: [entry()] };

    // Act
    const actual = decodeTaskSnapshot(input);

    // Assert
    should(actual.fatal).be.false();
    should(actual.parseErrors).deepEqual([]);
    should(actual.snapshot).deepEqual({ v: TASK_SNAPSHOT_SCHEMA_VERSION, tasks: [entry()] });
    should(actual.snapshot).not.equal(input);
    should(actual.snapshot.tasks[0]).not.equal(input.tasks[0]);
  });

  it.each([
    { input: null, detail: 'not an object' },
    { input: [], detail: 'not an object' },
    { input: { v: 0, tasks: [] }, detail: 'version is unknown' },
    { input: { v: 1 }, detail: 'no task list' },
  ])('should reject a fatal snapshot whose shape is $detail', ({ input, detail }) => {
    // Act
    const actual = decodeTaskSnapshot(input);

    // Assert
    should(actual.fatal).be.true();
    should(actual.snapshot).deepEqual(emptyTaskSnapshot());
    should(actual.parseErrors[0]?.detail).containEql(detail);
  });

  it('should retain valid tasks while reporting malformed and duplicate records', () => {
    // Arrange
    const input = { v: 1, tasks: [entry(), entry(), { task: { id: 'F2' }, activity: [] }] };

    // Act
    const actual = decodeTaskSnapshot(input);

    // Assert
    should(actual.fatal).be.false();
    should(actual.snapshot.tasks).have.length(1);
    should(actual.parseErrors).have.length(2);
    should(actual.parseErrors.map(value => value.detail)).deepEqual([
      'duplicate task id in snapshot',
      'malformed task record',
    ]);
  });

  it('should retain only the gap-free activity prefix and report later gaps', () => {
    // Arrange
    const input = { v: 1, tasks: [entry({}, [activity(1), activity(3), activity(2)])] };

    // Act
    const actual = decodeTaskSnapshot(input);

    // Assert
    should(actual.snapshot.tasks[0]?.activity.map(value => value.seq)).deepEqual([1, 2]);
    should(actual.parseErrors).have.length(1);
    should(actual.parseErrors[0]?.detail).containEql('expected gap-free seq 2');
  });

  it('should keep a task whose history is not a list at all, reporting the loss', () => {
    // Arrange
    const input = { v: 1, tasks: [{ task: task(), activity: 'gone' }] };

    // Act
    const actual = decodeTaskSnapshot(input);

    // Assert — the record survives; only its unreadable history is dropped
    should(actual.snapshot.tasks).have.length(1);
    should(actual.snapshot.tasks[0]?.activity).be.empty();
    should(actual.parseErrors).deepEqual([{ scope: 'activity', taskId: 'F1', detail: 'activity is not an array' }]);
  });

  it('should drop a malformed history entry and report it against its task', () => {
    // Arrange
    const input = { v: 1, tasks: [entry({}, [{ ...activity(1), type: 'nonsense' } as unknown as TaskActivity])] };

    // Act
    const actual = decodeTaskSnapshot(input);

    // Assert
    should(actual.snapshot.tasks[0]?.activity).be.empty();
    should(actual.parseErrors[0]).deepEqual({
      scope: 'activity',
      taskId: 'F1',
      detail: 'activity seq 1 is malformed',
    });
  });

  it('should report invalid JSON without throwing', () => {
    // Act
    const actual = parseTaskSnapshot('{');

    // Assert
    should(actual.fatal).be.true();
    should(actual.parseErrors[0]?.detail).equal('task snapshot is not valid JSON');
  });
});

describe('task snapshot validation and serialization', () => {
  it('should round-trip the pure snapshot without session or board placement fields', () => {
    // Arrange
    const input: TaskSnapshot = { v: TASK_SNAPSHOT_SCHEMA_VERSION, tasks: [entry()] };

    // Act
    const serialized = serializeTaskSnapshot(input);
    const actual = parseTaskSnapshot(serialized);

    // Assert
    should(serialized).not.containEql('sessionId');
    should(serialized).not.containEql('mutationGeneration');
    should(actual).deepEqual({ snapshot: input, parseErrors: [], fatal: false });
  });

  it('should reject invalid task values before persistence', () => {
    // Arrange
    const input = entry({ title: 'This task title has too many words' });

    // Act + Assert
    should(() => validateTaskEntry(input)).throw(TaskError);
  });

  it('should refuse to persist an entry whose history does not satisfy the protocol', () => {
    // Arrange
    const input = entry({}, [{ ...activity(1), type: 'nonsense' } as unknown as TaskActivity]);

    // Act + Assert
    should(() => validateTaskEntry(input)).throw(/refusing to persist invalid activity/u);
  });

  it('should reject activity that is not gap-free', () => {
    // Arrange
    const input = entry({}, [activity(2)]);

    // Act + Assert
    should(() => validateTaskEntry(input)).throw(/expected gap-free seq 1/u);
  });

  it('should reject duplicate task IDs in an outgoing snapshot', () => {
    // Arrange
    const input: TaskSnapshot = { v: TASK_SNAPSHOT_SCHEMA_VERSION, tasks: [entry(), entry()] };

    // Act + Assert
    should(() => validateTaskSnapshot(input)).throw(TaskError);
    should(() => validateTaskSnapshot(input)).throw(/exists more than once/u);
  });
});
