import { describe, it } from 'bun:test';
import type { Task, TaskActivity } from '@ferretry/protocol';
import should from 'should';
import {
  decodeTaskSnapshot,
  parseTaskSnapshot,
  TASK_SNAPSHOT_SCHEMA_VERSION,
  type TaskEntry,
} from '../../../src/lib/board-import/legacy-snapshot.ts';

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

describe('legacy task snapshot decoding', () => {
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
    should(actual.snapshot).deepEqual({ v: TASK_SNAPSHOT_SCHEMA_VERSION, tasks: [] });
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

  it('should decode prior-release blocked human attestations without dropping later history', () => {
    // Previous daemons wrote both of these truthful-to-their-model shapes without the new positive
    // semantics stamp. They are evidence, not corruption: dropping the first would also make the
    // following sequence look gapped and turn a readable board into an unavailable one.
    // Arrange
    const blockedClear = {
      v: 1,
      seq: 2,
      time: '2026-07-30T18:00:00.000Z',
      actor: 'admin-cli',
      actorName: null,
      type: 'status',
      data: {
        from: 'blocked',
        to: 'researched',
        phaseFrom: 'research',
        phaseTo: 'research',
        reason: 'unblocked',
        approvedByHuman: true,
      },
    };
    const blockedCompletion = {
      v: 1,
      seq: 2,
      time: '2026-07-30T18:00:00.000Z',
      actor: 'admin-cli',
      actorName: null,
      type: 'status',
      data: {
        from: 'blocked',
        to: 'done',
        phaseFrom: 'live',
        phaseTo: 'done',
        reason: 'validated after unblock',
        verifiedByHuman: true,
      },
    };
    const input = {
      v: 1,
      tasks: [
        {
          task: task({ workflow: 'research-first', phase: 'research', status: 'blocked', statusReason: 'waiting' }),
          activity: [activity(1), blockedClear],
        },
        {
          task: task({
            id: 'F2' as Task['id'],
            phase: 'done',
            status: 'done',
            statusReason: 'validated after unblock',
          }),
          activity: [activity(1), blockedCompletion],
        },
      ],
    };

    // Act
    const actual = decodeTaskSnapshot(input);

    // Assert — v1 remains a readable migration input; the current reader normalizes the outer
    // container to v2 only after preserving every actual history entry.
    should(actual).containEql({ fatal: false, parseErrors: [] });
    should(actual.snapshot.v).equal(TASK_SNAPSHOT_SCHEMA_VERSION);
    should(actual.snapshot.tasks[0]?.activity[1]).deepEqual(blockedClear);
    should(actual.snapshot.tasks[1]?.activity[1]).deepEqual(blockedCompletion);
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
