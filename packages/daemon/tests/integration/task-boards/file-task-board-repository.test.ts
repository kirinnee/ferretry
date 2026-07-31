import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileTaskBoardRepository } from '../../../src/adapters/task-boards/file-task-board-repository.ts';
import { isTaskBoardError } from '../../../src/lib/task-boards/error.ts';
import { serializeTaskBoardSnapshot } from '../../../src/lib/task-boards/snapshot.ts';
import {
  EMPTY_TASK_BOARD_REPOSITORY_STATE,
  type TaskBoardRepositoryState,
} from '../../../src/lib/task-boards/types.ts';

const homes: string[] = [];

async function createRepository(): Promise<{ readonly path: string; readonly repository: FileTaskBoardRepository }> {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-task-boards-'));
  homes.push(home);
  const path = join(home, 'task-boards.json');
  return { path, repository: new FileTaskBoardRepository(path) };
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map(async home => await rm(home, { recursive: true, force: true })));
});

/** A state distinguishable from the empty one without needing a whole board. */
function bumped(state: TaskBoardRepositoryState, boardId: string): TaskBoardRepositoryState {
  return {
    ...state,
    revision: state.revision + 1,
    creations: [...state.creations, { requestId: boardId, fingerprint: boardId, boardId }],
  };
}

describe('FileTaskBoardRepository', () => {
  it('should read the empty repository from a home that has never held a board', async () => {
    // Arrange
    const { repository } = await createRepository();

    // Act
    const state = await repository.snapshot();

    // Assert
    should(state).eql(EMPTY_TASK_BOARD_REPOSITORY_STATE);
  });

  it('should commit a transaction atomically and serve it back', async () => {
    // Arrange
    const { repository, path } = await createRepository();

    // Act
    const result = await repository.transaction(async state => ({
      state: bumped(state, 'board-one'),
      result: 'committed',
    }));

    // Assert
    should(result).equal('committed');
    should((await repository.snapshot()).creations).eql([
      { requestId: 'board-one', fingerprint: 'board-one', boardId: 'board-one' },
    ]);
    // The document a reader would find is the whole committed state, not a partial write.
    should(JSON.parse(await readFile(path, 'utf8'))).have.property('revision', 1);
  });

  it('should commit nothing when the reducer refuses', async () => {
    // Arrange
    const { repository } = await createRepository();
    await repository.transaction(async state => ({ state: bumped(state, 'board-one'), result: undefined }));

    // Act
    const refusal = await repository
      .transaction(async () => {
        throw new Error('the grant is not allowed');
      })
      .catch((error: unknown) => error);

    // Assert
    should(refusal).be.an.Error();
    // The refused transaction left the previous board exactly as it was.
    should((await repository.snapshot()).revision).equal(1);
  });

  it('should serialize concurrent transactions so neither overwrites the other', async () => {
    // Arrange
    const { repository } = await createRepository();

    // Act — both read-modify-write the same document with no coordination of their own.
    await Promise.all([
      repository.transaction(async state => ({ state: bumped(state, 'board-one'), result: undefined })),
      repository.transaction(async state => ({ state: bumped(state, 'board-two'), result: undefined })),
    ]);

    // Assert — a lost update would leave one creation, not two.
    const state = await repository.snapshot();
    should(state.creations.map(creation => creation.boardId).sort()).eql(['board-one', 'board-two']);
    should(state.revision).equal(2);
  });

  it('should refuse to serve an unreadable document rather than reporting no memberships', async () => {
    // Arrange
    const { repository, path } = await createRepository();
    await writeFile(path, '{ "version": 1, "boards": "not an array" }', 'utf8');

    // Act
    const refusal = await repository.snapshot().catch((error: unknown) => error);

    // Assert
    should(isTaskBoardError(refusal)).be.true();
    if (!isTaskBoardError(refusal)) return;
    should(refusal.code).equal('unavailable');
    should(refusal.message).match(/refusing to serve an unreadable task-board document/u);
  });

  it('should refuse to mutate an unreadable document rather than replacing it with a fresh board', async () => {
    // Arrange
    const { repository, path } = await createRepository();
    await writeFile(path, 'not json at all', 'utf8');

    // Act
    const refusal = await repository
      .transaction(async state => ({ state, result: undefined }))
      .catch((error: unknown) => error);

    // Assert
    should(isTaskBoardError(refusal)).be.true();
    // The evidence is preserved: a corrupt board is never silently overwritten.
    should(await readFile(path, 'utf8')).equal('not json at all');
  });

  it('should accept an injected executor and writer so a caller can drive faults', async () => {
    // Arrange — the same collaborators production uses, supplied explicitly.
    const home = await mkdtemp(join(tmpdir(), 'ferretry-task-boards-'));
    homes.push(home);
    const path = join(home, 'nested', 'task-boards.json');
    const keys: string[] = [];
    const repository = new FileTaskBoardRepository(path, {
      executor: {
        run: async (key, work) => {
          keys.push(key);
          return await work();
        },
      },
    });

    // Act
    await repository.transaction(async state => ({ state: bumped(state, 'board-one'), result: undefined }));

    // Assert
    should(keys).eql([path]);
    should(serializeTaskBoardSnapshot(await repository.snapshot())).match(/board-one/u);
  });
});
