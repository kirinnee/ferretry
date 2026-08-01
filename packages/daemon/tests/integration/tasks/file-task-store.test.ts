import { describe, it } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { AtomicFileWriter } from '../../../src/adapters/tasks/atomic-file.ts';
import { SystemInstantSource } from '../../../src/adapters/tasks/file-operations.ts';
import { FileTaskStore } from '../../../src/adapters/tasks/file-task-store.ts';
import { KeyedSerialExecutor } from '../../../src/adapters/tasks/serial-executor.ts';
import { TaskRecordService } from '../../../src/adapters/tasks/task-record-service.ts';
import { ApiDispatcher } from '../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../src/lib/api/router.ts';
import { taskRoutes, type TaskSubsystem } from '../../../src/lib/runtime/mounts/tasks.ts';
import { TaskStateUnavailableError } from '../../../src/lib/tasks/task-error.ts';
import type { TaskSnapshot } from '../../../src/lib/tasks/task-snapshot.ts';
import { jsonBody, request } from '../../unit/api/support.ts';
import { CREDENTIALS, human } from '../../unit/runtime/mounts/support.ts';
import { createdActivity, INSTANT, shouldReject, task, withTempRoot } from './fixtures.ts';

const SESSION = 'session-alpha';

const boardPath = (root: string): string => join(root, 'boards', SESSION, 'tasks.json');

const snapshot = (...ids: readonly string[]): TaskSnapshot => ({
  v: 1,
  tasks: ids.map(id => ({ task: task({ id: id as never }), activity: [createdActivity()] })),
});

/**
 * A genuinely damaged board: the first entry is missing everything the decoder needs, the second is
 * a perfectly good task. This is the harder shape of damage — the file still parses as JSON, so only
 * the per-entry check stands between a half-read board and a caller that would trust it.
 */
const DAMAGED_BOARD = JSON.stringify({
  v: 1,
  tasks: [{ task: { id: 'F1' } }, { task: task(), activity: [createdActivity()] }],
});

/**
 * Asserts the call fails as a PERSISTENCE refusal.
 *
 * Deliberately not `shouldReject`, which asserts a `TaskError` carrying a protocol code: a damaged
 * snapshot is not in that taxonomy at all, and asserting it there is what let the mount answer 400.
 */
const shouldBeUnavailable = async (act: () => Promise<unknown>): Promise<void> => {
  let thrown: unknown;
  try {
    await act();
  } catch (error) {
    thrown = error;
  }
  should(thrown).be.instanceof(TaskStateUnavailableError);
  should((thrown as TaskStateUnavailableError).code).equal('unavailable');
};

/** Writes `content` as the board's authoritative snapshot, creating the board directory for it. */
const writeBoard = async (root: string, content: string): Promise<string> => {
  const path = boardPath(root);
  await mkdir(join(root, 'boards', SESSION), { recursive: true });
  await writeFile(path, content);
  return path;
};

/**
 * The daemon's real task routes over a real file-backed board.
 *
 * Nothing here is a double: the router, the dispatcher, the record service and the store are the
 * production ones, and the only thing under the test's control is the bytes on disk. That is what
 * makes the status assertions below evidence about the daemon rather than about a fixture.
 */
const mountedOver = (path: string): ApiDispatcher => {
  const board = new TaskRecordService(SESSION, new FileTaskStore(path), { now: () => INSTANT });
  const subsystem: TaskSubsystem = {
    board: () => board,
    sessionIds: async () => [SESSION],
    observe: async () => new Map(),
    now: () => INSTANT,
  };
  return new ApiDispatcher(new ApiRouter(taskRoutes(subsystem)), CREDENTIALS);
};

