import { afterEach, describe, it } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileRetiredArtifacts } from '../../../src/adapters/daemon/retired-artifacts.ts';

/**
 * Removing the daemon snapshot store an earlier release left behind, against a real filesystem.
 *
 * The permission half is the whole reason this adapter exists, and it can only be proved for real: a
 * snapshot directory was sealed to mode 0555 when its build finished, and an entry can only be
 * unlinked by somebody who may write to the directory holding it. A fake filesystem would happily
 * "remove" a tree that the real one refuses with EACCES, which is exactly the 100MB an upgraded host
 * would be stuck with.
 */

const roots = new Set<string>();

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-retired-'));
  roots.add(root);
  return root;
}

/** `lstat`, because the trees here hold directories and symbolic links, not only regular files. */
async function exists(path: string): Promise<boolean> {
  return await lstat(path).then(
    () => true,
    () => false,
  );
}

/**
 * A snapshot store exactly as the retired release sealed one: read-only all the way down.
 *
 * Written most-nested-first and sealed on the way OUT, because a directory cannot be written into
 * once it is 0555 — the same order the removal has to undo.
 */
async function sealedStore(root: string, ids: readonly string[], bytes: number): Promise<string> {
  const store = join(root, 'state', 'ferretry', 'daemon-snapshots', 'fyd');
  await mkdir(join(store, 'snapshots'), { recursive: true });
  await mkdir(join(store, 'staging'), { recursive: true });
  await writeFile(join(store, 'promoted'), '1\n');
  await chmod(join(store, 'promoted'), 0o444);
  await symlink(join('snapshots', ids[0] ?? '', 'fyd'), join(store, 'current'));
  for (const id of ids) {
    const directory = join(store, 'snapshots', id);
    await mkdir(directory);
    await writeFile(join(directory, 'fyd'), 'x'.repeat(bytes));
    await writeFile(join(directory, 'manifest.json'), '{}');
    await chmod(join(directory, 'fyd'), 0o555);
    await chmod(join(directory, 'manifest.json'), 0o444);
    await chmod(directory, 0o555);
  }
  return store;
}

afterEach(async () => {
  for (const root of roots) {
    // The fixtures seal directories read-only, so the tidy-up needs the same unsealing the subject does.
    await new FileRetiredArtifacts().retire(root);
    await rm(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe('retired artifact removal', () => {
  it('should refuse an ordinary recursive remove, which is the whole reason this adapter exists', async () => {
    // Arrange — a snapshot directory sealed to 0555 cannot have anything unlinked out of it, and the
    // parent cannot remove a directory that is not empty. This is the state an upgraded host is in.
    const root = await createTemporaryRoot();
    const store = await sealedStore(root, [`sha256-${'a'.repeat(64)}`], 8);

    // Act + Assert — asserted on its own fixture, because a partly-completed remove would leave the
    // subject a different tree to measure.
    await should(rm(store, { recursive: true })).be.rejectedWith(/EACCES|EPERM/u);
  });

  it('should remove a store sealed read-only, and measure what it reclaimed', async () => {
    // Arrange
    const root = await createTemporaryRoot();
    const store = await sealedStore(root, [`sha256-${'a'.repeat(64)}`, `sha256-${'b'.repeat(64)}`], 1_000);

    // Act
    const actual = await new FileRetiredArtifacts().retire(store);

    // Assert — two snapshots of two files each, plus the promoted marker and the current link. The
    // link counts as a file and contributes no bytes; `staging` is an empty directory and counts as
    // neither.
    should(actual).deepEqual({ kind: 'removed', files: 6, bytes: 2_006 });
    should(await exists(store)).be.false();
  });

  it('should answer absent for a host that never had one, without creating anything', async () => {
    // Arrange — the ordinary case on every fresh install.
    const root = await createTemporaryRoot();
    const store = join(root, 'state', 'ferretry', 'daemon-snapshots', 'fyd');

    // Act
    const actual = await new FileRetiredArtifacts().retire(store);

    // Assert
    should(actual).deepEqual({ kind: 'absent' });
    should(await exists(join(root, 'state'))).be.false();
  });

  it('should unlink a garbage-collection root rather than follow it into the store', async () => {
    // Arrange — the per-snapshot roots are symbolic links into `/nix/store`, and following one would
    // recursively delete somebody's Nix output.
    const root = await createTemporaryRoot();
    const target = join(root, 'pretend-store-output');
    await mkdir(join(target, 'bin'), { recursive: true });
    await writeFile(join(target, 'bin', 'fyd'), 'x');
    const roots_ = join(root, 'state', 'ferretry', 'nix', 'snapshots', 'fyd');
    await mkdir(roots_, { recursive: true });
    await symlink(target, join(roots_, `sha256-${'c'.repeat(64)}`));

    // Act
    const actual = await new FileRetiredArtifacts().retire(roots_);

    // Assert — the link is counted and gone; what it pointed at is untouched.
    should(actual).deepEqual({ kind: 'removed', files: 1, bytes: 0 });
    should(await exists(roots_)).be.false();
    should(await exists(join(target, 'bin', 'fyd'))).be.true();
  });

  it('should remove a plain file, so a single retired artifact needs no special case', async () => {
    // Arrange
    const root = await createTemporaryRoot();
    const marker = join(root, 'promoted');
    await writeFile(marker, '1\n');
    await chmod(marker, 0o444);

    // Act
    const actual = await new FileRetiredArtifacts().retire(marker);

    // Assert
    should(actual).deepEqual({ kind: 'removed', files: 1, bytes: 2 });
    should(await exists(marker)).be.false();
  });

  it('should report a tree it cannot unlink rather than throwing at a lifecycle verb', async () => {
    // Arrange — the store is readable and unsealable, but its PARENT is not writable, so the final
    // removal is refused. Reclaiming disk may never fail the command it is attached to, so the reason
    // travels back as a value the caller warns with.
    const root = await createTemporaryRoot();
    const store = join(root, 'sealed', 'fyd');
    await mkdir(store, { recursive: true });
    await writeFile(join(store, 'fyd'), 'x');
    await chmod(join(root, 'sealed'), 0o500);

    // Act
    const actual = await new FileRetiredArtifacts().retire(store);

    // Assert
    should(actual).have.property('kind', 'failed');
    should(actual)
      .have.property('reason')
      .which.match(/EACCES|EPERM/u);
    should(await exists(store)).be.true();

    // Cleanup — hand the fixture back so the afterEach removal is not the thing under test.
    await chmod(join(root, 'sealed'), 0o700);
  });

  it('should report a path it cannot even inspect', async () => {
    // Arrange — a path whose ancestor is a regular file, which is ENOTDIR rather than ENOENT.
    const root = await createTemporaryRoot();
    await writeFile(join(root, 'not-a-directory'), 'x');

    // Act
    const actual = await new FileRetiredArtifacts().retire(join(root, 'not-a-directory', 'fyd'));

    // Assert — an absent store is `absent`; anything else is a reason, never a silent success.
    should(actual).have.property('kind', 'failed');
    should(actual)
      .have.property('reason')
      .which.match(/ENOTDIR/u);
  });
});
