/**
 * The folders a host holds by descriptor, on a REAL temp disk (S179, K3): a held child below a held folder on a host
 * with no `/proc/self/fd` (macOS, driven here by stand-in C calls over `/proc/self/fd`, as `project-files-race` does),
 * a host that reaches nothing, a descriptor number that stopped naming its folder, and the real `mkdirat` refusing.
 * No tmux, no real home: every folder is a fresh temp folder.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  closeSync,
  constants,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import {
  type DescriptorCalls,
  isSingleName,
  loadDescriptorCalls,
} from '../../../host/adapters/pinned/descriptor-calls.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const NO_PROC = '/nonexistent-descriptor-folder';

async function scratch(): Promise<string> {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-held-folder-`));
  parents.push(parent);
  return parent;
}

/** The five calls over `/proc/self/fd`, which Linux resolves from the held descriptor itself. */
const standIn = (): DescriptorCalls => {
  const through = (fd: number, name: string): string => {
    if (!isSingleName(name)) throw Object.assign(new Error('EINVAL: name'), { code: 'EINVAL' });
    return `/proc/self/fd/${String(fd)}/${name}`;
  };
  return {
    openat: (fd, name, flags, mode) => openSync(through(fd, name), flags, mode),
    renameat: (from, fromName, to, toName) => renameSync(through(from, fromName), through(to, toName)),
    linkat: (from, fromName, to, toName) => linkSync(through(from, fromName), through(to, toName)),
    unlinkat: (fd, name) => unlinkSync(through(fd, name)),
    mkdirat: (fd, name, mode) => mkdirSync(through(fd, name), { mode }),
  };
};

const macOS = (calls: () => DescriptorCalls = standIn): HostFs =>
  nodeFs(() => crypto.randomUUID(), { descriptorFolder: NO_PROC, descriptorCalls: calls });

/** The descriptor number this process holds open on `path`. */
function descriptorOn(path: string): number {
  for (const name of readdirSync('/proc/self/fd')) {
    try {
      if (readlinkSync(`/proc/self/fd/${name}`) === path) return Number(name);
    } catch {
      // the descriptor `readdirSync` itself used is already closed
    }
  }
  throw new Error(`no descriptor is open on ${path}`);
}

/** Closes descriptor `fd` behind the host's back and opens `path` in its place: the number now names another thing. */
function replaceDescriptor(fd: number, path: string): void {
  closeSync(fd);
  const now = openSync(path, constants.O_RDONLY);
  expect(now).toBe(fd);
}

describe('S179 a held child below a held folder (a host with no /proc/self/fd)', () => {
  test('S179 a nested folder is made and opened below a held child, and chmod and sync act on it', async () => {
    const parent = await scratch();
    const disk = macOS();
    const top = await disk.openDirectory(parent);
    const first = await top.openChild('a', { mode: 0o700 });
    expect(first.created).toBe(true);
    // The held child answers no path (nothing reaches it by number) but opens its own child through its steps.
    expect(first.folder.entryPath('b')).toBeUndefined();
    const second = await first.folder.openChild('b', { mode: 0o700 });
    expect(second.created).toBe(true);
    expect((await stat(`${parent}/a/b`)).isDirectory()).toBe(true);
    const again = await first.folder.openChild('b', { mode: 0o700 });
    expect(again.created).toBe(false);
    expect(again.folder.identity.inode).toBe(second.folder.identity.inode);
    // Without `make` a missing folder is not made.
    await expect(first.folder.openChild('missing')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await stat(`${parent}/a/missing`).catch(() => undefined)).toBeUndefined();

    await second.folder.chmod(0o750);
    expect(((await stat(`${parent}/a/b`)).mode & 0o777).toString(8)).toBe('750');
    await second.folder.sync();

    for (const folder of [again.folder, second.folder, first.folder, top]) await folder.close();
  });

  test('S179 a held child syncs when the filesystem cannot sync a directory (EINVAL), and refuses any other failure', async () => {
    const parent = await scratch();
    const top = await macOS().openDirectory(parent);
    const unsupported = await top.openChild('unsupported', { mode: 0o700 });
    // The number now names /dev/null, which answers EINVAL to fsync: tolerated, exactly as a state filesystem does.
    replaceDescriptor(descriptorOn(`${parent}/unsupported`), '/dev/null');
    await unsupported.folder.sync();
    await unsupported.folder.close();

    const broken = await top.openChild('broken', { mode: 0o700 });
    // The number names nothing at all: EBADF is not one of the three tolerated errnos and propagates.
    closeSync(descriptorOn(`${parent}/broken`));
    await expect(broken.folder.sync()).rejects.toMatchObject({ code: 'EBADF' });
    await broken.folder.close().catch(() => undefined);
    await top.close();
  });
});

describe('S179 a host that reaches a held folder by neither /proc/self/fd nor the C calls', () => {
  test('S179 openChild answers ENOSYS and nothing is made', async () => {
    const parent = await scratch();
    const disk = macOS(() => {
      throw new Error('the C library could not be loaded');
    });
    const top = await disk.openDirectory(parent);
    expect(top.at).toBeUndefined();
    await expect(top.openChild('a', { mode: 0o700 })).rejects.toMatchObject({ code: 'ENOSYS' });
    await expect(top.openChild('a')).rejects.toMatchObject({ code: 'ENOSYS' });
    expect(await stat(`${parent}/a`).catch(() => undefined)).toBeUndefined();
    await top.close();
  });
});

