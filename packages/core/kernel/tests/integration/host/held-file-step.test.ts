/**
 * The step a held folder reads a file with where no path reaches an open descriptor (macOS): `FolderSteps.openFile`
 * is `openat(O_RDONLY | O_NOFOLLOW | O_NONBLOCK)` from the folder's descriptor after proving the descriptor is still the
 * folder it was opened on. The C calls are stand-ins over `/proc/self/fd` that count every descriptor they hand out, so
 * "closed on every path" is checked against the kernel (`fstat` of a closed descriptor answers `EBADF`), not against a
 * flag. Fixture text only, in fresh temp folders.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { type BigIntStats, closeSync, constants, fstatSync, openSync, symlinkSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { DescriptorCalls } from '../../../host/adapters/pinned/descriptor-calls.ts';
import { isSingleName, O_CLOEXEC } from '../../../host/adapters/pinned/descriptor-calls.ts';
import { folderSteps, type HeldIdentity } from '../../../host/adapters/pinned/descriptor-folder.ts';

const parents: string[] = [];
const folderFds: number[] = [];
afterEach(async () => {
  for (const fd of folderFds.splice(0)) {
    try {
      closeSync(fd);
    } catch {
      // already closed by the test
    }
  }
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const TEXT = 'HELD-FILE-FIXTURE-TEXT';

const identityOfStats = (stats: BigIntStats): HeldIdentity => ({
  kind: stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : stats.isSymbolicLink() ? 'link' : 'other',
  device: stats.dev,
  inode: stats.ino,
  links: Number(stats.nlink),
  size: Number(stats.size),
  mtimeMs: Number(stats.mtimeMs),
  mtimeNs: stats.mtimeNs,
  ctimeNs: stats.ctimeNs,
  mode: Number(stats.mode) & 0o7777,
  owner: Number(stats.uid),
  group: Number(stats.gid),
});

const isOpen = (fd: number): boolean => {
  try {
    fstatSync(fd);
    return true;
  } catch {
    return false;
  }
};

/** The stand-in `openat` over `/proc/self/fd`, remembering every descriptor it handed out. */
function trackedCalls(): { readonly calls: DescriptorCalls; readonly handed: number[] } {
  const handed: number[] = [];
  const through = (fd: number, name: string): string => {
    if (!isSingleName(name)) throw Object.assign(new Error('EINVAL: name'), { code: 'EINVAL' });
    return `/proc/self/fd/${String(fd)}/${name}`;
  };
  const never = (): never => {
    throw new Error('not used by a read');
  };
  return {
    handed,
    calls: {
      openat: (fd, name, flags, mode) => {
        const opened = openSync(through(fd, name), flags, mode);
        handed.push(opened);
        return opened;
      },
      renameat: never,
      linkat: never,
      unlinkat: never,
      mkdirat: never,
    },
  };
}

async function scratch() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-held-file-`));
  parents.push(parent);
  await mkdir(`${parent}/folder`);
  await writeFile(`${parent}/folder/f.txt`, TEXT);
  const fd = openSync(`${parent}/folder`, constants.O_RDONLY | constants.O_DIRECTORY | O_CLOEXEC);
  folderFds.push(fd);
  const stats = fstatSync(fd, { bigint: true });
  const held = { fd, device: stats.dev, inode: stats.ino };
  return { parent, held };
}

const identityOf = async (fd: number): Promise<HeldIdentity> => identityOfStats(fstatSync(fd, { bigint: true }));

describe('R-0198 FolderSteps.openFile reads a file below a held folder without a path', () => {
  test('R-0198 it hands out the file, its identity and its bytes, and closes the descriptor', async () => {
    const w = await scratch();
    const { calls, handed } = trackedCalls();
    const steps = folderSteps(calls, w.held, identityOf);
    const file = await steps.openFile('f.txt');
    expect(file.identity.kind).toBe('file');
    expect(file.identity.size).toBe(TEXT.length);
    expect(new TextDecoder().decode(await file.readAt(0, 1000))).toBe(TEXT);
    expect(new TextDecoder().decode(await file.readAt(9, 4))).toBe(TEXT.slice(9, 13));
    expect((await file.readAt(TEXT.length, 10)).byteLength).toBe(0);
    expect(await file.size()).toBe(TEXT.length);
    await file.sync();
    expect(handed.every(isOpen)).toBe(true);
    await file.close();
    expect(handed.some(isOpen)).toBe(false);
  });

  test('R-0198 a link at the leaf is ELOOP (never followed), nothing at the leaf is ENOENT, and no descriptor stays open', async () => {
    const w = await scratch();
    symlinkSync(`${w.parent}/folder/f.txt`, `${w.parent}/folder/link`);
    const { calls, handed } = trackedCalls();
    const steps = folderSteps(calls, w.held, identityOf);
    expect(await steps.openFile('link').catch((error: { code?: string }) => error.code)).toBe('ELOOP');
    expect(await steps.openFile('absent').catch((error: { code?: string }) => error.code)).toBe('ENOENT');
    expect(handed.some(isOpen)).toBe(false);
  });

  test('R-0198 a file it may not read is EACCES and no descriptor stays open', async () => {
    if (process.getuid?.() === 0) return;
    const w = await scratch();
    await chmod(`${w.parent}/folder/f.txt`, 0o000);
    const { calls, handed } = trackedCalls();
    const steps = folderSteps(calls, w.held, identityOf);
    expect(await steps.openFile('f.txt').catch((error: { code?: string }) => error.code)).toBe('EACCES');
    expect(handed.some(isOpen)).toBe(false);
  });

  test('R-0198 a folder is opened as what it is (the caller judges the kind) and closed with the file', async () => {
    const w = await scratch();
    await mkdir(`${w.parent}/folder/sub`);
    const { calls, handed } = trackedCalls();
    const file = await folderSteps(calls, w.held, identityOf).openFile('sub');
    expect(file.identity.kind).toBe('directory');
    await file.close();
    expect(handed.some(isOpen)).toBe(false);
  });

  test('R-0198 a name that is not one plain segment is EINVAL and opens nothing', async () => {
    const w = await scratch();
    const { calls, handed } = trackedCalls();
    const steps = folderSteps(calls, w.held, identityOf);
    for (const name of ['', '.', '..', 'a/b', 'f.txt\0x'])
      expect(await steps.openFile(name).catch((error: { code?: string }) => error.code)).toBe('EINVAL');
    expect(handed).toEqual([]);
  });

  test('R-0198 a throw after the open (the identity cannot be read) closes the descriptor and rethrows that error', async () => {
    const w = await scratch();
    const { calls, handed } = trackedCalls();
    const boom = new Error('injected after the open');
    const steps = folderSteps(calls, w.held, async () => {
      throw boom;
    });
    expect(await steps.openFile('f.txt').catch((error: unknown) => error)).toBe(boom);
    expect(handed).toHaveLength(1);
    expect(handed.some(isOpen)).toBe(false);
  });

  test('R-0198 a held descriptor that stopped naming its folder is EBADF before anything is opened', async () => {
    const w = await scratch();
    const { calls, handed } = trackedCalls();
    const steps = folderSteps(calls, { ...w.held, inode: w.held.inode + 1n }, identityOf);
    expect(await steps.openFile('f.txt').catch((error: { code?: string }) => error.code)).toBe('EBADF');
    expect(handed).toEqual([]);
  });
});