describe('FileTaskStore', () => {
  it('should read an empty board before anything has ever been written', async () => {
    await withTempRoot(async root => {
      // Arrange
      const store = new FileTaskStore(boardPath(root));

      // Act
      const actual = await store.read();

      // Assert
      should(actual).eql({ v: 1, tasks: [] });
    });
  });

  it('should create the private board directory on the first write', async () => {
    await withTempRoot(async root => {
      // Arrange
      const store = new FileTaskStore(boardPath(root));

      // Act
      await store.transact(() => ({ container: snapshot('F1'), result: 'written' }));

      // Assert
      const written = await readFile(boardPath(root), 'utf8');
      should(JSON.parse(written).tasks).have.length(1);
      should(written.endsWith('\n')).be.true();
    });
  });

  it('should return the reducer result while committing the whole container', async () => {
    await withTempRoot(async root => {
      // Arrange
      const store = new FileTaskStore(boardPath(root));

      // Act
      const actual = await store.transact(() => ({ container: snapshot('F1', 'F2'), result: 42 }));

      // Assert
      should(actual).equal(42);
      should((await store.read()).tasks.map(entry => entry.task.id)).eql(['F1', 'F2']);
    });
  });

  it('should show every transaction the state its predecessor committed', async () => {
    await withTempRoot(async root => {
      // Arrange
      const store = new FileTaskStore(boardPath(root));
      const seen: number[] = [];

      // Act — scheduled together, so an unserialised store would let both read the same state
      await Promise.all([
        store.transact(current => {
          seen.push(current.tasks.length);
          return { container: snapshot('F1'), result: null };
        }),
        store.transact(current => {
          seen.push(current.tasks.length);
          return { container: snapshot('F1', 'F2'), result: null };
        }),
      ]);

      // Assert
      should(seen).eql([0, 1]);
      should((await store.read()).tasks).have.length(2);
    });
  });

  it('should diagnose a damaged entry but refuse to use or rewrite the partial board', async () => {
    await withTempRoot(async root => {
      // Arrange
      const damaged = DAMAGED_BOARD;
      const path = await writeBoard(root, damaged);
      const store = new FileTaskStore(path);

      // Act
      const decoded = await store.readDecoded();

      // Assert — diagnostics retain the healthy entry, but no authoritative caller can mistake the
      // partial snapshot for the whole board or replace the damaged evidence with its clean subset.
      should(decoded.fatal).be.false();
      should(decoded.snapshot.tasks).have.length(1);
      should(decoded.parseErrors).have.length(1);
      await shouldBeUnavailable(() => store.read());
      await shouldBeUnavailable(() => store.transact(() => ({ container: snapshot('F2'), result: null })));
      should(await readFile(path, 'utf8')).equal(damaged);
    });
  });

  it('should refuse to mutate a board it could not read, preserving the evidence', async () => {
    await withTempRoot(async root => {
      // Arrange
      const path = await writeBoard(root, 'not json at all');
      const store = new FileTaskStore(path);

      // Act & Assert
      await shouldBeUnavailable(() => store.transact(() => ({ container: snapshot('F1'), result: null })));
      should(await readFile(path, 'utf8')).equal('not json at all');
    });
  });

  it('should refuse to persist a container the protocol rejects, leaving the board intact', async () => {
    await withTempRoot(async root => {
      // Arrange
      const path = boardPath(root);
      const store = new FileTaskStore(path);
      await store.transact(() => ({ container: snapshot('F1'), result: null }));
      const before = await readFile(path, 'utf8');

      // Act & Assert
      await shouldReject('ambiguous', () => store.transact(() => ({ container: snapshot('F1', 'F1'), result: null })));
      should(await readFile(path, 'utf8')).equal(before);
    });
  });

  it('should keep serving later transactions after one of them fails', async () => {
    await withTempRoot(async root => {
      // Arrange
      const store = new FileTaskStore(boardPath(root));

      // Act
      const failure = store.transact(() => {
        throw new Error('reducer exploded');
      });
      const recovery = store.transact(() => ({ container: snapshot('F1'), result: 'ok' }));

      // Assert
      await failure.catch(() => undefined);
      should(await recovery).equal('ok');
    });
  });

  it('should reject an absolute-path requirement rather than resolving against a process cwd', async () => {
    // Arrange
    const store = new FileTaskStore('relative/tasks.json');

    // Act & Assert
    await shouldReject('invalid', () => store.read());
  });

  it('should stamp instants from its injected source', async () => {
    await withTempRoot(async root => {
      // Arrange
      const store = new FileTaskStore(boardPath(root), { instants: { now: () => '2026-07-30T12:00:00Z' } });

      // Act
      const actual = store.now();

      // Assert
      should(actual).equal('2026-07-30T12:00:00Z');
    });
  });

  it('should default to real collaborators when none are injected', async () => {
    await withTempRoot(async root => {
      // Arrange
      const store = new FileTaskStore(boardPath(root), {
        writer: new AtomicFileWriter(),
        executor: new KeyedSerialExecutor(),
        instants: new SystemInstantSource(),
      });

      // Act
      await store.transact(() => ({ container: snapshot('F1'), result: null }));

      // Assert — a real ISO instant, not a fixture
      should(Number.isNaN(Date.parse(store.now()))).be.false();
      should((await store.read()).tasks).have.length(1);
    });
  });
});

/**
 * What a damaged board on disk answers over HTTP.
 *
 * The store's refusal only matters if it survives the mount, and the mount is where it was being
 * mistranslated: a corrupt snapshot came out as `TaskError('invalid')`, which the status table
 * answers 400, telling an operator their perfectly well-formed request was wrong. These drive the
 * real routes over a real file so nothing but the bytes on disk is a fixture.
 */
describe('the task mount over a damaged snapshot', () => {
  it('should answer a task read with a server-side status, never the caller’s fault', async () => {
    await withTempRoot(async root => {
      // Arrange
      const dispatch = mountedOver(await writeBoard(root, DAMAGED_BOARD));

      // Act
      const response = await dispatch.dispatch(request({ path: `/v1/sessions/${SESSION}/tasks/F1`, headers: human }));

      // Assert
      should(response.status).equal(503);
      should(response.status).not.equal(400);
      should(jsonBody(response)).have.property('code', 'unavailable');
    });
  });

  it('should answer a write against a damaged board the same way, and leave the evidence alone', async () => {
    await withTempRoot(async root => {
      // Arrange
      const path = await writeBoard(root, 'not json at all');
      const dispatch = mountedOver(path);

      // Act
      const response = await dispatch.dispatch(
        request({
          method: 'POST',
          path: `/v1/sessions/${SESSION}/tasks`,
          headers: { ...human, 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'feature',
            title: 'Wire the boards',
            ask: { text: 'wire it', source: 'human' },
          }),
        }),
      );

      // Assert
      should(response.status).equal(503);
      should(jsonBody(response)).have.property('code', 'unavailable');
      // The refusal must not have replaced the corrupt board with an apparently healthy one.
      should(await readFile(path, 'utf8')).equal('not json at all');
    });
  });

  it('should still call a request the caller got wrong a bad request', async () => {
    await withTempRoot(async root => {
      // A damaged board must not turn every answer into a 5xx: an unknown filter is still 400.
      // Arrange
      const dispatch = mountedOver(await writeBoard(root, DAMAGED_BOARD));

      // Act
      const response = await dispatch.dispatch(
        request({ path: `/v1/sessions/${SESSION}/tasks`, headers: human, query: [['owner', 'ossy']] }),
      );

      // Assert
      should(response.status).equal(400);
      should(jsonBody(response)).have.property('code', 'unknown_filter');
    });
  });
});
