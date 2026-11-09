/**
 * BG-001 and BG-003: where no path reaches a held folder (macOS has no `/proc/self/fd`), a rename between two held
 * folders, a root's write and its durable publish go through the folders' own descriptor calls (`openat`, `renameat`,
 * `linkat`, `unlinkat`), so a parent swapped for a link after the check can neither carry the move outside nor make a
 * rename overwrite an outside file.
 *
 * This box is Linux, so the host under test is a REAL `nodeFs` whose `descriptorFolder` is absent (no path reaches an
 * open descriptor, as on macOS) and whose descriptor calls are injected. Two providers run every case:
 *   - `stand-in`: the same four calls spelled over `/proc/self/fd/N/name`, which the Linux kernel resolves exactly as
 *     `openat`/`renameat` would (a held descriptor keeps naming its folder whatever the path above it becomes);
 *   - `libc`: the REAL `bun:ffi` binding (`loadDescriptorCalls`, `libc.so.6` here), so the marshalling is proven too.
 * The darwin-only copy at the end loads the library by its macOS name and cannot run on this box.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { closeSync, constants, fstatSync, linkSync, openSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import type { RootHandle, RootName } from '../../../contract/ports.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import {
  type DescriptorCalls,
  isSingleName,
  loadDescriptorCalls,
} from '../../../host/adapters/pinned/descriptor-calls.ts';
import { folderSteps, holdFolder } from '../../../host/adapters/pinned/descriptor-folder.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const DECLARED: readonly RootName[] = ['fleet', 'harness-home', 'downloads', 'agent-homes', 'worktrees'];
const NO_PROC = '/nonexistent-descriptor-folder';

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

/** What a test does just BEFORE a call reaches the kernel (to swap a parent after the check, between two steps). */
type Before = (verb: 'openat' | 'renameat' | 'linkat' | 'unlinkat', args: readonly unknown[]) => void;