describe('S179 openChild refuses a name that is not one plain name, and a descriptor that stopped naming its folder', () => {
  test('S179 a name with a slash, a dot, an empty name or a NUL is refused EINVAL on either host', async () => {
    const parent = await scratch();
    await mkdir(`${parent}/a`);
    for (const disk of [nodeFs(() => crypto.randomUUID()), macOS()]) {
      const top = await disk.openDirectory(parent);
      for (const leaf of ['a/b', '..', '.', '', 'a\0b']) {
        await expect(top.openChild(leaf, { mode: 0o700 })).rejects.toMatchObject({ code: 'EINVAL' });
      }
      await top.close();
    }
  });

  test('S179 a held folder whose descriptor number now names another folder answers EBADF and makes nothing', async () => {
    const parent = await scratch();
    await mkdir(`${parent}/held`);
    await mkdir(`${parent}/other`);
    const top = await nodeFs(() => crypto.randomUUID()).openDirectory(`${parent}/held`);
    const fd = Number(/\/proc\/self\/fd\/(\d+)\//.exec(top.entryPath('x') ?? '')?.[1]);
    replaceDescriptor(fd, `${parent}/other`);
    await expect(top.openChild('made', { mode: 0o700 })).rejects.toMatchObject({ code: 'EBADF' });
    expect(await stat(`${parent}/other/made`).catch(() => undefined)).toBeUndefined();
    expect(await stat(`${parent}/held/made`).catch(() => undefined)).toBeUndefined();
    await top.close();
  });

  test('R-0198 openFile refuses a name that is not one plain name (EINVAL) on either host', async () => {
    const parent = await scratch();
    await writeFile(`${parent}/f.txt`, 'fixture');
    for (const disk of [nodeFs(() => crypto.randomUUID()), macOS()]) {
      const top = await disk.openDirectory(parent);
      for (const leaf of ['a/b', '..', '.', '', 'a\0b']) {
        await expect(top.openFile(leaf)).rejects.toMatchObject({ code: 'EINVAL' });
      }
      await top.close();
    }
  });

  test('R-0198 openFile on a top folder of a host with the C calls reads the file through the held descriptor', async () => {
    const parent = await scratch();
    await writeFile(`${parent}/f.txt`, 'fixture');
    const top = await macOS().openDirectory(parent);
    const file = await top.openFile('f.txt');
    expect(new TextDecoder().decode(await file.read())).toBe('fixture');
    await file.close();
    await top.close();
  });

  test('R-0198 a held folder whose descriptor number now names another folder answers EBADF to openFile and opens nothing', async () => {
    const parent = await scratch();
    await mkdir(`${parent}/held`);
    await mkdir(`${parent}/other`);
    await writeFile(`${parent}/held/f.txt`, 'held');
    await writeFile(`${parent}/other/f.txt`, 'other');
    const top = await nodeFs(() => crypto.randomUUID()).openDirectory(`${parent}/held`);
    const fd = Number(/\/proc\/self\/fd\/(\d+)\//.exec(top.entryPath('x') ?? '')?.[1]);
    replaceDescriptor(fd, `${parent}/other`);
    await expect(top.openFile('f.txt')).rejects.toMatchObject({ code: 'EBADF' });
    await top.close();
  });
});

describe('S179 the real mkdirat refuses with the errno it set', () => {
  const TOO_LONG = 'n'.repeat(300);

  test('S179 loadDescriptorCalls().mkdirat answers ENAMETOOLONG for a name the filesystem cannot hold', async () => {
    const parent = await scratch();
    const calls = loadDescriptorCalls();
    const fd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      expect(() => {
        calls.mkdirat(fd, TOO_LONG, 0o700);
      }).toThrow(expect.objectContaining({ code: 'ENAMETOOLONG', message: 'ENAMETOOLONG: make a folder' }));
      // And it makes a folder when it can (the call is the real one).
      calls.mkdirat(fd, 'real', 0o700);
      expect((await stat(`${parent}/real`)).isDirectory()).toBe(true);
      expect(() => {
        calls.mkdirat(fd, 'real', 0o700);
      }).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    } finally {
      closeSync(fd);
    }
  });

  test('S179 a held folder rethrows a make-a-folder failure that is not EEXIST, and reports EEXIST as not created', async () => {
    const parent = await scratch();
    const top = await macOS(() => loadDescriptorCalls()).openDirectory(parent);
    const steps = top.at;
    if (steps === undefined) throw new Error('the real calls load on Linux');
    await expect(steps.makeFolder(TOO_LONG, 0o700)).rejects.toMatchObject({ code: 'ENAMETOOLONG' });
    expect(await steps.makeFolder('made', 0o700)).toBe(true);
    expect(await steps.makeFolder('made', 0o700)).toBe(false);
    expect(((await stat(`${parent}/made`)).mode & 0o777).toString(8)).toBe('700');
    await top.close();
  });
});
