/**
 * `OpenedDirectory.renameNoReplace`: `renameat2(RENAME_NOREPLACE)` between two held folders, on a real disk. Loaded and
 * self-tested once on Linux; absent where it did not load or failed its self-test, and never bound on another platform.
 * The history-pool move (`RootHandle.moveToHistoryPool`) depends on exactly these answers.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { copyFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { nodeFs, type OpenedDirectory } from '../../../host/adapters/node-fs.ts';
import {
  loadNoReplaceRename,
  type NoReplaceRename,
  selfTestNoReplaceRename,
} from '../../../host/adapters/pinned/descriptor-calls.ts';
import { heldFolderOf } from '../../../host/adapters/pinned/descriptor-folder.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

async function folders(): Promise<{ readonly a: string; readonly b: string; readonly parent: string }> {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-noreplace-test-`));
  parents.push(parent);
  await mkdir(`${parent}/a`);
  await mkdir(`${parent}/b`);
  return { a: `${parent}/a`, b: `${parent}/b`, parent };
}

/** The folder's no-replace move, which this Linux host must have. */
const moveOf = (folder: OpenedDirectory): NonNullable<OpenedDirectory['renameNoReplace']> => {
  const move = folder.renameNoReplace;
  if (move === undefined) throw new Error('this host has no no-replace move');
  return move;
};

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
};

const nativeHost = process.platform === 'linux' || process.platform === 'darwin';
describe.skipIf(!nativeHost)('renameNoReplace on the native host', () => {
  test('moves between two held folders, and a taken name is EEXIST with both files untouched', async () => {
    const { a, b } = await folders();
    await writeFile(`${a}/x`, 'source');
    await writeFile(`${b}/taken`, 'target');
    const fs = nodeFs(() => crypto.randomUUID());
    const from = await fs.openDirectory(a);
    const to = await fs.openDirectory(b);
    try {
      expect(from.renameNoReplace).toBeDefined();
      expect(await codeOf(moveOf(from)('x', to, 'taken'))).toBe('EEXIST');
      expect(await readFile(`${a}/x`, 'utf8')).toBe('source');
      expect(await readFile(`${b}/taken`, 'utf8')).toBe('target');
      await moveOf(from)('x', to, 'free');
      expect(await readdir(a)).toEqual([]);
      expect(await readFile(`${b}/free`, 'utf8')).toBe('source');
      // a name that is not one plain segment never reaches the kernel
      for (const name of ['', '.', '..', 'a/b', 'a\0b'])
        expect(await codeOf(moveOf(to)(name, from, 'y'))).toBe('EINVAL');
    } finally {
      await from.close();
      await to.close();
    }
  });

  test('a folder this host never opened is refused EBADF, before anything moves', async () => {
    const { a, b } = await folders();
    await writeFile(`${a}/x`, 'source');
    const fs = nodeFs(() => crypto.randomUUID());
    const from = await fs.openDirectory(a);
    const real = await fs.openDirectory(b);
    try {
      expect(await codeOf(moveOf(from)('x', { ...real }, 'y'))).toBe('EBADF');
      expect(await readFile(`${a}/x`, 'utf8')).toBe('source');
    } finally {
      await from.close();
      await real.close();
    }
  });

  test('a folder closed and its descriptor number taken by another folder is refused EBADF, and nothing moves', async () => {
    const { a, b, parent } = await folders();
    await mkdir(`${parent}/c`);
    await writeFile(`${a}/x`, 'source');
    const fs = nodeFs(() => crypto.randomUUID());
    const from = await fs.openDirectory(a);
    const gone = await fs.openDirectory(b);
    const number = heldFolderOf(gone)?.fd;
    await gone.close();
    // the lowest free descriptor number is the one just released: another folder now stands where `gone` was
    const stranger = await fs.openDirectory(`${parent}/c`);
    try {
      expect(heldFolderOf(stranger)?.fd).toBe(number);
      expect(await codeOf(moveOf(from)('x', gone, 'y'))).toBe('EBADF');
      expect(await readFile(`${a}/x`, 'utf8')).toBe('source');
      expect(await readdir(`${parent}/c`)).toEqual([]);
    } finally {
      await from.close();
      await stranger.close();
    }
  });

  test('a call that changes a file while refusing, or does not move onto a free name, fails its self-test', async () => {
    const real = loadNoReplaceRename();
    const { parent } = await folders();
    const through = (fd: number, name: string): string => `/proc/self/fd/${String(fd)}/${name}`;
    const taken = (): never => {
      throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    };
    // refuses the taken name as it should, but damages the file it refused to move
    const damaging: NoReplaceRename = {
      renameNoReplace: fromFd => {
        writeFileSync(through(fromFd, 'a'), 'damaged');
        taken();
      },
    };
    await expect(selfTestNoReplaceRename(damaging, parent)).rejects.toThrow('a refused move changed a file');
    // refuses the taken name, then answers success for a free one without moving anything
    let calls = 0;
    const idle: NoReplaceRename = { renameNoReplace: () => (++calls === 1 ? taken() : undefined) };
    await expect(selfTestNoReplaceRename(idle, parent)).rejects.toThrow('a free name was not moved');
    // copies instead of moving: the source is still there
    calls = 0;
    const copying: NoReplaceRename = {
      renameNoReplace: (fromFd, fromName, toFd, toName) => {
        if (++calls === 1) return real.renameNoReplace(fromFd, fromName, toFd, toName);
        copyFileSync(through(fromFd, fromName), through(toFd, toName));
      },
    };
    await expect(selfTestNoReplaceRename(copying, parent)).rejects.toThrow('a free name was not moved');
    // moves, but what arrives is not what was sent
    calls = 0;
    const altering: NoReplaceRename = {
      renameNoReplace: (fromFd, fromName, toFd, toName) => {
        const call = ++calls;
        real.renameNoReplace(fromFd, fromName, toFd, toName);
        if (call === 2) writeFileSync(through(toFd, toName), 'altered');
      },
    };
    await expect(selfTestNoReplaceRename(altering, parent)).rejects.toThrow('a free name was not moved');
    expect((await readdir(parent)).sort()).toEqual(['a', 'b']);
  });

  test('a C library that cannot be loaded is one sentence, not a crash', () => {
    expect(() => loadNoReplaceRename('/nonexistent/libfy-no-such-library.so.0')).toThrow(
      "the C library's descriptor calls could not be loaded",
    );
  });

  test('the loaded call passes its own self-test', async () => {
    await selfTestNoReplaceRename(loadNoReplaceRename());
  });
});

