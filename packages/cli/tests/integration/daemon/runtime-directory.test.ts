import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { privateRuntimeDirectory } from '../../../src/adapters/daemon/runtime-directory.ts';

/**
 * Which runtime directory the lifecycle claim may be trusted to live in. The directory is the only
 * thing standing between the claim and another user pre-creating its name, so every way it can be the
 * wrong directory has to be shown to be refused, against a real filesystem and real modes.
 */

const roots = new Set<string>();
const SELF = process.getuid?.() ?? 0;

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-runtime-directory-'));
  roots.add(root);
  return root;
}

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

describe('private runtime directory', () => {
  it('should accept a directory this user owns that is closed to group and other', async () => {
    // Arrange
    const root = await temporaryRoot();
    const runtime = join(root, 'run');
    await mkdir(runtime, { mode: 0o700 });
    await chmod(runtime, 0o700);

    // Act + Assert
    should(privateRuntimeDirectory(runtime, SELF)).equal(runtime);
  });

  it.each([0o750, 0o705, 0o770, 0o777])('should refuse mode %o, which opens it to others', async mode => {
    // Arrange
    const root = await temporaryRoot();
    const runtime = join(root, 'run');
    await mkdir(runtime);
    await chmod(runtime, mode);

    // Act + Assert — another user could pre-create a name inside it, which is the whole defect.
    should(privateRuntimeDirectory(runtime, SELF)).be.undefined();
  });

  it('should refuse a directory owned by someone else', async () => {
    // Arrange
    const root = await temporaryRoot();
    const runtime = join(root, 'run');
    await mkdir(runtime, { mode: 0o700 });

    // Act + Assert — the same directory is only trusted by the user it belongs to.
    should(privateRuntimeDirectory(runtime, SELF + 1)).be.undefined();
  });

  it('should refuse a regular file, a missing path, a relative path and an unset variable', async () => {
    // Arrange
    const root = await temporaryRoot();
    const file = join(root, 'file');
    await writeFile(file, '', { mode: 0o600 });

    // Act + Assert
    should(privateRuntimeDirectory(file, SELF)).be.undefined();
    should(privateRuntimeDirectory(join(root, 'absent'), SELF)).be.undefined();
    should(privateRuntimeDirectory('run/user/1000', SELF)).be.undefined();
    should(privateRuntimeDirectory(undefined, SELF)).be.undefined();
  });

  it('should judge the directory a link points at, not the link', async () => {
    // Arrange
    const root = await temporaryRoot();
    const open = join(root, 'open');
    await mkdir(open);
    await chmod(open, 0o755);
    const link = join(root, 'link');
    await symlink(open, link);

    // Act + Assert — a link cannot launder an open directory into a trusted one.
    should(privateRuntimeDirectory(link, SELF)).be.undefined();
  });
});
