/**
 * What the `imports` root answers when the descriptor read of a file fails, and that no descriptor is left open on any
 * path. The host is the macOS shape (no `/proc/self/fd`, the C calls loaded as stand-ins over `/proc/self/fd`) so the
 * read goes through `FolderSteps.openFile`; the stand-in `openat` counts every descriptor it hands out and can fail or
 * swap at the file. A refusal carries the refusal alone: never an absolute path, never the errno's text.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { fstatSync, linkSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { type DescriptorCalls, isSingleName } from '../../../host/adapters/pinned/descriptor-calls.ts';
import { RootError, rootsPortFor } from '../../../host/roots.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const TEXT = 'ERRNO-FIXTURE-TEXT';
const NO_PROC = '/nonexistent-descriptor-folder';

const isOpen = (fd: number): boolean => {
  try {
    fstatSync(fd);
    return true;
  } catch {
    return false;
  }
};

/** What the stand-in `openat` does at the file `f.txt`: nothing, fail with an errno, or open and then run `after`. */
interface AtTheFile {
  fail?: string;
  after?: () => void;
}

async function world() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-imports-errno-`));
  parents.push(parent);
  const proj = `${parent}/proj`;
  const scoped = `${proj}/skills`;
  await mkdir(scoped, { recursive: true });
  await writeFile(`${scoped}/f.txt`, TEXT);
  await mkdir(`${parent}/home/state`, { recursive: true, mode: 0o700 });
  const handed: number[] = [];
  const at: AtTheFile = {};
  const through = (fd: number, name: string): string => {
    if (!isSingleName(name)) throw Object.assign(new Error('EINVAL: name'), { code: 'EINVAL' });
    return `/proc/self/fd/${String(fd)}/${name}`;
  };
  const calls = (): DescriptorCalls => ({
    openat: (fd, name, flags, mode) => {
      if (name === 'f.txt' && at.fail !== undefined)
        throw Object.assign(new Error(`${at.fail}: open '${scoped}/f.txt'`), { code: at.fail });
      const opened = openSync(through(fd, name), flags, mode);
      handed.push(opened);
      if (name === 'f.txt') at.after?.();
      return opened;
    },
    renameat: (from, fromName, to, toName) => renameSync(through(from, fromName), through(to, toName)),
    linkat: (from, fromName, to, toName) => linkSync(through(from, fromName), through(to, toName)),
    unlinkat: (fd, name) => unlinkSync(through(fd, name)),
    mkdirat: (fd, name, mode) => mkdirSync(through(fd, name), { mode }),
  });
  const root = rootsPortFor(
    nodeFs(() => crypto.randomUUID(), { descriptorFolder: NO_PROC, descriptorCalls: calls }),
    { home: `${parent}/home`, plugin: 'skills', worktrees: `${parent}/home-worktrees` },
    ['imports'],
    () => undefined,
  ).root('imports', { subfolder: scoped, within: proj });
  const file = (() => {
    const resolved = root.resolve(`${scoped}/f.txt`);
    if (!resolved.ok) throw new Error(resolved.error);
    return resolved.value;
  })();
  return { parent, scoped, root, file, handed, at };
}

async function refusalOf(call: () => Promise<unknown>): Promise<{ refusal: string; message: string } | undefined> {
  try {
    await call();
    return undefined;
  } catch (error) {
    if (error instanceof RootError) return { refusal: error.refusal, message: error.message };
    throw error;
  }
}

describe('R-0198 an open of the file that fails below a held folder is a content-free refusal', () => {
  const table: readonly (readonly [string, string])[] = [
    ['ELOOP', 'link_escape'],
    ['ENOTDIR', 'link_escape'],
    ['EACCES', 'changed'],
    ['ENOENT', 'changed'],
    ['EIO', 'changed'],
  ];
  for (const [errno, refusal] of table) {
    test(`R-0198 ${errno} at the file is ${refusal}: no path and no errno text in the answer, nothing left open`, async () => {
      const w = await world();
      w.at.fail = errno;
      const refused = await refusalOf(async () => await w.root.readText(w.file, 1000));
      expect(refused?.refusal).toBe(refusal);
      expect(refused?.message).not.toContain(w.parent);
      expect(refused?.message).not.toContain(errno);
      expect(w.handed.some(isOpen)).toBe(false);
    });
  }

  test('R-0198 ENOSYS at the file (a host whose calls cannot open it) reads it by path, as that host always did', async () => {
    const w = await world();
    w.at.fail = 'ENOSYS';
    expect(await w.root.readText(w.file, 1000)).toBe(TEXT);
    expect(w.handed.some(isOpen)).toBe(false);
  });
});

describe('R-0198 every descriptor the held read opened is closed, on every path', () => {
  test('R-0198 after a read that succeeds', async () => {
    const w = await world();
    expect(await w.root.readText(w.file, 1000)).toBe(TEXT);
    expect(w.handed.length).toBeGreaterThan(0);
    expect(w.handed.some(isOpen)).toBe(false);
  });

  test('R-0198 after a read whose holder throws while the file is open', async () => {
    const w = await world();
    const boom = new Error('the holder threw');
    const caught = await w.root
      .readDurable(w.file, 1000, async () => {
        throw boom;
      })
      .catch((error: unknown) => error);
    expect(caught).toBe(boom);
    expect(w.handed.some(isOpen)).toBe(false);
  });

  test('R-0198 after a file replaced right after it was opened (the proof that follows the open refuses)', async () => {
    const w = await world();
    w.at.after = () => {
      renameSync(`${w.scoped}/f.txt`, `${w.scoped}/f.moved`);
      writeFileSync(`${w.scoped}/f.txt`, 'REPLACED-FIXTURE');
    };
    const refused = await refusalOf(async () => await w.root.readText(w.file, 1000));
    expect(refused?.refusal).toBe('changed');
    expect(w.handed.some(isOpen)).toBe(false);
  });

  test('R-0198 after a listing and a stat', async () => {
    const w = await world();
    const folder = w.root.resolve(w.scoped);
    if (!folder.ok) throw new Error(folder.error);
    expect(await w.root.list(folder.value)).toEqual(['f.txt']);
    expect((await w.root.stat(w.file))?.size).toBe(TEXT.length);
    expect(w.handed.some(isOpen)).toBe(false);
  });
});
