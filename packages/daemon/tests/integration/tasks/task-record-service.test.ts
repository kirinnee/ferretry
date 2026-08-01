import { describe, it } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskCreateRequestInput } from '@ferretry/protocol';
import should from 'should';
import { FileTaskStore } from '../../../src/adapters/tasks/file-task-store.ts';
import { TaskRecordService } from '../../../src/adapters/tasks/task-record-service.ts';
import { TASK_UNAVAILABLE_MESSAGE, TaskStateUnavailableError } from '../../../src/lib/tasks/task-error.ts';
import type { TaskActor } from '../../../src/lib/tasks/task-policy.ts';
import { INSTANT, LATER_INSTANT, shouldRefuse, shouldReject, withTempRoot } from './fixtures.ts';

const SESSION_ID = 'session-alpha';

const AGENT: TaskActor = { kind: 'agent', id: 'wilfredo', name: 'Wilfredo', sessionId: SESSION_ID };
const OPERATOR: TaskActor = { kind: 'human', id: 'operator', name: 'Operator', sessionId: null };

const request = (overrides: Partial<TaskCreateRequestInput> = {}): TaskCreateRequestInput => ({
  kind: 'feature',
  title: 'Ship the board',
  ask: { text: 'ship it', source: 'human:cli' },
  ...overrides,
});

/** A service over a real file board in a temp directory — never the operator's state home. */
const withService = async (
  run: (service: TaskRecordService, path: string) => Promise<void>,
  instants: () => string = () => INSTANT,
): Promise<void> => {
  await withTempRoot(async root => {
    const path = join(root, 'boards', SESSION_ID, 'tasks.json');
    await run(new TaskRecordService(SESSION_ID, new FileTaskStore(path), { now: instants }), path);
  });
};

