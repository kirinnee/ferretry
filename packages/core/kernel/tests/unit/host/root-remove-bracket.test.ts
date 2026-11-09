/**
 * BG-002: where no path reaches a held folder (macOS has no `/proc/self/fd`), `RootHandle.remove` of a file, a link or a
 * folder TREE goes through the proven folder's descriptor, never a path: a parent swapped for a link between the judge
 * and the delete is refused (or deletes only inside the folder that was proven), and nothing outside is ever removed.
 *
 * This box is Linux, so the host under test is a REAL `nodeFs` whose `descriptorFolder` is absent and whose descriptor
 * calls and working-directory bracket are injected. Two providers run every case:
 *   - `stand-in`: the four calls AND the bracket's relative-name calls spelled over `/proc/self/fd/N/name`, with a
 *     FAKE working directory (`fchdir` only records which descriptor is installed) so every case can assert the
 *     directory is back where it started;
 *   - `libc`: the REAL `bun:ffi` binding for the calls and for `fchdir` (`libc.so.6` here), the real relative-name
 *     calls and the real process working directory (read back with `getcwd`).
 * The darwin-only copy at the end loads the macOS library and cannot run on this box.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  closeSync,
  constants,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import type { RootHandle, RootName, RootsPort } from '../../../contract/ports.ts';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import {
  type BracketOps,
  DescriptorBracket,
  PROCESS_BRACKET_OPS,
} from '../../../host/adapters/pinned/descriptor-bracket.ts';
import {
  type DescriptorCalls,
  isSingleName,
  loadDescriptorCalls,
  O_CLOEXEC,
} from '../../../host/adapters/pinned/descriptor-calls.ts';
import { fstatOf, folderSteps, type FolderSteps } from '../../../host/adapters/pinned/descriptor-folder.ts';
import { loadDirectorySyscalls } from '../../../host/adapters/pinned/directory-syscalls.ts';
import { WorkingDirectory } from '../../../host/adapters/pinned/working-directory.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';

const parents: string[] = [];
const descriptors: number[] = [];
afterEach(async () => {
  for (const fd of descriptors.splice(0)) {
    try {
      closeSync(fd);
    } catch {
      // already closed by the test
    }
  }
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const DECLARED: readonly RootName[] = ['fleet', 'agent-homes', 'worktrees'];
const NO_PROC = '/nonexistent-descriptor-folder';

type Verb = 'openat' | 'renameat' | 'linkat' | 'unlinkat' | 'fchdir' | 'here' | 'lstat' | 'list' | 'rmdir';
/** What a test does just BEFORE a call reaches the kernel (to swap a parent after the check, between two steps). */
type Before = (verb: Verb, args: readonly unknown[]) => void;

/** The four calls over `/proc/self/fd`, which Linux resolves from the held descriptor itself. */
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
  };
};

const watchedCalls = (inner: DescriptorCalls, before: Before): DescriptorCalls => ({
  openat: (fd, name, flags, mode) => {
    before('openat', [fd, name, flags, mode]);
    return inner.openat(fd, name, flags, mode);
  },
  renameat: (from, fromName, to, toName) => {
    before('renameat', [from, fromName, to, toName]);
    inner.renameat(from, fromName, to, toName);
  },
  linkat: (from, fromName, to, toName) => {
    before('linkat', [from, fromName, to, toName]);
    inner.linkat(from, fromName, to, toName);
  },
  unlinkat: (fd, name) => {
    before('unlinkat', [fd, name]);
    inner.unlinkat(fd, name);
  },
});

const watchedOps = (inner: BracketOps, before: Before): BracketOps => ({
  here: () => {
    before('here', []);
    return inner.here();
  },
  lstat: name => {
    before('lstat', [name]);
    return inner.lstat(name);
  },
  list: () => {
    before('list', []);
    return inner.list();
  },
  rmdir: name => {
    before('rmdir', [name]);
    inner.rmdir(name);
  },
});

/** The relative-name calls over a FAKE working directory: whichever descriptor `fchdir` installed last. */
const fakeOps = (cwd: () => number): BracketOps => {
  const here = (name: string): string => `/proc/self/fd/${String(cwd())}/${name}`;
  return {
    here: () => lstatSync(here('.'), { bigint: true }),
    lstat: name => {
      try {
        return lstatSync(here(name), { bigint: true });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
        throw error;
      }
    },
    list: () => readdirSync(here('.')).sort(),
    rmdir: name => {
      rmdirSync(here(name));
    },
  };
};

/** What a provider hands a test: the injected calls and bracket, and whether the working directory is back. */
interface Layer {
  readonly calls: DescriptorCalls;
  readonly bracket: DescriptorBracket;
  readonly directory: WorkingDirectory;
  /** The descriptors `fchdir` was asked to install, in order (the home restores included). */
  readonly installed: number[];
  /** Whether the process (fake or real) is in the working directory it started in. */
  restored(): boolean;
}

