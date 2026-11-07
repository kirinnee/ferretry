import { describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileLastSnapshotStore } from '../../../../src/adapters/session/snapshot/index.ts';

const ID = 'session-1';

async function temporaryDirectory(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'ferretry-last-snapshot-'));
}

describe('FileLastSnapshotStore', () => {
  it('should atomically retain the captured final frame beside its session', async () => {
    // Arrange
    const directory = await temporaryDirectory();
    const file = join(directory, 'last-snapshot.txt');
    const subject = new FileLastSnapshotStore(
      () => file,
      () => 'capture',
    );

    // Act
    await subject.write(ID, 'the final visible frame');
    const actual = await subject.read(ID);

    // Assert
    should(actual).deepEqual({ kind: 'read', text: 'the final visible frame' });
    should(await readFile(file, 'utf8')).equal('the final visible frame');
    await rm(directory, { recursive: true, force: true });
  });

  it('should distinguish absent and unreadable artifacts', async () => {
    // Arrange
    const directory = await temporaryDirectory();
    const absent = new FileLastSnapshotStore(() => join(directory, 'none.txt'));
    const unreadable = new FileLastSnapshotStore(() => join(directory, 'directory'));
    await mkdir(join(directory, 'directory'));

    // Act
    const missing = await absent.read(ID);
    const damaged = await unreadable.read(ID);

    // Assert
    should(missing).deepEqual({ kind: 'absent' });
    should(damaged).deepEqual({ kind: 'unreadable' });
    await rm(directory, { recursive: true, force: true });
  });

  it('should remove a failed atomic temporary file', async () => {
    // Arrange
    const directory = await temporaryDirectory();
    const file = join(directory, 'last-snapshot.txt');
    const temporary = `${file}.tmp.collision`;
    await writeFile(temporary, 'existing', { flag: 'wx' });
    const subject = new FileLastSnapshotStore(
      () => file,
      () => 'collision',
    );

    // Act
    const failure = await subject.write(ID, 'frame').catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceof(Error);
    should(await Bun.file(temporary).exists()).false();
    await rm(directory, { recursive: true, force: true });
  });
});