describe('TaskRecordService', () => {
  it('should refuse to serve a board without a session', () => {
    // Act & Assert
    shouldRefuse('invalid', () => new TaskRecordService('   ', new FileTaskStore('/tmp/unused.json')));
  });

  it('should create a task, persist it, and read it back after a restart', async () => {
    await withService(async (service, path) => {
      // Act
      const created = await service.create(request(), AGENT);
      const reopened = new TaskRecordService(SESSION_ID, new FileTaskStore(path));
      const reread = await reopened.detail('f1');

      // Assert
      should(created.task.id).equal('F1');
      should(reread.task).eql(created.task);
      should(reread.activity.map(item => item.type)).eql(['created']);
    });
  });

  it('should write the record and its history in one atomic replacement', async () => {
    await withService(async (service, path) => {
      // Arrange
      await service.create(request(), AGENT);

      // Act
      const noted = await service.act('F1', { action: 'note', text: 'started looking' }, AGENT);

      // Assert — one file holds both, so no interrupt can separate them
      const persisted = JSON.parse(await readFile(path, 'utf8')) as {
        tasks: { activity: { type: string }[] }[];
      };
      should(noted.activity).have.length(2);
      should(persisted.tasks[0]?.activity.map(item => item.type)).eql(['created', 'note']);
    });
  });

  it('should serialise concurrent creates so identifiers never collide', async () => {
    await withService(async service => {
      // Act
      const created = await Promise.all([
        service.create(request({ kind: 'feature' }), AGENT),
        service.create(request({ kind: 'feature' }), AGENT),
        service.create(request({ kind: 'bug', title: 'Fix the drift' }), AGENT),
      ]);

      // Assert
      should(created.map(entry => entry.task.id).sort()).eql(['B1', 'F1', 'F2']);
      should((await service.list()).entries).have.length(3);
    });
  });

  it('should list the board in the deterministic board order', async () => {
    await withService(async service => {
      // Arrange
      await service.create(request({ title: 'Second' }), AGENT);
      await service.create(request({ title: 'First' }), AGENT);
      await service.act('F2', { action: 'phase', phase: 'build', reason: 'started' }, AGENT);

      // Act
      const listed = await service.list();

      // Assert — in_progress outranks todo regardless of insertion order
      should(listed.entries.map(entry => entry.task.id)).eql(['F2', 'F1']);
    });
  });

  it('should refuse to list a board with one unreadable record, rather than list the rest', async () => {
    // This used to answer with the entries it could decode and a count of what it dropped. A board
    // one task short reads exactly like a board that is one task short — it is what a human plans
    // against — so the whole list is refused and the damaged file is left for an operator to repair.
    await withService(async (service, path) => {
      // Arrange
      await service.create(request(), AGENT);
      const board = JSON.parse(await readFile(path, 'utf8')) as { v: number; tasks: unknown[] };
      board.tasks.push({ task: { id: 'nonsense' }, activity: [] });
      const damaged = JSON.stringify(board);
      await writeFile(path, damaged);

      // Act
      let thrown: unknown;
      try {
        await service.list();
      } catch (error) {
        thrown = error;
      }

      // Assert
      should(thrown).be.instanceof(TaskStateUnavailableError);
      should((thrown as TaskStateUnavailableError).code).equal('unavailable');
      // The client-facing message never names the file; the operator's evidence is on `detail`.
      should((thrown as TaskStateUnavailableError).message).equal(TASK_UNAVAILABLE_MESSAGE);
      should((thrown as TaskStateUnavailableError).detail).containEql(path);
      // The decoder's partial view is still there for an operator, just not as an answer.
      const decoded = await new FileTaskStore(path).readDecoded();
      should(decoded.snapshot.tasks).have.length(1);
      should(decoded.parseErrors.map(issue => issue.detail)).eql(['malformed task record']);
      should(await readFile(path, 'utf8')).equal(damaged);
    });
  });

  it('should carry a task through its whole quick workflow', async () => {
    await withService(async service => {
      // Arrange
      await service.create(request(), AGENT);

      // Act
      await service.act('F1', { action: 'phase', phase: 'build', reason: 'started' }, AGENT);
      await service.act('F1', { action: 'status', status: 'built', reason: 'code is written' }, AGENT);
      await service.act('F1', { action: 'phase', phase: 'live', reason: 'deployed' }, AGENT);
      const done = await service.act('F1', { action: 'status', status: 'done', reason: 'verified' }, OPERATOR);

      // Assert
      should(done.task.phase).equal('done');
      should(done.task.statusReason).equal('verified');
      should(done.activity.map(item => item.seq)).eql([1, 2, 3, 4, 5]);
    });
  });

  it('should reopen shipped work with its new ask in a single transaction', async () => {
    await withService(async (service, path) => {
      // Arrange
      await service.create(request(), AGENT);
      await service.act('F1', { action: 'phase', phase: 'build', reason: 'started' }, AGENT);
      await service.act('F1', { action: 'status', status: 'built', reason: 'written' }, AGENT);

      // Act
      const reopened = await service.act(
        'F1',
        { action: 'reopen', reason: 'a defect', ask: 'the last row is dropped', source: 'human:cli' },
        AGENT,
      );

      // Assert
      should(reopened.task.phase).equal('build');
      should(reopened.task.clarifications).have.length(1);
      const persisted = JSON.parse(await readFile(path, 'utf8')) as {
        tasks: { task: { clarifications: unknown[] }; activity: { type: string }[] }[];
      };
      should(persisted.tasks[0]?.task.clarifications).have.length(1);
      should(persisted.tasks[0]?.activity.map(item => item.type)).eql([
        'created',
        'status',
        'status',
        'clarification',
        'status',
      ]);
    });
  });

  it('should refuse an agent writing another session board and leave it untouched', async () => {
    await withService(async (service, path) => {
      // Arrange
      await service.create(request(), AGENT);
      const before = await readFile(path, 'utf8');
      const intruder: TaskActor = { kind: 'agent', id: 'mallory', name: null, sessionId: 'session-beta' };

      // Act & Assert
      await shouldReject('forbidden', () => service.create(request(), intruder));
      await shouldReject('forbidden', () => service.act('F1', { action: 'note', text: 'mine now' }, intruder));
      should(await readFile(path, 'utf8')).equal(before);
    });
  });

  it('should let the daemon itself write any board it is handed', async () => {
    await withService(async service => {
      // Arrange
      const daemon: TaskActor = { kind: 'daemon', id: 'fyd', name: null, sessionId: null };

      // Act
      const created = await service.create(request(), daemon);

      // Assert
      should(created.task.createdBy).equal('fyd');
    });
  });

  it('should refuse an unknown task without writing anything', async () => {
    await withService(async (service, path) => {
      // Arrange
      await service.create(request(), AGENT);
      const before = await readFile(path, 'utf8');

      // Act & Assert
      await shouldReject('not-found', () => service.detail('F9'));
      await shouldReject('not-found', () => service.act('F9', { action: 'note', text: 'hello' }, AGENT));
      should(await readFile(path, 'utf8')).equal(before);
    });
  });

  it('should refuse a cycle across two persisted tasks', async () => {
    await withService(async service => {
      // Arrange
      await service.create(request(), AGENT);
      await service.create(request({ title: 'Second thing' }), AGENT);
      await service.act('F1', { action: 'dependency', taskId: 'F2' }, AGENT);

      // Act & Assert
      await shouldReject('cycle', () => service.act('F2', { action: 'dependency', taskId: 'F1' }, AGENT));
      should((await service.detail('F2')).task.dependsOn).be.empty();
    });
  });

  it('should let two tasks claim the same file, because claims are advisory', async () => {
    await withService(async service => {
      // Arrange
      await service.create(request({ files: ['src/a.ts'] }), AGENT);
      await service.create(request({ title: 'Second thing' }), AGENT);

      // Act
      const second = await service.act('F2', { action: 'file', path: 'src/a.ts', reason: 'also here' }, AGENT);

      // Assert
      should(second.task.files).eql(['src/a.ts']);
      should((await service.detail('F1')).task.files).eql(['src/a.ts']);
    });
  });

  it('should stamp every mutation with the instant its source supplied', async () => {
    let instant = INSTANT;
    await withService(
      async service => {
        // Arrange
        const created = await service.create(request(), AGENT);
        instant = LATER_INSTANT;

        // Act
        const noted = await service.act('F1', { action: 'note', text: 'later' }, AGENT);

        // Assert
        should(created.task.createdAt).equal(INSTANT);
        should(noted.task.updatedAt).equal(LATER_INSTANT);
        should(noted.activity[1]?.time).equal(LATER_INSTANT);
      },
      () => instant,
    );
  });

  it('should default to the system clock when no instant source is injected', async () => {
    await withTempRoot(async root => {
      // Arrange
      const path = join(root, 'boards', SESSION_ID, 'tasks.json');
      await mkdir(join(root, 'boards', SESSION_ID), { recursive: true });
      const service = new TaskRecordService(SESSION_ID, new FileTaskStore(path));

      // Act
      const created = await service.create(request(), AGENT);

      // Assert
      should(Number.isNaN(Date.parse(created.task.createdAt))).be.false();
    });
  });
});
