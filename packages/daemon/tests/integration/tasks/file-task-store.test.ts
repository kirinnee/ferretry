import { describe, it } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { AtomicFileWriter } from '../../../src/adapters/tasks/atomic-file.ts';
import { SystemInstantSource } from '../../../src/adapters/tasks/file-operations.ts';
import { FileTaskStore } from '../../../src/adapters/tasks/file-task-store.ts';
import { KeyedSerialExecutor } from '../../../src/adapters/tasks/serial-executor.ts';
import type { TaskSnapshot } from '../../../src/lib/tasks/task-snapshot.ts';
import { createdActivity, shouldReject, task, withTempRoot } from './fixtures.ts';

const boardPath = (root: string): string => join(root, 'boards', 'session-alpha', 'tasks.json');

const snapshot = (...ids: readonly string[]): TaskSnapshot => ({
  v: 1,
  tasks: ids.map(id => ({ task: task({ id: id as never }), activity: [createdActivity()] })),
});

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

  it('should drop a damaged entry on read rather than failing the whole board', async () => {
    await withTempRoot(async root => {
      // Arrange
      const path = boardPath(root);
      await mkdir(join(root, 'boards', 'session-alpha'), { recursive: true });
      await writeFile(
        path,
        JSON.stringify({ v: 1, tasks: [{ task: { id: 'F1' } }, { task: task(), activity: [createdActivity()] }] }),
      );
      const store = new FileTaskStore(path);

      // Act
      const decoded = await store.readDecoded();

      // Assert
      should(decoded.fatal).be.false();
      should(decoded.snapshot.tasks).have.length(1);
      should(decoded.parseErrors).have.length(1);
    });
  });

  it('should refuse to mutate a board it could not read, preserving the evidence', async () => {
    await withTempRoot(async root => {
      // Arrange
      const path = boardPath(root);
      await mkdir(join(root, 'boards', 'session-alpha'), { recursive: true });
      await writeFile(path, 'not json at all');
      const store = new FileTaskStore(path);

      // Act & Assert
      await shouldReject('invalid', () => store.transact(() => ({ container: snapshot('F1'), result: null })));
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
