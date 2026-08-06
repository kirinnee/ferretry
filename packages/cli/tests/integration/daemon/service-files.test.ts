import { afterEach, beforeEach, describe, it } from 'bun:test';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileServiceStore } from '../../../src/adapters/daemon/service-files';

/**
 * Real filesystem, always inside a fresh temp directory. Nothing here may resolve a live state home,
 * a live systemd unit directory, or a live LaunchAgents directory.
 */
describe('file service store', () => {
  let root = '';
  const subject = new FileServiceStore();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fy-service-files-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should report a file absent before it is written and present after', async () => {
    // Arrange
    const path = join(root, 'fyd.service');

    // Act + Assert
    should(await subject.exists(path)).be.false();
    await subject.writePrivate(path, 'unit');
    should(await subject.exists(path)).be.true();
  });

  it('should write the service definition readable only by its owner', async () => {
    // Arrange
    const path = join(root, 'fyd.service');

    // Act
    await subject.writePrivate(path, '[Unit]\nDescription=fyd\n');

    // Assert — the definition carries the daemon's PATH and state home; nobody else needs it.
    should(await Bun.file(path).text()).equal('[Unit]\nDescription=fyd\n');
    should((await stat(path)).mode & 0o777).equal(0o600);
  });

  it('should replace an existing definition rather than append to it', async () => {
    // Arrange
    const path = join(root, 'fyd.service');
    await subject.writePrivate(path, 'first');

    // Act
    await subject.writePrivate(path, 'second');

    // Assert
    should(await Bun.file(path).text()).equal('second');
  });

  it('should publish the definition whole, leaving no temporary beside it', async () => {
    // Arrange — a plain write truncates first, so a crash in the middle leaves a unit or plist the
    // service manager rejects, and `install` is the only verb that would ever rewrite it. This one is
    // built under a private name in the same directory and renamed on, so a reader sees the old
    // complete file or the new complete one. Debris in a systemd unit directory is its own problem.
    const path = join(root, 'fyd.service');

    // Act
    await subject.writePrivate(path, 'first');
    await subject.writePrivate(path, '[Unit]\nDescription=fyd\n');

    // Assert
    should(await readdir(root)).deepEqual(['fyd.service']);
    should(await Bun.file(path).text()).equal('[Unit]\nDescription=fyd\n');
    should((await stat(path)).mode & 0o777).equal(0o600);
  });

  it('should leave the installed definition whole when publication stops after the staged fsync', async () => {
    // Arrange — fail at the exact boundary after the complete private file is durable and before its
    // atomic rename. A truncate-in-place implementation would already have damaged `first` here.
    const path = join(root, 'fyd.service');
    await subject.writePrivate(path, 'first');
    const interrupted = new FileServiceStore({
      afterStagedSync: () => Promise.reject(new Error('simulated interruption before publish')),
    });

    // Act + Assert
    await should(interrupted.writePrivate(path, '[Unit]\nDescription=replacement\n')).be.rejectedWith(
      /simulated interruption/u,
    );
    should(await Bun.file(path).text()).equal('first');
    should(await readdir(root)).deepEqual(['fyd.service']);

    // And once publication succeeds, the only other observable state is the whole replacement.
    await subject.writePrivate(path, '[Unit]\nDescription=replacement\n');
    should(await Bun.file(path).text()).equal('[Unit]\nDescription=replacement\n');
  });

  it('should create a nested directory tree in one call', async () => {
    // Arrange
    const nested = join(root, 'systemd', 'user');

    // Act
    await subject.ensureDirectory(nested);
    await subject.writePrivate(join(nested, 'fyd.service'), 'unit');

    // Assert
    should((await stat(nested)).isDirectory()).be.true();
    should(await subject.exists(join(nested, 'fyd.service'))).be.true();
  });

  it('should be idempotent about a directory that already exists', async () => {
    // Act + Assert
    await subject.ensureDirectory(root);
    await should(subject.ensureDirectory(root)).be.fulfilled();
  });

  it('should remove a definition', async () => {
    // Arrange
    const path = join(root, 'fyd.service');
    await subject.writePrivate(path, 'unit');

    // Act
    await subject.remove(path);

    // Assert
    should(await subject.exists(path)).be.false();
  });

  it('should treat removing an absent definition as success', async () => {
    // Act + Assert — an uninstall must not fail because a previous uninstall already worked.
    await should(subject.remove(join(root, 'never-existed.service'))).be.fulfilled();
  });
});
