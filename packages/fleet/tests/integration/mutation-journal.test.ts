/**
 * The mutation journal against a real filesystem: how it seals what a batch wrote, and which undo it
 * refuses to perform because somebody changed the destination since. Every path is inside a temporary
 * directory this test created.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { FileMutationJournal } from '../../src/adapters/mutation-journal.ts';

const created: string[] = [];

async function sandbox(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'fy-mutation-journal-'));
  created.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of created.splice(0)) {
    await chmod(directory, 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

const journal = (): FileMutationJournal => new FileMutationJournal(async () => undefined);

describe('FileMutationJournal sealing a directory mode', () => {
  it('should leave the seal of a mode entry open when its directory is gone by then', async () => {
    // Arrange
    const root = await sandbox();
    const directory = path.join(root, 'narrowed');
    await mkdir(directory, { mode: 0o755 });
    const recorder = journal();
    await recorder.captureDirectory(directory, 0o700);
    await rm(directory, { recursive: true });

    // Act
    await recorder.sealOperation(0);
    const outcome = await recorder.rollback();

    // Assert — nothing was recorded as left behind, and the vanished directory is named, not guessed at.
    should(outcome.unrestored.map(each => each.path)).deepEqual([directory]);
    should(outcome.unrestored[0]?.reason).match(/ENOENT/u);
  });

  it('should surface a directory it cannot inspect for any reason other than its absence', async () => {
    // Arrange — the directory's parent is replaced by a file, so the directory cannot be looked at.
    const root = await sandbox();
    const parent = path.join(root, 'parent');
    const directory = path.join(parent, 'narrowed');
    await mkdir(directory, { recursive: true, mode: 0o755 });
    const recorder = journal();
    await recorder.captureDirectory(directory, 0o700);
    await rm(parent, { recursive: true });
    await writeFile(parent, 'a file where a directory was');

    // Act / Assert
    await should(recorder.sealOperation(0)).be.rejectedWith(/is not a folder/u);
  });
});

describe('FileMutationJournal undoing a directory mode', () => {
  it('should refuse to restore the mode of an entry that is no longer a directory', async () => {
    // Arrange
    const root = await sandbox();
    const directory = path.join(root, 'narrowed');
    await mkdir(directory, { mode: 0o755 });
    const recorder = journal();
    await recorder.captureDirectory(directory, 0o700);
    await recorder.sealOperation(0);
    await rm(directory, { recursive: true });
    await writeFile(directory, 'now a plain file');

    // Act
    const outcome = await recorder.rollback();

    // Assert
    should(outcome.unrestored.map(each => each.path)).deepEqual([directory]);
    should(outcome.unrestored[0]?.reason).equal(
      `refusing to restore the mode of an entry that is no longer a directory: ${directory}`,
    );
    should(await readFile(directory, 'utf8')).equal('now a plain file');
  });

  it('should leave a mode somebody chose since this apply set it', async () => {
    // Arrange — the apply narrowed the directory, then someone else picked their own mode for it.
    const root = await sandbox();
    const directory = path.join(root, 'narrowed');
    await mkdir(directory, { mode: 0o755 });
    const recorder = journal();
    await recorder.captureDirectory(directory, 0o700);
    await chmod(directory, 0o700);
    await recorder.sealOperation(0);
    await chmod(directory, 0o750);

    // Act
    const outcome = await recorder.rollback();

    // Assert
    should(outcome.unrestored).deepEqual([
      { path: directory, reason: `refusing to restore the mode of ${directory}: it changed after this apply set it` },
    ]);
    should((await stat(directory)).mode & 0o777).equal(0o750);
  });
});

describe('FileMutationJournal discarding moved-aside evidence', () => {
  it('should name a backup it could not remove instead of failing a committed batch', async () => {
    // Arrange — the displaced file sits in a directory that can no longer be written to.
    const root = await sandbox();
    const kept = path.join(root, 'kept');
    await mkdir(kept);
    const target = path.join(kept, 'wrapper');
    await writeFile(target, 'original');
    const recorder = journal();
    await recorder.capture(target);
    const backup = recorder.backupOf(target);
    await chmod(kept, 0o500);

    // Act
    const remaining = await recorder.discard();
    await chmod(kept, 0o700);

    // Assert
    should(remaining).deepEqual([backup]);
    should(await readFile(backup as string, 'utf8')).equal('original');
  });
});

describe('FileMutationJournal removing a directory it created', () => {
  it('should refuse when the directory it created is no longer one', async () => {
    // Arrange
    const root = await sandbox();
    const created = path.join(root, 'made-by-the-apply');
    const recorder = journal();
    await recorder.captureDirectory(created);
    await writeFile(created, 'somebody put a file here');

    // Act
    const outcome = await recorder.rollback();

    // Assert
    should(outcome.unrestored).deepEqual([
      {
        path: created,
        reason: `refusing to remove ${created}: this apply created a directory and it is no longer one`,
      },
    ]);
    should(await readFile(created, 'utf8')).equal('somebody put a file here');
  });

  it('should report a directory it was not allowed to remove, with the failure it met', async () => {
    // Arrange — the directory exists and is empty, but its parent no longer lets anything be removed.
    const root = await sandbox();
    const created = path.join(root, 'made-by-the-apply');
    const recorder = journal();
    await recorder.captureDirectory(created);
    await mkdir(created);
    await chmod(root, 0o500);

    // Act
    const outcome = await recorder.rollback();
    await chmod(root, 0o700);

    // Assert
    should(outcome.unrestored.map(each => each.path)).deepEqual([created]);
    should(outcome.unrestored[0]?.reason).match(/EACCES/u);
    should((await stat(created)).isDirectory()).be.true();
  });
});
