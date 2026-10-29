import { afterEach, describe, it, spyOn } from 'bun:test';
import { mkdir, mkdtemp, open, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { StateFileSystem } from '../../src/adapters/filesystem/state-file-system.ts';
import { createFoundationPaths } from '../../src/lib/paths.ts';
import { resolveStateHome } from '../../src/lib/state-home.ts';

const temporaryDirectories: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fy-state-failures-'));
  temporaryDirectories.push(root);
  const paths = createFoundationPaths(
    resolveStateHome({ fyHome: join(root, 'fy-home'), homeDirectory: join(root, 'user') }),
  );
  await mkdir(paths.home, { recursive: true });
  const files = new StateFileSystem(paths);
  // A regular file standing where a directory is expected: every path beneath it fails with ENOTDIR,
  // which is an error that is NOT "missing" and so must surface rather than read as absence.
  const blocker = join(paths.home, 'blocker');
  await writeFile(blocker, 'not a directory');
  return { paths, files, beneathFile: join(blocker, 'child') };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('StateFileSystem refuses to read a missing path as an empty one only when it is missing', () => {
  it('should report a path under a regular file as an error rather than as absence', async () => {
    const subject = await fixture();

    await should(subject.files.listDirectory(subject.beneathFile)).be.rejected();
    await should(subject.files.readTextIdentified(subject.beneathFile)).be.rejected();
    await should(subject.files.identity(subject.beneathFile)).be.rejected();
    await should(subject.files.readSlice(subject.beneathFile, 0, 1)).be.rejected();
    await should(
      (async () => {
        for await (const chunk of subject.files.readChunks(subject.beneathFile, 4)) should(chunk).be.ok();
      })(),
    ).be.rejected();
  });

  it('should report a path that does not exist as absence', async () => {
    const subject = await fixture();
    const missing = join(subject.paths.home, 'absent');

    should(await subject.files.listDirectory(missing)).deepEqual([]);
    should(await subject.files.readTextIdentified(missing)).be.undefined();
    should(await subject.files.identity(missing)).be.undefined();
    should(await subject.files.readSlice(missing, 0, 1)).be.undefined();
    const chunks: Uint8Array[] = [];
    for await (const chunk of subject.files.readChunks(missing, 4)) chunks.push(chunk);
    should(chunks).deepEqual([]);
  });

  it('should refuse to append to a journal path that is a directory instead of calling it replaced', async () => {
    const subject = await fixture();
    const directory = join(subject.paths.home, 'journal-dir');
    await mkdir(directory);

    await should(
      subject.files.appendLineToExisting(directory, '{}', { device: '0', inode: '0', size: 0, modifiedAtMs: 0 }),
    ).be.rejected();
  });
});

describe('StateFileSystem fleet links that cannot be resolved', () => {
  it('should refuse a dangling account link as a symbolic link rather than as provisioned', async () => {
    const subject = await fixture();
    const account = join(subject.paths.fleet, 'homes', 'claude-work');
    await mkdir(account, { recursive: true });
    const linked = join(account, 'CLAUDE.md');
    await symlink(join(subject.paths.fleet, 'assets', 'gone.md'), linked);

    await should(subject.files.readText(linked)).be.rejectedWith(/symbolic links are not allowed/);
  });
});

describe('StateFileSystem durable writes under a failing sync', () => {
  it('should clean up its temporary file and rethrow when the data cannot be synced', async () => {
    const subject = await fixture();
    const target = join(subject.paths.home, 'document.json');
    const handle = await open(join(subject.paths.home, 'blocker'), 'r');
    const prototype = Object.getPrototypeOf(handle) as { sync: () => Promise<void> };
    await handle.close();
    const sync = spyOn(prototype, 'sync').mockImplementation(async () => {
      throw Object.assign(new Error('disk is on fire'), { code: 'EIO' });
    });
    try {
      await should(subject.files.writeTextAtomic(target, '{}')).be.rejectedWith('disk is on fire');
    } finally {
      sync.mockRestore();
    }

    should(await subject.files.readText(target)).be.undefined();
    should(await readdir(subject.paths.temporary)).deepEqual([]);
  });

  it('should tolerate a directory sync the platform does not support but not any other failure', async () => {
    const subject = await fixture();
    const handle = await open(join(subject.paths.home, 'blocker'), 'r');
    const prototype = Object.getPrototypeOf(handle) as { sync: () => Promise<void> };
    await handle.close();
    const original = prototype.sync;
    const failWith = (code: string) =>
      spyOn(prototype, 'sync').mockImplementation(async function (this: {
        stat: () => Promise<{ isDirectory(): boolean }>;
      }) {
        if ((await this.stat()).isDirectory()) throw Object.assign(new Error(`sync ${code}`), { code });
        return await original.call(this);
      });

    const unsupported = failWith('EINVAL');
    try {
      await subject.files.writeTextAtomic(join(subject.paths.home, 'first.json'), '1');
    } finally {
      unsupported.mockRestore();
    }
    should(await subject.files.readText(join(subject.paths.home, 'first.json'))).equal('1');

    const broken = failWith('EIO');
    try {
      await should(subject.files.writeTextAtomic(join(subject.paths.home, 'second.json'), '2')).be.rejectedWith(
        'sync EIO',
      );
    } finally {
      broken.mockRestore();
    }
  });
});