const watched = (inner: DescriptorCalls, before: Before): DescriptorCalls => ({
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

/** What a create looked like when it happened: the umask in force during `openat`, and the new file's mode right after it. */
interface Seen {
  readonly umasks: number[];
  readonly modes: number[];
}

/**
 * Wraps `inner` to observe every CREATE. `ignoreMode` makes the call pass that mode whatever it was asked (an Apple
 * arm64 host reads the variadic mode from a stack slot the binding does not fill: the file gets an arbitrary one);
 * `failCreate` makes the create throw that errno code.
 */
const recording = (
  inner: DescriptorCalls,
  options: { readonly ignoreMode?: number; readonly failCreate?: string },
  seen: Seen,
): DescriptorCalls => ({
  ...inner,
  openat: (fd, name, flags, mode) => {
    if (!creates('openat', [fd, name, flags])) return inner.openat(fd, name, flags, mode);
    seen.umasks.push(process.umask());
    if (options.failCreate !== undefined)
      throw Object.assign(new Error(`${options.failCreate}: open`), { code: options.failCreate });
    const created = inner.openat(fd, name, flags, options.ignoreMode ?? mode);
    seen.modes.push(fstatSync(created).mode & 0o777);
    return created;
  },
});

/** Runs `act` with the process umask set to `mask`, put back after (the wider the umask-free case, the harder the test). */
async function withUmask(mask: number, act: () => Promise<unknown>): Promise<void> {
  const before = process.umask(mask);
  try {
    await act();
  } finally {
    process.umask(before);
  }
}

const PROVIDERS: readonly (readonly [string, () => DescriptorCalls])[] = [
  ['stand-in', standIn],
  ['libc', () => loadDescriptorCalls()],
];

async function fresh(calls: () => DescriptorCalls) {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/root-rename-ffi-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const owner = `${parent}/owner`;
  await mkdir(`${home}/state`, { recursive: true, mode: 0o700 });
  await mkdir(`${home}/config`, { recursive: true, mode: 0o700 });
  await mkdir(`${owner}/.claude`, { recursive: true, mode: 0o700 });
  await mkdir(`${home}-worktrees`, { recursive: true, mode: 0o700 });
  const fs = nodeFs(() => crypto.randomUUID(), { descriptorFolder: NO_PROC, descriptorCalls: calls });
  const port = rootsPortFor(
    fs,
    { home, plugin: 'runtimes', worktrees: `${home}-worktrees` },
    DECLARED,
    () => undefined,
    {
      setMode: true,
    },
  );
  await ensureInternalRootBases(
    nodeFs(() => crypto.randomUUID()),
    { home, plugin: 'runtimes' },
    DECLARED,
  );
  const fleet = port.root('fleet');
  await fleet.makeDirectory(at(fleet, 'homes/claude-a'));
  return { parent, home, fleet, dir: `${home}/fleet/homes/claude-a`, outside: `${parent}/outside` };
}

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

/** Runs `act` once, the first time `matches` says so. */
const once = (matches: (verb: string, args: readonly unknown[]) => boolean, act: () => void): Before => {
  let done = false;
  return (verb, args) => {
    if (done || !matches(verb, args)) return;
    done = true;
    act();
  };
};

const creates = (verb: string, args: readonly unknown[]): boolean =>
  verb === 'openat' && ((args[2] as number) & constants.O_CREAT) !== 0;

const swapSync = (folder: string, outside: string): (() => void) => {
  return () => {
    renameSync(folder, `${folder}-moved`);
    // a synchronous link: the swap must land before the very next kernel call
    symlinkSync(outside, folder);
  };
};

for (const [provider, make] of PROVIDERS) {
  describe(`BG-001 RootHandle.rename between two held folders on a host without /proc [${provider}]`, () => {
    test('BG-001 moves a file between two folders and back (the provisioner move-aside and undo)', async () => {
      const f = await fresh(make);
      await mkdir(`${f.dir}/a`, { mode: 0o700 });
      await mkdir(`${f.dir}/b`, { mode: 0o700 });
      await writeFile(`${f.dir}/a/settings.json`, '{"a":1}', { mode: 0o600 });
      await f.fleet.rename(at(f.fleet, 'homes/claude-a/a/settings.json'), at(f.fleet, 'homes/claude-a/b/aside'));
      expect(await gone(`${f.dir}/a/settings.json`)).toBe(true);
      expect(await readFile(`${f.dir}/b/aside`, 'utf8')).toBe('{"a":1}');
      await f.fleet.rename(at(f.fleet, 'homes/claude-a/b/aside'), at(f.fleet, 'homes/claude-a/a/settings.json'));
      expect(await readFile(`${f.dir}/a/settings.json`, 'utf8')).toBe('{"a":1}');
    });

    test('BG-001 a source parent swapped for a link after the check moves inside the held folder, never outside', async () => {
      let swapped = false;
      const f = await fresh(() =>
        watched(
          make(),
          once(
            verb => verb === 'renameat',
            () => {
              swapped = true;
              swapSync(`${f.dir}/sub`, f.outside)();
            },
          ),
        ),
      );
      await mkdir(f.outside);
      await writeFile(`${f.outside}/a`, 'OUTSIDE', { mode: 0o600 });
      await mkdir(`${f.dir}/sub`, { mode: 0o700 });
      await mkdir(`${f.dir}/dest`, { mode: 0o700 });
      await writeFile(`${f.dir}/sub/a`, 'AAA', { mode: 0o600 });
      await f.fleet.rename(at(f.fleet, 'homes/claude-a/sub/a'), at(f.fleet, 'homes/claude-a/dest/b'));
      expect(swapped).toBe(true);
      expect(await readFile(`${f.dir}/dest/b`, 'utf8')).toBe('AAA');
      expect(await readFile(`${f.outside}/a`, 'utf8')).toBe('OUTSIDE');
      expect(await readdir(f.outside)).toEqual(['a']);
    });

    test('BG-001 both held folders swapped after the check: the move stays between the two held folders', async () => {
      let swaps = 0;
      const f = await fresh(() =>
        watched(
          make(),
          once(
            verb => verb === 'renameat',
            () => {
              swaps += 1;
              swapSync(`${f.dir}/sub`, f.outside)();
              swapSync(`${f.dir}/dest`, f.outside)();
            },
          ),
        ),
      );
      await mkdir(f.outside);
      await writeFile(`${f.outside}/b`, 'OUTSIDE', { mode: 0o600 });
      await mkdir(`${f.dir}/sub`, { mode: 0o700 });
      await mkdir(`${f.dir}/dest`, { mode: 0o700 });
      await writeFile(`${f.dir}/sub/a`, 'AAA', { mode: 0o600 });
      await f.fleet.rename(at(f.fleet, 'homes/claude-a/sub/a'), at(f.fleet, 'homes/claude-a/dest/b'));
      expect(swaps).toBe(1);
      expect(await readFile(`${f.dir}/dest-moved/b`, 'utf8')).toBe('AAA');
      expect(await readFile(`${f.outside}/b`, 'utf8')).toBe('OUTSIDE');
    });

    test('BG-001 a link at the source moves as a link and is never followed', async () => {
      const f = await fresh(make);
      await mkdir(f.outside);
      await writeFile(`${f.outside}/secret`, 'OUTSIDE', { mode: 0o600 });
      await symlink(`${f.outside}/secret`, `${f.dir}/link`);
      await f.fleet.rename(at(f.fleet, 'homes/claude-a/link'), at(f.fleet, 'homes/claude-a/link.aside'));
      expect((await lstat(`${f.dir}/link.aside`)).isSymbolicLink()).toBe(true);
      expect(await gone(`${f.dir}/link`)).toBe(true);
      expect(await readFile(`${f.outside}/secret`, 'utf8')).toBe('OUTSIDE');
    });

    test('BG-001 a link (even a dangling one) at the destination counts as taken and is refused, never replaced', async () => {
      const f = await fresh(make);
      await writeFile(`${f.dir}/a`, 'AAA', { mode: 0o600 });
      await symlink(`${f.parent}/nowhere`, `${f.dir}/b`);
      expect(
        await refusalOf(() => f.fleet.rename(at(f.fleet, 'homes/claude-a/a'), at(f.fleet, 'homes/claude-a/b'))),
      ).toBe('outside');
      expect((await lstat(`${f.dir}/b`)).isSymbolicLink()).toBe(true);
      expect(await readFile(`${f.dir}/a`, 'utf8')).toBe('AAA');
    });

    test('BG-001 an existing destination is refused and both stay as they were', async () => {
      const f = await fresh(make);
      await writeFile(`${f.dir}/a`, 'AAA', { mode: 0o600 });
      await writeFile(`${f.dir}/b`, 'BBB', { mode: 0o600 });
      expect(
        await refusalOf(() => f.fleet.rename(at(f.fleet, 'homes/claude-a/a'), at(f.fleet, 'homes/claude-a/b'))),
      ).toBe('outside');
      expect(await readFile(`${f.dir}/a`, 'utf8')).toBe('AAA');
      expect(await readFile(`${f.dir}/b`, 'utf8')).toBe('BBB');
    });

    test('BG-001 a source that is not there is refused', async () => {
      const f = await fresh(make);
      expect(
        await refusalOf(() => f.fleet.rename(at(f.fleet, 'homes/claude-a/none'), at(f.fleet, 'homes/claude-a/b'))),
      ).toBe('outside');
    });

    test('BG-001 a folder moves whole', async () => {
      const f = await fresh(make);
      await mkdir(`${f.dir}/tree`, { mode: 0o700 });
      await writeFile(`${f.dir}/tree/x`, 'x', { mode: 0o600 });
      await f.fleet.rename(at(f.fleet, 'homes/claude-a/tree'), at(f.fleet, 'homes/claude-a/tree.aside'));
      expect(await readFile(`${f.dir}/tree.aside/x`, 'utf8')).toBe('x');
    });

    test('BG-001 a move the kernel refuses (another device) is `changed`, with nothing moved', async () => {
      const f = await fresh(() => ({
        ...make(),
        renameat: () => {
          throw Object.assign(new Error('EXDEV: rename'), { code: 'EXDEV' });
        },
      }));
      await writeFile(`${f.dir}/a`, 'AAA', { mode: 0o600 });
      expect(
        await refusalOf(() => f.fleet.rename(at(f.fleet, 'homes/claude-a/a'), at(f.fleet, 'homes/claude-a/b'))),
      ).toBe('changed');
      expect(await readFile(`${f.dir}/a`, 'utf8')).toBe('AAA');
    });

    test('BG-001 a name with a NUL, a `..` or a `/` never reaches the kernel as a path', async () => {
      const f = await fresh(make);
      await writeFile(`${f.dir}/a`, 'AAA', { mode: 0o600 });
      // refused where the name is made (`resolve`): no FencedPath exists for it, so no move can be asked for
      for (const bad of ['homes/claude-a/b\0c', 'homes/claude-a/../b', 'homes/claude-a/x/../../../b'])
        expect(f.fleet.resolve(bad)).toEqual({ ok: false, error: 'outside' });
      // and a forged FencedPath carrying one is refused by the move itself, nothing moved
      for (const forged of ['b\0c', '../b'])
        expect(
          await refusalOf(() => f.fleet.rename(at(f.fleet, 'homes/claude-a/a'), `${f.dir}/${forged}` as FencedPath)),
        ).toBeDefined();
      expect(await readFile(`${f.dir}/a`, 'utf8')).toBe('AAA');
    });
  });

  describe(`BG-003 writeChecked and publishChecked on a host without /proc [${provider}]`, () => {
    test('BG-003 a parent swapped for a link before the temp is created plants nothing outside, and the file lands in the held folder', async () => {
      let swapped = false;
      const f = await fresh(() =>
        watched(
          make(),
          once(creates, () => {
            swapped = true;
            swapSync(`${f.dir}/sub`, f.outside)();
          }),
        ),
      );
      await mkdir(f.outside);
      await writeFile(`${f.outside}/.mcp.json`, 'OUTSIDE', { mode: 0o600 });
      await mkdir(`${f.dir}/sub`, { mode: 0o700 });
      await f.fleet.writeText(at(f.fleet, 'homes/claude-a/sub/.mcp.json'), 'NEW');
      expect(swapped).toBe(true);
      expect(await readFile(`${f.dir}/sub-moved/.mcp.json`, 'utf8')).toBe('NEW');
      expect(await readFile(`${f.outside}/.mcp.json`, 'utf8')).toBe('OUTSIDE');
      expect(await readdir(f.outside)).toEqual(['.mcp.json']);
    });

    test('BG-003 a parent swapped for a link between the temp and the rename cannot make the rename overwrite an outside file', async () => {
      let swapped = false;
      const f = await fresh(() =>
        watched(
          make(),
          once(
            verb => verb === 'renameat',
            () => {
              swapped = true;
              swapSync(`${f.dir}/sub`, f.outside)();
            },
          ),
        ),
      );
      await mkdir(f.outside);
      await writeFile(`${f.outside}/.mcp.json`, 'OUTSIDE', { mode: 0o600 });
      await mkdir(`${f.dir}/sub`, { mode: 0o700 });
      await f.fleet.writeText(at(f.fleet, 'homes/claude-a/sub/.mcp.json'), 'NEW');
      expect(swapped).toBe(true);
      expect(await readFile(`${f.dir}/sub-moved/.mcp.json`, 'utf8')).toBe('NEW');
      expect(await readFile(`${f.outside}/.mcp.json`, 'utf8')).toBe('OUTSIDE');
      expect(await readdir(f.outside)).toEqual(['.mcp.json']);
    });

    test('BG-003 the same swap during a durable publish (replace) leaves the outside file alone', async () => {
      let swapped = false;
      const f = await fresh(() =>
        watched(
          make(),
          once(
            verb => verb === 'renameat',
            () => {
              swapped = true;
              swapSync(`${f.dir}/sub`, f.outside)();
            },
          ),
        ),
      );
      await mkdir(f.outside);
      await writeFile(`${f.outside}/state.json`, 'OUTSIDE', { mode: 0o600 });
      await mkdir(`${f.dir}/sub`, { mode: 0o700 });
      const published = await f.fleet.publish(
        at(f.fleet, 'homes/claude-a/sub/state.json'),
        new TextEncoder().encode('NEW'),
      );
      expect(published.outcome).toBe('published');
      expect(swapped).toBe(true);
      expect(await readFile(`${f.dir}/sub-moved/state.json`, 'utf8')).toBe('NEW');
      expect(await readFile(`${f.outside}/state.json`, 'utf8')).toBe('OUTSIDE');
      expect(await readdir(f.outside)).toEqual(['state.json']);
    });

    test('BG-003 the same swap during an exclusive publish (link) creates nothing outside', async () => {
      let swapped = false;
      const f = await fresh(() =>
        watched(
          make(),
          once(
            verb => verb === 'linkat',
            () => {
              swapped = true;
              swapSync(`${f.dir}/sub`, f.outside)();
            },
          ),
        ),
      );
      await mkdir(f.outside);
      await mkdir(`${f.dir}/sub`, { mode: 0o700 });
      const published = await f.fleet.publish(
        at(f.fleet, 'homes/claude-a/sub/once.json'),
        new TextEncoder().encode('NEW'),
        {
          exclusive: true,
        },
      );
      expect(published.outcome).toBe('published');
      expect(swapped).toBe(true);
      expect(await readFile(`${f.dir}/sub-moved/once.json`, 'utf8')).toBe('NEW');
      expect(await readdir(f.outside)).toEqual([]);
      expect(await readdir(`${f.dir}/sub-moved`)).toEqual(['once.json']);
    });

    test('BG-003 an exclusive publish onto a taken name reports exists and leaves no temp', async () => {
      const f = await fresh(make);
      await writeFile(`${f.dir}/once.json`, 'FIRST', { mode: 0o600 });
      const published = await f.fleet.publish(
        at(f.fleet, 'homes/claude-a/once.json'),
        new TextEncoder().encode('SECOND'),
        {
          exclusive: true,
        },
      );
      expect(published.outcome).toBe('exists');
      expect(await readFile(`${f.dir}/once.json`, 'utf8')).toBe('FIRST');
      expect(await readdir(f.dir)).toEqual(['once.json']);
    });

    test('BG-003 replacing over a link at the leaf is refused link_escape: the leaf is not followed and the target stays', async () => {
      const f = await fresh(make);
      await mkdir(f.outside);
      await writeFile(`${f.outside}/target`, 'OUTSIDE', { mode: 0o600 });
      await symlink(`${f.outside}/target`, `${f.dir}/leaf`);
      expect(
        await refusalOf(() => f.fleet.writeText(at(f.fleet, 'homes/claude-a/leaf'), 'NEW', { replaceExisting: true })),
      ).toBe('link_escape');
      expect(await readFile(`${f.outside}/target`, 'utf8')).toBe('OUTSIDE');
      expect((await lstat(`${f.dir}/leaf`)).isSymbolicLink()).toBe(true);
    });

    test('BG-003 an exclusive write onto a link is refused by the create itself and writes nothing through it', async () => {
      const f = await fresh(make);
      await mkdir(f.outside);
      await symlink(`${f.outside}/new`, `${f.dir}/leaf`);
      await f.fleet.writeText(at(f.fleet, 'homes/claude-a/leaf'), 'NEW', { exclusive: true }).then(
        () => {
          throw new Error('expected a refusal');
        },
        () => undefined,
      );
      expect(await gone(`${f.outside}/new`)).toBe(true);
    });

    test('BG-003 a write that renames fine keeps its exact mode and leaves no temp behind', async () => {
      const f = await fresh(make);
      await f.fleet.writeText(at(f.fleet, 'homes/claude-a/settings.json'), '{"a":1}', { mode: 0o640 });
      expect(await readFile(`${f.dir}/settings.json`, 'utf8')).toBe('{"a":1}');
      expect(((await lstat(`${f.dir}/settings.json`)).mode & 0o7777).toString(8)).toBe('640');
      expect(await readdir(f.dir)).toEqual(['settings.json']);
    });
  });

  describe(`BG-001 BG-003 an entry this process may not open is still seen, as lstat saw it [${provider}]`, () => {
    // The fake layer answers an open of `name` the way the kernel answers for an entry the caller has no permission for:
    // `read` for a read-only open, `write` for a write-only one (a code, or `undefined` to let the real open through).
    const unopenable = (
      inner: DescriptorCalls,
      name: string,
      answers: { readonly read: string; readonly write?: string },
      opened: string[],
    ): DescriptorCalls => ({
      ...inner,
      openat: (fd, leaf, flags, mode) => {
        if (leaf !== name || creates('openat', [fd, leaf, flags])) return inner.openat(fd, leaf, flags, mode);
        const code = (flags & 0o3) === constants.O_WRONLY ? answers.write : answers.read;
        opened.push(code ?? 'open');
        if (code === undefined) return inner.openat(fd, leaf, flags, mode);
        throw Object.assign(new Error(`${code}: open`), { code });
      },
    });

    const CASES: readonly (readonly [string, { read: string; write?: string }])[] = [
      ['a mode-000 file', { read: 'EACCES', write: 'EACCES' }],
      ['a folder without read permission (0300)', { read: 'EACCES', write: 'EISDIR' }],
      ['a unix socket', { read: 'ENXIO', write: 'ENXIO' }],
      ['a socket as macOS answers it', { read: 'EOPNOTSUPP', write: 'EOPNOTSUPP' }],
    ];

    for (const [what, answers] of CASES) {
      test(`BG-001 a rename of ${what} succeeds, as on a host with /proc, and the open error never reaches the caller`, async () => {
        const opened: string[] = [];
        const f = await fresh(() => unopenable(make(), 'src', answers, opened));
        await writeFile(`${f.dir}/src`, 'AAA', { mode: 0o600 });
        await f.fleet.rename(at(f.fleet, 'homes/claude-a/src'), at(f.fleet, 'homes/claude-a/dst'));
        expect(opened.length).toBeGreaterThan(0);
        expect(await readFile(`${f.dir}/dst`, 'utf8')).toBe('AAA');
        expect(await gone(`${f.dir}/src`)).toBe(true);
      });

      test(`BG-001 ${what} at the destination counts as taken: the rename is refused outside, nothing moves`, async () => {
        const f = await fresh(() => unopenable(make(), 'dst', answers, []));
        await writeFile(`${f.dir}/src`, 'AAA', { mode: 0o600 });
        await writeFile(`${f.dir}/dst`, 'BBB', { mode: 0o600 });
        expect(
          await refusalOf(() => f.fleet.rename(at(f.fleet, 'homes/claude-a/src'), at(f.fleet, 'homes/claude-a/dst'))),
        ).toBe('outside');
        expect(await readFile(`${f.dir}/src`, 'utf8')).toBe('AAA');
        expect(await readFile(`${f.dir}/dst`, 'utf8')).toBe('BBB');
      });

      test(`BG-003 replaceExisting over ${what} is refused outside when it cannot be read as a file, and the entry stays`, async () => {
        const f = await fresh(() => unopenable(make(), 'leaf', answers, []));
        await writeFile(`${f.dir}/leaf`, 'OLD', { mode: 0o600 });
        expect(
          await refusalOf(() =>
            f.fleet.writeText(at(f.fleet, 'homes/claude-a/leaf'), 'NEW', { replaceExisting: true }),
          ),
        ).toBe('outside');
        expect(await readFile(`${f.dir}/leaf`, 'utf8')).toBe('OLD');
        expect(await readdir(f.dir)).toEqual(['leaf']);
      });
    }

    test('BG-003 replaceExisting over a file that only has write permission replaces it and keeps its mode (a 0200 file)', async () => {
      const opened: string[] = [];
      const f = await fresh(() => unopenable(make(), 'leaf', { read: 'EACCES' }, opened));
      await writeFile(`${f.dir}/leaf`, 'OLD', { mode: 0o600 });
      await f.fleet.writeText(at(f.fleet, 'homes/claude-a/leaf'), 'NEW', { replaceExisting: true });
      expect(opened).toEqual(['EACCES', 'open']);
      expect(await readFile(`${f.dir}/leaf`, 'utf8')).toBe('NEW');
      expect(((await lstat(`${f.dir}/leaf`)).mode & 0o7777).toString(8)).toBe('600');
      expect(await readdir(f.dir)).toEqual(['leaf']);
    });

    test('BG-001 an open that fails for any other reason (a descriptor limit) is still a raw failure, never "something is there"', async () => {
      const f = await fresh(() => unopenable(make(), 'src', { read: 'EMFILE' }, []));
      await writeFile(`${f.dir}/src`, 'AAA', { mode: 0o600 });
      await expect(
        f.fleet.rename(at(f.fleet, 'homes/claude-a/src'), at(f.fleet, 'homes/claude-a/dst')),
      ).rejects.toMatchObject({ code: 'EMFILE' });
      expect(await readFile(`${f.dir}/src`, 'utf8')).toBe('AAA');
    });
  });

  describe(`BG-003 the temp file is never open to another user while it is created [${provider}]`, () => {
    test('BG-003 a create whose mode is ignored (an arbitrary 0o777) is still owner-only at the create, and exact after the fchmod', async () => {
      const seen: Seen = { umasks: [], modes: [] };
      const f = await fresh(() => recording(make(), { ignoreMode: 0o777 }, seen));
      await withUmask(0o000, () =>
        f.fleet.writeText(at(f.fleet, 'homes/claude-a/settings.json'), '{"a":1}', { mode: 0o644 }),
      );
      expect(seen.modes.length).toBe(1);
      // nothing another user could open: no group or other bit at the moment the name exists
      for (const mode of seen.modes) expect(mode & 0o077).toBe(0);
      expect(((await lstat(`${f.dir}/settings.json`)).mode & 0o7777).toString(8)).toBe('644');
      expect(await readdir(f.dir)).toEqual(['settings.json']);
    });

    test('BG-003 a wide requested mode is applied by the fchmod only after the create, never by the create itself', async () => {
      const seen: Seen = { umasks: [], modes: [] };
      const f = await fresh(() => recording(make(), {}, seen));
      await withUmask(0o000, () =>
        f.fleet.writeText(at(f.fleet, 'homes/claude-a/wide.json'), 'W', { mode: 0o666, exclusive: true }),
      );
      expect(seen.umasks).toEqual([0o077]);
      for (const mode of seen.modes) expect(mode & 0o077).toBe(0);
      expect(((await lstat(`${f.dir}/wide.json`)).mode & 0o7777).toString(8)).toBe('666');
    });

    test('BG-003 the process umask is back to what it was after a create and after a create that throws', async () => {
      const seen: Seen = { umasks: [], modes: [] };
      const f = await fresh(() => recording(make(), { failCreate: 'ENOSPC' }, seen));
      await withUmask(0o022, async () => {
        const refused = await f.fleet.writeText(at(f.fleet, 'homes/claude-a/a.json'), 'A').then(
          () => 'written',
          () => 'refused',
        );
        expect(refused).toBe('refused');
        expect(process.umask()).toBe(0o022);
      });
      expect(seen.umasks).toEqual([0o077]);
      const ok: Seen = { umasks: [], modes: [] };
      const g = await fresh(() => recording(make(), {}, ok));
      await withUmask(0o027, async () => {
        await g.fleet.writeText(at(g.fleet, 'homes/claude-a/b.json'), 'B');
        expect(process.umask()).toBe(0o027);
      });
      expect(ok.umasks).toEqual([0o077]);
    });
  });
}

describe('BG-001 the seam: what each refusal is made of', () => {
  test('BG-001 a held folder whose descriptor no longer names the folder it was opened on is refused, and nothing moves', async () => {
    const parent = await realpath(await mkdtemp(`${tmpdir()}/root-rename-ffi-held-`));
    parents.push(parent);
    await mkdir(`${parent}/one`);
    await mkdir(`${parent}/two`);
    await writeFile(`${parent}/one/a`, 'AAA');
    const first = openSync(`${parent}/one`, constants.O_RDONLY | constants.O_DIRECTORY);
    const second = openSync(`${parent}/two`, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const claim = (fd: number, other: number) => {
        // a folder that CLAIMS the identity of `other`, as a descriptor number closed and reused by another folder would
        const stat = fstatSync(other, { bigint: true });
        return { fd, device: stat.dev, inode: stat.ino };
      };
      const calls = standIn();
      const steps = folderSteps(calls, claim(first, second), async () => {
        throw new Error('not read');
      });
      const target = claim(second, second);
      holdFolder(target, target);
      await expect(steps.renameInto('a', target, 'b')).rejects.toMatchObject({ code: 'EBADF' });
      await expect(steps.identity('a')).rejects.toMatchObject({ code: 'EBADF' });
      await expect(steps.unlink('a')).rejects.toMatchObject({ code: 'EBADF' });
      expect(await readFile(`${parent}/one/a`, 'utf8')).toBe('AAA');
    } finally {
      closeSync(first);
      closeSync(second);
    }
  });

  test('BG-001 the second folder of a move must be one the host holds', async () => {
    const parent = await realpath(await mkdtemp(`${tmpdir()}/root-rename-ffi-stranger-`));
    parents.push(parent);
    await mkdir(`${parent}/one`);
    await writeFile(`${parent}/one/a`, 'AAA');
    const fd = openSync(`${parent}/one`, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const stat = fstatSync(fd, { bigint: true });
      const steps = folderSteps(standIn(), { fd, device: stat.dev, inode: stat.ino }, async () => {
        throw new Error('not read');
      });
      await expect(steps.renameInto('a', {}, 'b')).rejects.toMatchObject({ code: 'EBADF' });
      expect(await readFile(`${parent}/one/a`, 'utf8')).toBe('AAA');
    } finally {
      closeSync(fd);
    }
  });

  test('BG-001 a name that is empty, `.`, `..`, holds a `/` or a NUL is refused before the C call', () => {
    for (const bad of ['', '.', '..', 'a/b', '/a', 'a\0b']) expect(isSingleName(bad)).toBe(false);
    expect(isSingleName('settings.json')).toBe(true);
    const calls = loadDescriptorCalls();
    for (const bad of ['', '.', '..', 'a/b', 'a\0b']) {
      expect(() => calls.renameat(-1, bad, -1, 'x')).toThrow(/EINVAL/);
      expect(() => calls.openat(-1, bad, constants.O_RDONLY, 0)).toThrow(/EINVAL/);
      expect(() => calls.unlinkat(-1, bad)).toThrow(/EINVAL/);
      expect(() => calls.linkat(-1, 'x', -1, bad)).toThrow(/EINVAL/);
    }
  });

  test('BG-001 the real binding answers the kernel errno as an error code (EBADF for a descriptor that is not open)', () => {
    const calls = loadDescriptorCalls();
    expect(() => calls.renameat(987_654, 'a', 987_654, 'b')).toThrow(/EBADF/);
  });

  test('BG-001 a library or symbol that cannot be loaded is one plain sentence, not a crash', () => {
    expect(() => loadDescriptorCalls('libno-such-library.so.0')).toThrow(/cannot reach an entry through a held folder/);
  });
});

describe('BG-001 the host without descriptor calls, and the host with /proc, are unchanged', () => {
  test('BG-001 calls that cannot be loaded keep today`s no_descriptor_reach refusal for a rename, and the host still boots', async () => {
    const f = await fresh(() => {
      throw new Error('the library could not be loaded');
    });
    await mkdir(`${f.dir}/sub`, { mode: 0o700 });
    await writeFile(`${f.dir}/sub/a`, 'AAA', { mode: 0o600 });
    expect(
      await refusalOf(() => f.fleet.rename(at(f.fleet, 'homes/claude-a/sub/a'), at(f.fleet, 'homes/claude-a/sub/b'))),
    ).toBe('no_descriptor_reach');
    expect(await readFile(`${f.dir}/sub/a`, 'utf8')).toBe('AAA');
  });

  test('BG-001 on Linux with /proc the descriptor calls are never asked for (lazy, unreachable), and no `at` is offered', async () => {
    const parent = await realpath(await mkdtemp(`${tmpdir()}/root-rename-ffi-linux-`));
    parents.push(parent);
    let asked = 0;
    const fs = nodeFs(() => 'x', {
      descriptorCalls: () => {
        asked += 1;
        return standIn();
      },
    });
    const folder = await fs.openDirectory(parent);
    try {
      expect(folder.at).toBeUndefined();
      expect(folder.entryPath('a')).toContain('/proc/self/fd/');
    } finally {
      await folder.close();
    }
    expect(asked).toBe(0);
  });

  test('BG-001 a host without /proc asks for the calls once, however many folders it opens', async () => {
    const parent = await realpath(await mkdtemp(`${tmpdir()}/root-rename-ffi-once-`));
    parents.push(parent);
    let asked = 0;
    const fs = nodeFs(() => 'x', {
      descriptorFolder: NO_PROC,
      descriptorCalls: () => {
        asked += 1;
        return standIn();
      },
    });
    for (let index = 0; index < 3; index += 1) {
      const folder = await fs.openDirectory(parent);
      expect(folder.at).toBeDefined();
      await folder.close();
    }
    expect(asked).toBe(1);
  });
});

// The same cases against the real macOS library: libSystem.B.dylib, `__error`, and Apple's arm64 handling of the
// variadic `mode`. This box is Linux, so it never runs here (a declared GAP: verified only by this copy on a Mac).
describe.skipIf(process.platform !== 'darwin')('BG-001 BG-003 on macOS with the real libSystem calls', () => {
  test('BG-001 BG-003 a parent swap after the check moves and writes inside the held folders only', async () => {
    let swapped = false;
    const f = await fresh(() =>
      watched(
        loadDescriptorCalls(),
        once(
          verb => verb === 'renameat',
          () => {
            swapped = true;
            swapSync(`${f.dir}/sub`, f.outside)();
          },
        ),
      ),
    );
    await mkdir(f.outside);
    await writeFile(`${f.outside}/a`, 'OUTSIDE', { mode: 0o600 });
    await mkdir(`${f.dir}/sub`, { mode: 0o700 });
    await mkdir(`${f.dir}/dest`, { mode: 0o700 });
    await writeFile(`${f.dir}/sub/a`, 'AAA', { mode: 0o600 });
    await f.fleet.rename(at(f.fleet, 'homes/claude-a/sub/a'), at(f.fleet, 'homes/claude-a/dest/b'));
    expect(swapped).toBe(true);
    expect(await readFile(`${f.dir}/dest/b`, 'utf8')).toBe('AAA');
    expect(await readFile(`${f.outside}/a`, 'utf8')).toBe('OUTSIDE');
    await f.fleet.writeText(at(f.fleet, 'homes/claude-a/dest/c.json'), 'NEW', { mode: 0o640 });
    expect(((await lstat(`${f.dir}/dest/c.json`)).mode & 0o7777).toString(8)).toBe('640');
  });

  test('BG-001 an existing destination and a link at the leaf are refused on the real library', async () => {
    const f = await fresh(() => loadDescriptorCalls());
    await writeFile(`${f.dir}/a`, 'AAA', { mode: 0o600 });
    await symlink(`${f.parent}/nowhere`, `${f.dir}/b`);
    expect(
      await refusalOf(() => f.fleet.rename(at(f.fleet, 'homes/claude-a/a'), at(f.fleet, 'homes/claude-a/b'))),
    ).toBe('outside');
    expect(await readFile(`${f.dir}/a`, 'utf8')).toBe('AAA');
  });
});