interface LayerOptions {
  /** Makes the `fchdir` that goes back home fail (the directory falls back to `/`). */
  readonly failRestore?: boolean;
}

const fakeLayer = (before: Before, options: LayerOptions = {}): Layer => {
  const home = openSync(tmpdir(), constants.O_RDONLY | constants.O_DIRECTORY | O_CLOEXEC);
  const root = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | O_CLOEXEC);
  descriptors.push(home, root);
  const state = { cwd: home };
  const installed: number[] = [];
  const fchdir = (fd: number): number => {
    before('fchdir', [fd]);
    installed.push(fd);
    if (options.failRestore === true && fd === home) return -1;
    state.cwd = fd;
    return 0;
  };
  const directory = new WorkingDirectory(
    reason => {
      throw new Error(`stopped: ${reason}`);
    },
    () => root,
  );
  return {
    calls: watchedCalls(standIn(), before),
    bracket: new DescriptorBracket(
      fchdir,
      watchedOps(
        fakeOps(() => state.cwd),
        before,
      ),
      directory,
      () => home,
    ),
    directory,
    installed,
    restored: () => state.cwd === home,
  };
};

const realLayer = (before: Before): Layer => {
  const syscalls = loadDirectorySyscalls();
  const start = syscalls.currentDirectory();
  const installed: number[] = [];
  const directory = new WorkingDirectory();
  return {
    calls: watchedCalls(loadDescriptorCalls(), before),
    bracket: new DescriptorBracket(
      fd => {
        before('fchdir', [fd]);
        installed.push(fd);
        return syscalls.fchdir(fd);
      },
      watchedOps(PROCESS_BRACKET_OPS, before),
      directory,
    ),
    directory,
    installed,
    restored: () => syscalls.currentDirectory() === start,
  };
};

const PROVIDERS: readonly (readonly [string, (before: Before) => Layer])[] = [
  ['stand-in', before => fakeLayer(before)],
  ['libc', realLayer],
];

const at = (root: RootHandle, path: string): FencedPath => {
  const resolved = root.resolve(path);
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value;
};

async function refusalOf(call: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await call();
    return undefined;
  } catch (error) {
    if (error instanceof RootError) return error.refusal;
    throw error;
  }
}

const gone = async (path: string): Promise<boolean> => (await lstat(path).catch(() => undefined)) === undefined;
const isLink = async (path: string): Promise<boolean> =>
  (await lstat(path).catch(() => undefined))?.isSymbolicLink() === true;

/** Runs `act` once, the first time `matches` says so. */
const once = (matches: (verb: Verb, args: readonly unknown[]) => boolean, act: () => void): Before => {
  let done = false;
  return (verb, args) => {
    if (done || !matches(verb, args)) return;
    done = true;
    act();
  };
};

const swapSync = (folder: string, outside: string): (() => void) => {
  return () => {
    renameSync(folder, `${folder}-moved`);
    // a synchronous link: the swap must land before the very next kernel call
    symlinkSync(outside, folder);
  };
};

interface Fresh {
  readonly parent: string;
  readonly home: string;
  readonly dir: string;
  readonly outside: string;
  readonly fleet: RootHandle;
  readonly port: RootsPort;
  readonly layer: Layer;
}

