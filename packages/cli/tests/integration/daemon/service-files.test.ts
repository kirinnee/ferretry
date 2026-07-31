import { afterEach, beforeEach, describe, it } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
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