describe('where there is no no-replace move', () => {
  test('a self-test that rejects leaves renameNoReplace undefined', async () => {
    const { a } = await folders();
    const fs = nodeFs(() => crypto.randomUUID(), {
      noReplaceRename: async () => await Promise.reject(new Error('self-test failed')),
    });
    const folder = await fs.openDirectory(a);
    try {
      expect(folder.renameNoReplace).toBeUndefined();
    } finally {
      await folder.close();
    }
  });

  test('a call that did not load leaves renameNoReplace undefined', async () => {
    const { a } = await folders();
    const fs = nodeFs(() => crypto.randomUUID(), {
      noReplaceRename: () => {
        throw new Error('not here');
      },
    });
    const folder = await fs.openDirectory(a);
    try {
      expect(folder.renameNoReplace).toBeUndefined();
    } finally {
      await folder.close();
    }
  });

  test('a call that replaces a taken name fails the self-test, and leaves no scratch folder', async () => {
    const { parent } = await folders();
    const replacing: NoReplaceRename = { renameNoReplace: () => undefined };
    await expect(selfTestNoReplaceRename(replacing, parent)).rejects.toThrow('taken name answered success');
    const refusingAll: NoReplaceRename = {
      renameNoReplace: () => {
        throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
      },
    };
    await expect(selfTestNoReplaceRename(refusingAll, parent)).rejects.toThrow('answered EINVAL');
    expect((await readdir(parent)).sort()).toEqual(['a', 'b']);
  });

  test('nothing is bound on an unsupported platform', () => {
    expect(() => loadNoReplaceRename(undefined, undefined, 'unsupported')).toThrow(
      'no exclusive rename on unsupported',
    );
  });

  test('a host with no descriptor path still moves through its held descriptors', async () => {
    const { a } = await folders();
    const fs = nodeFs(() => crypto.randomUUID(), { descriptorFolder: '/nonexistent-descriptor-folder' });
    const folder = await fs.openDirectory(a);
    try {
      await writeFile(`${a}/source`, 'held');
      await moveOf(folder)('source', folder, 'target');
      expect(await readFile(`${a}/target`, 'utf8')).toBe('held');
    } finally {
      await folder.close();
    }
  });
});
