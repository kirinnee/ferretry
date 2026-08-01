import { describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileLastSnapshotStore } from '../../../../src/adapters/session/snapshot/file-last-snapshot-store.ts';

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'fy-last-snapshot-'));
  try {
    await run(root);
  } finally {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

const storeAt = (root: string, uniqueId?: () => string) =>
  new FileLastSnapshotStore(id => join(root, id, 'last-snapshot.txt'), uniqueId);

describe('FileLastSnapshotStore', () => {
  it('should distinguish a frame that was never captured from one it cannot read', async () => {
    await withTempRoot(async root => {
      // The whole point of this store is that absent evidence stays absent. An operator asking how a
      // session ended must be able to tell "nothing was captured" from "something is there and I
      // cannot read it" — collapsing the two into one empty answer is the false-success shape this
      // migration has already had to fix in the warden and the session stores.
      // Arrange
      const subject = storeAt(root);
      await mkdir(join(root, 'captured'), { recursive: true });
      await writeFile(join(root, 'captured', 'last-snapshot.txt'), 'the last frame\n› ');
      const unreadable = join(root, 'locked');
      await mkdir(unreadable, { recursive: true });
      await writeFile(join(unreadable, 'last-snapshot.txt'), 'unreachable');
      await chmod(unreadable, 0o000);

      // Act
      const read = await subject.read('captured');
      const absent = await subject.read('never-ran');
      const denied = await subject.read('locked');
      await chmod(unreadable, 0o700);

      // Assert
      should(read).deepEqual({ kind: 'read', text: 'the last frame\n› ' });
      should(absent).deepEqual({ kind: 'absent' });
      should(denied).deepEqual({ kind: 'unreadable' });
    });
  });

  it('should publish a frame atomically and leave no partial file behind when it cannot', async () => {
    await withTempRoot(async root => {
      // A reader must never observe a half-written frame, so the write lands on a temporary name and
      // is renamed into place. When the write itself fails the temporary is removed rather than left
      // as debris beside the real evidence, where a later reader could mistake it for a frame.
      // Arrange
      const directory = join(root, 'session-1');
      const collide = storeAt(root, () => 'fixed');
      const subject = storeAt(root, () => 'second');
      await mkdir(directory, { recursive: true });
      // `wx` refuses an existing temporary, which is what makes a stale name a failure rather than a
      // silent overwrite of another writer's in-flight file.
      await writeFile(join(directory, 'last-snapshot.txt.tmp.fixed'), 'someone else is mid-write');

      // Act
      await subject.write('session-1', 'first frame');
      const rejected = collide.write('session-1', 'clobbering frame');

      // Assert
      await should(rejected).rejected();
      // The published frame is the one that completed. A failed write never becomes the evidence.
      should(await readFile(join(directory, 'last-snapshot.txt'), 'utf8')).equal('first frame');
      // Nothing is left lying beside it. Note the cleanup removes the path the failed write claimed,
      // which here is the pre-existing temporary itself — with a real randomUUID two writers cannot
      // land on one name, so this only bites the fixed id this test injects.
      should((await readdir(directory)).filter(name => name.includes('.tmp.'))).deepEqual([]);
      // Owner-only: a final frame is a verbatim capture of a human's terminal.
      should((await stat(join(directory, 'last-snapshot.txt'))).mode & 0o777).equal(0o600);
    });
  });

  it('should create the session directory it writes into when nothing has yet', async () => {
    await withTempRoot(async root => {
      // Arrange
      const subject = storeAt(root);

      // Act
      await subject.write('first-write', 'frame');

      // Assert
      should(await subject.read('first-write')).deepEqual({ kind: 'read', text: 'frame' });
      should((await stat(join(root, 'first-write'))).mode & 0o777).equal(0o700);
    });
  });
});