/** A fleet root on a host without /proc, over `layer`; `homes/claude-a` holds `sub/`, and `outside/` is beside the home. */
async function fresh(layerOf: (before: Before) => Layer, before: () => Before = () => () => undefined): Promise<Fresh> {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/root-remove-bracket-`));
  parents.push(parent);
  const home = `${parent}/home`;
  await mkdir(`${home}/state`, { recursive: true, mode: 0o700 });
  await mkdir(`${home}/config`, { recursive: true, mode: 0o700 });
  await mkdir(`${parent}/outside`, { mode: 0o700 });
  const hook: Before = (verb, args) => before()(verb, args);
  const layer = layerOf(hook);
  const fs = nodeFs(() => crypto.randomUUID(), {
    descriptorFolder: NO_PROC,
    descriptorCalls: () => layer.calls,
    bracket: () => layer.bracket,
  });
  const layout = { home, plugin: 'runtimes', worktrees: `${home}-worktrees` };
  const port = rootsPortFor(fs, layout, DECLARED, () => undefined, {});
  await ensureInternalRootBases(
    nodeFs(() => crypto.randomUUID()),
    layout,
    DECLARED,
  );
  const fleet = port.root('fleet');
  await fleet.makeDirectory(at(fleet, 'homes/claude-a'));
  const dir = `${home}/fleet/homes/claude-a`;
  await mkdir(`${dir}/sub`, { mode: 0o700 });
  return { parent, home, dir, outside: `${parent}/outside`, fleet, port, layer };
}

/** A fresh world whose hook can be set after the layer is built (the paths of the swap are only known then). */
async function armed(layerOf: (before: Before) => Layer) {
  let hook: Before = () => undefined;
  const f = await fresh(layerOf, () => (verb, args) => hook(verb, args));
  return {
    ...f,
    arm: (next: Before): void => {
      hook = next;
    },
  };
}

for (const [provider, make] of PROVIDERS) {
  describe(`BG-002 RootHandle.remove through a held folder on a host without /proc [${provider}]`, () => {
    test('BG-002 a file is removed and its neighbours stay; the working directory is back', async () => {
      const f = await fresh(make);
      await writeFile(`${f.dir}/sub/victim`, 'V');
      await writeFile(`${f.dir}/sub/keep`, 'K');
      await f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/victim'));
      expect(await gone(`${f.dir}/sub/victim`)).toBe(true);
      expect(await readFile(`${f.dir}/sub/keep`, 'utf8')).toBe('K');
      expect(f.layer.restored()).toBe(true);
    });

    test('BG-002 a folder tree is removed whole, each folder through its own descriptor', async () => {
      const f = await fresh(make);
      await mkdir(`${f.dir}/sub/tree/deep/deeper`, { recursive: true, mode: 0o700 });
      await writeFile(`${f.dir}/sub/tree/a`, 'a');
      await writeFile(`${f.dir}/sub/tree/deep/b`, 'b');
      await writeFile(`${f.dir}/sub/tree/deep/deeper/c`, 'c');
      await writeFile(`${f.dir}/sub/sibling`, 's');
      await f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/tree'));
      expect(await gone(`${f.dir}/sub/tree`)).toBe(true);
      expect(await readFile(`${f.dir}/sub/sibling`, 'utf8')).toBe('s');
      expect(f.layer.restored()).toBe(true);
    });

    test('BG-002 a name that is not there is a no-op, and so is a second remove', async () => {
      const f = await fresh(make);
      await f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/absent'));
      await mkdir(`${f.dir}/sub/tree`, { mode: 0o700 });
      await f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/tree'));
      await f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/tree'));
      expect(await gone(`${f.dir}/sub/tree`)).toBe(true);
      expect(f.layer.restored()).toBe(true);
    });

    test('BG-002 onlyIfEmpty removes an empty folder, and refuses a folder that holds an entry with nothing removed', async () => {
      const f = await fresh(make);
      await mkdir(`${f.dir}/sub/empty`, { mode: 0o700 });
      await mkdir(`${f.dir}/sub/full`, { mode: 0o700 });
      await writeFile(`${f.dir}/sub/full/x`, 'x');
      await f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/empty'), { onlyIfEmpty: true });
      expect(await gone(`${f.dir}/sub/empty`)).toBe(true);
      expect(await refusalOf(() => f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/full'), { onlyIfEmpty: true }))).toBe(
        'not_empty',
      );
      expect(await readFile(`${f.dir}/sub/full/x`, 'utf8')).toBe('x');
      expect(f.layer.restored()).toBe(true);
    });

    test('BG-002 the leaf is never followed: a link to a file or to a folder is removed as a link and its target stays whole', async () => {
      const f = await fresh(make);
      await mkdir(`${f.outside}/folder`);
      await writeFile(`${f.outside}/folder/keep`, 'OUTSIDE');
      await writeFile(`${f.outside}/file`, 'OUTSIDE-FILE');
      await symlink(`${f.outside}/folder`, `${f.dir}/sub/to-folder`);
      await symlink(`${f.outside}/file`, `${f.dir}/sub/to-file`);
      await symlink(`${f.outside}/folder`, `${f.dir}/sub/to-folder-empty`);
      await f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/to-folder'));
      await f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/to-file'));
      await f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/to-folder-empty'), { onlyIfEmpty: true });
      expect(await gone(`${f.dir}/sub/to-folder`)).toBe(true);
      expect(await gone(`${f.dir}/sub/to-file`)).toBe(true);
      expect(await gone(`${f.dir}/sub/to-folder-empty`)).toBe(true);
      expect(await readFile(`${f.outside}/folder/keep`, 'utf8')).toBe('OUTSIDE');
      expect(await readFile(`${f.outside}/file`, 'utf8')).toBe('OUTSIDE-FILE');
      expect(f.layer.restored()).toBe(true);
    });

    test('BG-002 a link INSIDE a tree is unlinked as a link, never walked: its outside target keeps every file', async () => {
      const f = await fresh(make);
      await mkdir(`${f.outside}/folder`);
      await writeFile(`${f.outside}/folder/keep`, 'OUTSIDE');
      await mkdir(`${f.dir}/sub/tree`, { mode: 0o700 });
      await symlink(`${f.outside}/folder`, `${f.dir}/sub/tree/planted`);
      await writeFile(`${f.dir}/sub/tree/mine`, 'm');
      await f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/tree'));
      expect(await gone(`${f.dir}/sub/tree`)).toBe(true);
      expect(await readFile(`${f.outside}/folder/keep`, 'utf8')).toBe('OUTSIDE');
    });

    test('BG-002 a parent swapped for a link between the judge and the delete of a FILE deletes only inside the proven folder', async () => {
      const f = await armed(make);
      await mkdir(`${f.outside}`, { recursive: true });
      await writeFile(`${f.outside}/victim`, 'OUTSIDE');
      await writeFile(`${f.dir}/sub/victim`, 'INSIDE');
      let swaps = 0;
      f.arm(
        once(
          verb => verb === 'unlinkat',
          () => {
            swaps += 1;
            swapSync(`${f.dir}/sub`, f.outside)();
          },
        ),
      );
      await f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/victim'));
      expect(swaps).toBe(1);
      expect(await readFile(`${f.outside}/victim`, 'utf8')).toBe('OUTSIDE');
      expect(await gone(`${f.dir}/sub-moved/victim`)).toBe(true);
      expect(f.layer.restored()).toBe(true);
    });

    test('BG-002 a parent swapped for a link between the judge and the delete of a TREE never deletes the outside tree', async () => {
      const f = await armed(make);
      await mkdir(`${f.outside}/tree/deep`, { recursive: true });
      await writeFile(`${f.outside}/tree/deep/keep`, 'OUTSIDE');
      await writeFile(`${f.outside}/tree/top`, 'OUTSIDE-TOP');
      await mkdir(`${f.dir}/sub/tree/deep`, { recursive: true, mode: 0o700 });
      await writeFile(`${f.dir}/sub/tree/deep/mine`, 'INSIDE');
      let swaps = 0;
      f.arm(
        once(
          verb => verb === 'fchdir',
          () => {
            swaps += 1;
            swapSync(`${f.dir}/sub`, f.outside)();
          },
        ),
      );
      await f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/tree'));
      expect(swaps).toBe(1);
      expect(await readFile(`${f.outside}/tree/deep/keep`, 'utf8')).toBe('OUTSIDE');
      expect(await readFile(`${f.outside}/tree/top`, 'utf8')).toBe('OUTSIDE-TOP');
      expect(await gone(`${f.dir}/sub-moved/tree`)).toBe(true);
      expect(f.layer.restored()).toBe(true);
    });

    test('BG-002 the folder it holds swapped for a link at every step of a remove: nothing outside is ever removed', async () => {
      // the swap lands before the 1st, 2nd, ... bracket and call of one remove, in turn: the outside tree always stays
      for (let step = 1; step <= 8; step += 1) {
        const f = await armed(make);
        await mkdir(`${f.outside}/tree/deep`, { recursive: true });
        await writeFile(`${f.outside}/tree/deep/keep`, 'OUTSIDE');
        await mkdir(`${f.dir}/sub/tree/deep`, { recursive: true, mode: 0o700 });
        await writeFile(`${f.dir}/sub/tree/deep/mine`, 'INSIDE');
        let seen = 0;
        f.arm(
          once(
            () => {
              seen += 1;
              return seen === step;
            },
            swapSync(`${f.dir}/sub`, f.outside),
          ),
        );
        await f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/tree')).catch(error => {
          if (!(error instanceof RootError)) throw error;
        });
        expect(await readFile(`${f.outside}/tree/deep/keep`, 'utf8')).toBe('OUTSIDE');
        expect(f.layer.restored()).toBe(true);
      }
    });

    test('BG-002 a middle folder swapped for a link before it is opened is refused changed, and the outside tree stays whole', async () => {
      const f = await armed(make);
      await mkdir(`${f.outside}/mid/inner`, { recursive: true });
      await writeFile(`${f.outside}/mid/inner/keep`, 'OUTSIDE');
      await mkdir(`${f.dir}/sub/tree/mid/inner`, { recursive: true, mode: 0o700 });
      await writeFile(`${f.dir}/sub/tree/mid/inner/mine`, 'INSIDE');
      f.arm(
        once(
          (verb, args) => verb === 'openat' && args[1] === 'mid',
          swapSync(`${f.dir}/sub/tree/mid`, `${f.outside}/mid`),
        ),
      );
      expect(await refusalOf(() => f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/tree')))).toBe('changed');
      expect(await readFile(`${f.outside}/mid/inner/keep`, 'utf8')).toBe('OUTSIDE');
      expect(await isLink(`${f.dir}/sub/tree/mid`)).toBe(true);
      expect(f.layer.restored()).toBe(true);
    });

    test('BG-002 a middle folder swapped for a link after it was emptied is never rmdir-ed through the link: the outside folder stays', async () => {
      const f = await armed(make);
      await mkdir(`${f.outside}/mid`, { recursive: true });
      await writeFile(`${f.outside}/mid/keep`, 'OUTSIDE');
      await mkdir(`${f.dir}/sub/tree/mid`, { recursive: true, mode: 0o700 });
      await writeFile(`${f.dir}/sub/tree/mid/mine`, 'INSIDE');
      f.arm(
        once(
          (verb, args) => verb === 'rmdir' && args[0] === 'mid',
          swapSync(`${f.dir}/sub/tree/mid`, `${f.outside}/mid`),
        ),
      );
      await expect(f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/tree'))).rejects.toBeDefined();
      expect(await readFile(`${f.outside}/mid/keep`, 'utf8')).toBe('OUTSIDE');
      expect(f.layer.restored()).toBe(true);
    });

    test('BG-002 a middle folder replaced by a link after the listing goes as a link: the outside folder stays whole', async () => {
      const f = await armed(make);
      await mkdir(`${f.outside}/mid`, { recursive: true });
      await writeFile(`${f.outside}/mid/keep`, 'OUTSIDE');
      await mkdir(`${f.dir}/sub/tree/mid`, { recursive: true, mode: 0o700 });
      // the listing happens, then the folder is replaced by a link before the walk looks at it
      f.arm(
        once(
          (verb, args) => verb === 'lstat' && args[0] === 'mid',
          swapSync(`${f.dir}/sub/tree/mid`, `${f.outside}/mid`),
        ),
      );
      // the look saw a link (kind `link`): it goes as a link; the folder moved aside by the swap keeps `tree` from
      // being removed (a raw ENOTEMPTY, as on Linux), and the outside folder is untouched either way
      await expect(f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/tree'))).rejects.toBeDefined();
      expect(await readFile(`${f.outside}/mid/keep`, 'utf8')).toBe('OUTSIDE');
      expect(await gone(`${f.dir}/sub/tree/mid`)).toBe(true);
      expect(f.layer.restored()).toBe(true);
    });

    test('BG-002 a forged name (NUL, a spelling of the root, a way out) is refused outside before any step, and nothing is removed', async () => {
      const f = await fresh(make);
      await writeFile(`${f.dir}/sub/mine.txt`, 'MINE');
      await writeFile(`${f.outside}/file`, 'OUTSIDE');
      for (const forged of [
        `${f.dir}/sub/mine.tx\0t`,
        `${f.dir}\0/sub/mine.txt`,
        `${f.home}/fleet/`,
        `${f.home}/fleet/.`,
        `${f.home}/fleet/homes/claude-a/../../../x/`,
        `${f.outside}/file`,
      ])
        expect(await refusalOf(() => f.fleet.remove(forged as FencedPath))).toBe('outside');
      expect(await readFile(`${f.dir}/sub/mine.txt`, 'utf8')).toBe('MINE');
      expect(await readFile(`${f.outside}/file`, 'utf8')).toBe('OUTSIDE');
      expect(f.layer.installed).toEqual([]);
    });

    test('BG-002 the working directory is back after a success, after a refusal and after a throw', async () => {
      const f = await fresh(make);
      await mkdir(`${f.dir}/sub/full`, { mode: 0o700 });
      await writeFile(`${f.dir}/sub/full/x`, 'x');
      await f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/full/x'));
      expect(f.layer.restored()).toBe(true);
      await writeFile(`${f.dir}/sub/full/y`, 'y');
      expect(await refusalOf(() => f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/full'), { onlyIfEmpty: true }))).toBe(
        'not_empty',
      );
      expect(f.layer.restored()).toBe(true);
    });

    test('BG-002 the working directory is back after a step that threw (a folder swapped for a link under its own rmdir)', async () => {
      const f = await armed(make);
      await mkdir(`${f.outside}/mid`, { recursive: true });
      await mkdir(`${f.dir}/sub/tree/mid`, { recursive: true, mode: 0o700 });
      f.arm(
        once(
          (verb, args) => verb === 'rmdir' && args[0] === 'mid',
          swapSync(`${f.dir}/sub/tree/mid`, `${f.outside}/mid`),
        ),
      );
      await expect(f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/tree'))).rejects.toBeDefined();
      expect(f.layer.restored()).toBe(true);
      // the bracket is not stuck open: the next remove works
      await writeFile(`${f.dir}/sub/after`, 'a');
      await f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/after'));
      expect(await gone(`${f.dir}/sub/after`)).toBe(true);
    });
  });
}

describe('BG-002 the bracket', () => {
  /** A held folder on a real directory, and a bracket whose fake working directory the test can read. */
  async function held() {
    const parent = await realpath(await mkdtemp(`${tmpdir()}/root-remove-bracket-unit-`));
    parents.push(parent);
    await mkdir(`${parent}/a`);
    await mkdir(`${parent}/b`);
    await writeFile(`${parent}/a/inside`, 'x');
    const fd = openSync(`${parent}/a`, constants.O_RDONLY | constants.O_DIRECTORY | O_CLOEXEC);
    const other = openSync(`${parent}/b`, constants.O_RDONLY | constants.O_DIRECTORY | O_CLOEXEC);
    descriptors.push(fd, other);
    const stats = lstatSync(`${parent}/a`, { bigint: true });
    const wrong = lstatSync(`${parent}/b`, { bigint: true });
    const layer = fakeLayer(() => undefined);
    return {
      parent,
      fd,
      other,
      layer,
      target: { device: stats.dev, inode: stats.ino },
      wrong: { device: wrong.dev, inode: wrong.ino },
    };
  }

  test('BG-002 it installs the proven folder, runs ONE step on a relative name and puts the directory back', () => {
    return held().then(h => {
      const seen = h.layer.bracket.run(h.fd, h.target, ops => ops.list());
      expect(seen).toEqual(['inside']);
      expect(h.layer.installed).toHaveLength(2);
      expect(h.layer.installed[0]).toBe(h.fd);
      expect(h.layer.restored()).toBe(true);
    });
  });

  test('BG-002 a descriptor that is not the folder it was held for is refused at the bracket, with the directory put back', async () => {
    const h = await held();
    let ran = false;
    expect(() =>
      h.layer.bracket.run(h.other, h.target, () => {
        ran = true;
      }),
    ).toThrow(/did not reach the folder installed/);
    expect(ran).toBe(false);
    expect(h.layer.restored()).toBe(true);
    // and the bracket is usable again afterwards
    expect(h.layer.bracket.run(h.fd, h.target, ops => ops.list())).toEqual(['inside']);
  });

  test('BG-002 a step that throws still puts the directory back, and the throw is the step’s own', async () => {
    const h = await held();
    expect(() =>
      h.layer.bracket.run(h.fd, h.target, () => {
        throw Object.assign(new Error('boom'), { code: 'EBOOM' });
      }),
    ).toThrow('boom');
    expect(h.layer.restored()).toBe(true);
    expect(h.layer.installed.at(-1)).not.toBe(h.fd);
  });

  test('BG-002 a second bracket opened inside a step is refused (one at a time) and the first still restores', async () => {
    const h = await held();
    let inner: unknown;
    h.layer.bracket.run(h.fd, h.target, () => {
      try {
        h.layer.bracket.run(h.fd, h.target, () => 'nested');
      } catch (error) {
        inner = error;
      }
    });
    expect((inner as { code?: string }).code).toBe('EBUSY');
    expect(h.layer.restored()).toBe(true);
    // the refused one installed nothing: exactly one install and one restore
    expect(h.layer.installed).toHaveLength(2);
    expect(h.layer.bracket.run(h.fd, h.target, ops => ops.list())).toEqual(['inside']);
  });

  test('BG-002 a step may not wait: a step that hands back a promise is refused and the directory is put back', async () => {
    const h = await held();
    expect(() => h.layer.bracket.run(h.fd, h.target, () => Promise.resolve(1))).toThrow(/may not wait/);
    expect(h.layer.restored()).toBe(true);
  });

  test('BG-002 a folder that cannot be installed is refused EBADF and nothing runs', async () => {
    const h = await held();
    const bracket = new DescriptorBracket(
      () => -1,
      fakeOps(() => h.fd),
      new WorkingDirectory(),
      () => h.fd,
    );
    let ran = false;
    expect(() =>
      bracket.run(h.fd, h.target, () => {
        ran = true;
      }),
    ).toThrow(/could not be installed/);
    expect(ran).toBe(false);
    // not stuck busy
    expect(() => bracket.run(h.fd, h.target, () => 1)).toThrow(/could not be installed/);
  });

  test('BG-002 a directory that cannot be restored falls back to / and every later bracket refuses', async () => {
    const parent = await realpath(await mkdtemp(`${tmpdir()}/root-remove-bracket-restore-`));
    parents.push(parent);
    await mkdir(`${parent}/a`);
    const fd = openSync(`${parent}/a`, constants.O_RDONLY | constants.O_DIRECTORY | O_CLOEXEC);
    descriptors.push(fd);
    const stats = lstatSync(`${parent}/a`, { bigint: true });
    const layer = fakeLayer(() => undefined, { failRestore: true });
    expect(() => layer.bracket.run(fd, { device: stats.dev, inode: stats.ino }, ops => ops.list())).toThrow(
      /refusing to go on/,
    );
    expect(layer.directory.broken).toBeDefined();
    expect(() => layer.bracket.run(fd, { device: stats.dev, inode: stats.ino }, ops => ops.list())).toThrow(
      /working directory could not be restored/,
    );
  });
});

describe('BG-002 the removal steps refuse a name that is not one plain segment', () => {
  test('BG-002 NUL, `..`, `.`, `/` and the empty name are refused EINVAL before any bracket or call', async () => {
    const parent = await realpath(await mkdtemp(`${tmpdir()}/root-remove-bracket-names-`));
    parents.push(parent);
    await mkdir(`${parent}/a`);
    await writeFile(`${parent}/keep`, 'K');
    const fd = openSync(`${parent}/a`, constants.O_RDONLY | constants.O_DIRECTORY | O_CLOEXEC);
    descriptors.push(fd);
    const stats = await fstatOf(fd);
    const layer = fakeLayer(() => undefined);
    const steps: FolderSteps = folderSteps(
      layer.calls,
      { fd, device: stats.dev, inode: stats.ino },
      async handle => {
        const s = await fstatOf(handle);
        return {
          kind: s.isDirectory() ? 'directory' : 'file',
          device: s.dev,
          inode: s.ino,
          links: Number(s.nlink),
          size: Number(s.size),
          mtimeMs: Number(s.mtimeMs),
          mtimeNs: s.mtimeNs,
          ctimeNs: s.ctimeNs,
          mode: Number(s.mode) & 0o7777,
          owner: Number(s.uid),
          group: Number(s.gid),
        };
      },
      {
        bracket: layer.bracket,
        identityOfStats: () => {
          throw new Error('not reached');
        },
      },
    );
    const removal = steps.removal;
    if (removal === undefined) throw new Error('the removal steps must exist when a bracket is given');
    for (const bad of ['', '.', '..', 'a/b', '../keep', 'x\0y', '/etc']) {
      for (const [verb, call] of [
        ['lstat', () => removal.lstat(bad)],
        ['rmdir', () => removal.rmdir(bad)],
        ['openFolder', () => removal.openFolder(bad)],
        ['unlink', () => steps.unlink(bad)],
      ] as const) {
        const error = await call().then(
          () => undefined,
          (thrown: unknown) => thrown as { code?: string },
        );
        expect([verb, error?.code]).toEqual([verb, 'EINVAL']);
      }
    }
    expect(layer.installed).toEqual([]);
    expect(await readFile(`${parent}/keep`, 'utf8')).toBe('K');
  });
});

describe('BG-002 without the bracket the answer stays no_descriptor_reach', () => {
  test('BG-002 calls loaded but no bracket: a folder remove refuses no_descriptor_reach, a file is still unlinked', async () => {
    const f = await fresh(
      before => ({ ...fakeLayer(before) }),
      () => () => undefined,
    );
    // rebuild the host over the same disk with calls and NO bracket
    const fs: HostFs = nodeFs(() => crypto.randomUUID(), {
      descriptorFolder: NO_PROC,
      descriptorCalls: () => standIn(),
      bracket: () => {
        throw new Error('the bracket could not be loaded');
      },
    });
    const layout = { home: f.home, plugin: 'runtimes', worktrees: `${f.home}-worktrees` };
    const port = rootsPortFor(fs, layout, DECLARED, () => undefined, {});
    const fleet = port.root('fleet');
    await mkdir(`${f.dir}/sub/tree`, { mode: 0o700 });
    await writeFile(`${f.dir}/sub/tree/a`, 'a');
    await writeFile(`${f.dir}/sub/file`, 'f');
    expect(await refusalOf(() => fleet.remove(at(fleet, 'homes/claude-a/sub/tree')))).toBe('no_descriptor_reach');
    expect(await readFile(`${f.dir}/sub/tree/a`, 'utf8')).toBe('a');
    await fleet.remove(at(fleet, 'homes/claude-a/sub/file'));
    expect(await gone(`${f.dir}/sub/file`)).toBe(true);
  });

  test('BG-002 on Linux with /proc the bracket is never asked for', async () => {
    const parent = await realpath(await mkdtemp(`${tmpdir()}/root-remove-bracket-linux-`));
    parents.push(parent);
    let asked = 0;
    const fs = nodeFs(() => 'x', {
      bracket: () => {
        asked += 1;
        return fakeLayer(() => undefined).bracket;
      },
    });
    const folder = await fs.openDirectory(parent);
    try {
      expect(folder.at).toBeUndefined();
    } finally {
      await folder.close();
    }
    expect(asked).toBe(0);
  });
});

describe('BG-002 an owner root (project-files) removes a tree through the held folder too', () => {
  test('BG-002 a skill folder is removed whole, and a parent swapped for a link first never reaches the outside tree', async () => {
    const parent = await realpath(await mkdtemp(`${tmpdir()}/root-remove-bracket-owner-`));
    parents.push(parent);
    const home = `${parent}/home`;
    const proj = `${parent}/proj`;
    const outside = `${parent}/outside`;
    for (const folder of [`${home}/state`, `${home}/config`, proj, outside])
      await mkdir(folder, { recursive: true, mode: 0o700 });
    let hook: Before = () => undefined;
    const layer = fakeLayer((verb, args) => hook(verb, args));
    const fs = nodeFs(() => crypto.randomUUID(), {
      descriptorFolder: NO_PROC,
      descriptorCalls: () => layer.calls,
      bracket: () => layer.bracket,
    });
    const port = rootsPortFor(
      fs,
      { home, plugin: 'mcp', worktrees: `${home}-worktrees` },
      ['project-files'],
      () => undefined,
      { random: () => 'rnd', setMode: true, projectFiles: ['.claude/skills/*/**'] },
    );
    const root = port.root('project-files', { subfolder: proj });
    await root.writeText(at(root, '.claude/skills/x/SKILL.md'), '# x');
    await root.writeText(at(root, '.claude/skills/x/a/b.md'), 'b');
    await root.remove(at(root, '.claude/skills/x'));
    expect(await gone(`${proj}/.claude/skills/x`)).toBe(true);
    expect(layer.restored()).toBe(true);

    await root.writeText(at(root, '.claude/skills/y/SKILL.md'), '# y');
    await mkdir(`${outside}/y`, { recursive: true });
    await writeFile(`${outside}/y/SKILL.md`, 'OUTSIDE');
    hook = once(verb => verb === 'fchdir', swapSync(`${proj}/.claude/skills`, outside));
    await root.remove(at(root, '.claude/skills/y')).catch(error => {
      if (!(error instanceof RootError)) throw error;
    });
    expect(await readFile(`${outside}/y/SKILL.md`, 'utf8')).toBe('OUTSIDE');
    expect(layer.restored()).toBe(true);
  });
});

// The same key cases against the real macOS library: libSystem.B.dylib, `__error`, and the real `fchdir` of the C
// library. This box is Linux, so it never runs here (a declared GAP: verified only by this copy on a Mac).
describe.skipIf(process.platform !== 'darwin')('BG-002 on macOS with the real libSystem calls and fchdir', () => {
  const real = (before: Before): Layer => {
    const syscalls = loadDirectorySyscalls();
    const start = syscalls.currentDirectory();
    const directory = new WorkingDirectory();
    const installed: number[] = [];
    return {
      calls: watchedCalls(loadDescriptorCalls(), before),
      bracket: new DescriptorBracket(
        fd => {
          before('fchdir', [fd]);
          installed.push(fd);
          return syscalls.fchdir(fd);
        },
        watchedOps(PROCESS_BRACKET_OPS, before),
        directory,
      ),
      directory,
      installed,
      restored: () => syscalls.currentDirectory() === start,
    };
  };

  test('BG-002 a tree is removed whole and a parent swapped before the delete never reaches the outside tree', async () => {
    const f = await armed(real);
    await mkdir(`${f.outside}/tree/deep`, { recursive: true });
    await writeFile(`${f.outside}/tree/deep/keep`, 'OUTSIDE');
    await mkdir(`${f.dir}/sub/tree/deep`, { recursive: true, mode: 0o700 });
    await writeFile(`${f.dir}/sub/tree/deep/mine`, 'INSIDE');
    f.arm(
      once(
        verb => verb === 'fchdir',
        () => swapSync(`${f.dir}/sub`, f.outside)(),
      ),
    );
    await f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/tree'));
    expect(await readFile(`${f.outside}/tree/deep/keep`, 'utf8')).toBe('OUTSIDE');
    expect(await gone(`${f.dir}/sub-moved/tree`)).toBe(true);
    expect(f.layer.restored()).toBe(true);
  });

  test('BG-002 a link leaf is removed as a link, its target untouched, and the working directory is back', async () => {
    const f = await fresh(real);
    await mkdir(`${f.outside}/folder`);
    await writeFile(`${f.outside}/folder/keep`, 'OUTSIDE');
    await symlink(`${f.outside}/folder`, `${f.dir}/sub/link`);
    await f.fleet.remove(at(f.fleet, 'homes/claude-a/sub/link'));
    expect(await gone(`${f.dir}/sub/link`)).toBe(true);
    expect(await readFile(`${f.outside}/folder/keep`, 'utf8')).toBe('OUTSIDE');
    expect(f.layer.restored()).toBe(true);
  });

  test('BG-002 the default nodeFs loads the library and the bracket by itself and removes a tree', async () => {
    const parent = await realpath(await mkdtemp(`${tmpdir()}/root-remove-bracket-darwin-`));
    parents.push(parent);
    await mkdir(`${parent}/tree/deep`, { recursive: true });
    await writeFile(`${parent}/tree/deep/a`, 'a');
    const fs = nodeFs(() => crypto.randomUUID());
    const folder = await fs.openDirectory(parent);
    try {
      const removal = folder.at?.removal;
      expect(removal).toBeDefined();
      const tree = await removal?.openFolder('tree');
      expect(await tree?.steps.removal?.list()).toEqual(['deep']);
      await tree?.close();
    } finally {
      await folder.close();
    }
  });
});
