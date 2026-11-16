/**
 * The `project-files` root's base link and descriptor walk on a REAL temp disk (S179, K3): a project folder is reached
 * from its anchor by descriptors (`O_DIRECTORY | O_NOFOLLOW` at each step), so a folder swapped for a link after the
 * checks writes nothing outside it; the scoped folder must resolve to exactly its spelling BELOW the anchor; a link at
 * any level below is refused. No tmux, no real home: every folder is a fresh temp folder and every file is fixture text.
 *
 * "The swap" is a test double on the host's disk seam that runs once at an exact step (the pause hook): it replaces a
 * folder of the project by a link to a folder outside it that holds a REAL tree of the same shape, so a missed refusal
 * would write into that tree.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { linkSync, mkdirSync, openSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { RootHandle } from '../../../contract/ports.ts';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { type DescriptorCalls, isSingleName } from '../../../host/adapters/pinned/descriptor-calls.ts';
import { RootError, rootsPortFor } from '../../../host/roots.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const DECLARED = ['.mcp.json', '.claude/skills/*/**'] as const;
const FIXTURE = 'FIXTURE-SKILL-TEXT-2c7e';

async function world(disk: HostFs = nodeFs(() => crypto.randomUUID())) {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-project-race-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const proj = `${parent}/ws/proj`;
  const outside = `${parent}/outside`;
  await mkdir(`${home}/state`, { recursive: true, mode: 0o700 });
  await mkdir(`${proj}/.claude/skills/x`, { recursive: true });
  // The hostile target: a real tree of the same shape, outside the project.
  await mkdir(`${outside}/skills/x`, { recursive: true });
  const rootFor = (scope: { readonly subfolder: string; readonly within?: string }, fs: HostFs = disk): RootHandle =>
    rootsPortFor(fs, { home, plugin: 'skills', worktrees: `${home}-worktrees` }, ['project-files'], () => undefined, {
      random: () => 'rnd',
      projectFiles: DECLARED,
    }).root('project-files', scope);
  return { parent, home, proj, outside, rootFor };
}

const at = (root: RootHandle, path: string) => {
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

const exists = async (path: string): Promise<boolean> => (await lstat(path).catch(() => undefined)) !== undefined;

/** The host's disk with `after` run ONCE, right after the first call of `verb` that `when` accepts (the pause hook). */
function pausing(
  inner: HostFs,
  verb: 'openDirectory' | 'realpath',
  when: (path: string) => boolean,
  after: () => void,
): HostFs {
  let done = false;
  const wrapped = {
    ...inner,
    [verb]: async (path: string) => {
      const result = await (inner[verb] as (path: string) => Promise<unknown>)(path);
      if (!done && when(path)) {
        done = true;
        after();
      }
      return result;
    },
  };
  return wrapped as HostFs;
}

describe('S179 a project folder is reached by descriptor from its anchor', () => {
  test('S179 a project folder swapped for a link after the check writes nothing outside it', async () => {
    const w = await world();
    const swap = () => {
      renameSync(`${w.proj}/.claude`, `${w.proj}/.claude-moved`);
      symlinkSync(w.outside, `${w.proj}/.claude`);
    };
    // Right after the project folder is opened (the anchor, and the one folder reached by path), before the walk below it.
    const racing = pausing(
      nodeFs(() => crypto.randomUUID()),
      'openDirectory',
      path => path === w.proj,
      swap,
    );
    const root = w.rootFor({ subfolder: w.proj, within: w.proj }, racing);
    expect(await refusalOf(() => root.writeText(at(root, '.claude/skills/x/SKILL.md'), FIXTURE))).toBe('link_escape');
    expect(await readdir(`${w.outside}/skills/x`)).toEqual([]);
    expect(await readdir(`${w.proj}/.claude-moved/skills/x`)).toEqual([]);
  });

  test('S179 a folder swapped for a link between the real-path look of its parent and the write writes nothing outside it', async () => {
    const w = await world();
    const folder = `${w.proj}/.claude/skills/x`;
    const swap = () => {
      renameSync(`${w.proj}/.claude`, `${w.proj}/.claude-moved`);
      symlinkSync(w.outside, `${w.proj}/.claude`);
    };
    // The look of the leaf's folder (`leafWritable`) is the last disk look before the write opens the folder.
    const racing = pausing(
      nodeFs(() => crypto.randomUUID()),
      'realpath',
      path => path === folder,
      swap,
    );
    const root = w.rootFor({ subfolder: w.proj, within: w.proj }, racing);
    const refusal = await refusalOf(() => root.writeText(at(root, '.claude/skills/x/SKILL.md'), FIXTURE));
    expect(['link_escape', 'changed']).toContain(refusal as string);
    expect(await readdir(`${w.outside}/skills/x`)).toEqual([]);
  });

  test('S179 a base whose realpath is not its spelling below the anchor is refused link_escape', async () => {
    const w = await world();
    // `ws/sub` is a link to the real folder `elsewhere`: the base is spelled under it, resolved elsewhere.
    await mkdir(`${w.parent}/elsewhere/proj`, { recursive: true });
    await symlink(`${w.parent}/elsewhere`, `${w.parent}/ws/sub`);
    const root = w.rootFor({ subfolder: `${w.parent}/ws/sub/proj`, within: `${w.parent}/ws` });
    expect(await refusalOf(() => root.writeText(at(root, '.mcp.json'), FIXTURE))).toBe('link_escape');
    expect(await exists(`${w.parent}/elsewhere/proj/.mcp.json`)).toBe(false);
    // The same folder with the link ABOVE the anchor is the symlinked-workspace case, and still works.
    const above = w.rootFor({ subfolder: `${w.parent}/ws/sub/proj`, within: `${w.parent}/ws/sub` });
    await above.writeText(at(above, '.mcp.json'), FIXTURE);
    expect(await readFile(`${w.parent}/elsewhere/proj/.mcp.json`, 'utf8')).toBe(FIXTURE);
    // And as its own anchor, the linked folder works too; with no anchor it is refused (its realpath is not its spelling).
    const alone = w.rootFor({ subfolder: `${w.parent}/ws/sub/proj` });
    expect(await refusalOf(() => alone.writeText(at(alone, '.mcp.json'), 'other'))).toBe('link_escape');
  });

  test('S179 a .claude folder that is a link is refused', async () => {
    const w = await world();
    await rm(`${w.proj}/.claude`, { recursive: true });
    await symlink(w.outside, `${w.proj}/.claude`);
    for (const within of [w.proj, undefined]) {
      const root = w.rootFor(within === undefined ? { subfolder: w.proj } : { subfolder: w.proj, within });
      const refusal = await refusalOf(() => root.writeText(at(root, '.claude/skills/x/SKILL.md'), FIXTURE));
      expect(refusal).toBe('link_escape');
    }
    expect(await readdir(`${w.outside}/skills/x`)).toEqual([]);
  });

  test('S179 a folder missing below the project is made through the walk, owner-only, and the write lands', async () => {
    const w = await world();
    await rm(`${w.proj}/.claude`, { recursive: true });
    const root = w.rootFor({ subfolder: w.proj, within: w.proj });
    await root.writeText(at(root, '.claude/skills/new/SKILL.md'), FIXTURE);
    expect(await readFile(`${w.proj}/.claude/skills/new/SKILL.md`, 'utf8')).toBe(FIXTURE);
    expect(((await stat(`${w.proj}/.claude/skills/new`)).mode & 0o777).toString(8)).toBe('700');
  });
});

type Opened = Awaited<ReturnType<HostFs['openDirectory']>>;

/**
 * The host's disk with `swap` run ONCE at the first of two points: right AFTER the folder named `after` was opened
 * from its parent (by the descriptor step, or by a path walk), or right BEFORE the folder named `before` is opened or
 * made below a held folder. Both points are the same moment of a by-path regression, so a walk that leaves a step by
 * path trips the swap too.
 */
function swappingAt(
  inner: HostFs,
  points: { readonly after?: string; readonly before?: string; readonly mkdirEndsWith?: string },
  swap: () => void,
): HostFs {
  let done = false;
  const once = (): void => {
    if (done) return;
    done = true;
    swap();
  };
  const wrap = (dir: Opened): Opened => ({
    ...dir,
    openChild: async (leaf: string, make?: { readonly mode: number }) => {
      if (leaf === points.before) once();
      const child = await dir.openChild(leaf, make);
      if (leaf === points.after) once();
      return { ...child, folder: wrap(child.folder) };
    },
  });
  return {
    ...inner,
    mkdir: async (path: string, mode?: number) => {
      if (points.mkdirEndsWith !== undefined && path.endsWith(points.mkdirEndsWith)) once();
      return await (inner.mkdir as (path: string, mode?: number) => Promise<void>)(path, mode);
    },
    openDirectory: async (path: string) => {
      const opened = await inner.openDirectory(path);
      if (points.after !== undefined && path.endsWith(`/${points.after}`)) once();
      return wrap(opened);
    },
  } as HostFs;
}

describe('S179 a folder swapped AFTER it was opened, while a missing folder below it is made', () => {
  test('S179 a middle folder swapped for a link right after it was opened makes nothing outside it (not a by-path step)', async () => {
    const w = await world();
    const racing = swappingAt(
      nodeFs(() => crypto.randomUUID()),
      { after: '.claude' },
      () => {
        renameSync(`${w.proj}/.claude`, `${w.proj}/.claude-moved`);
        symlinkSync(w.outside, `${w.proj}/.claude`);
      },
    );
    const root = w.rootFor({ subfolder: w.proj, within: w.proj }, racing);
    const refusal = await refusalOf(() => root.writeText(at(root, '.claude/skills/new/SKILL.md'), FIXTURE));
    expect(['changed', 'link_escape']).toContain(refusal as string);
    expect(await exists(`${w.outside}/skills/new`)).toBe(false);
    expect(await exists(`${w.outside}/skills/new/SKILL.md`)).toBe(false);
  });
});

describe('S179 the anchor is proven by device and inode', () => {
  test('S179 an anchor swapped for another folder or a link right before it is opened is refused changed', async () => {
    for (const kind of ['folder', 'link'] as const) {
      const w = await world();
      const inner = nodeFs(() => crypto.randomUUID());
      let done = false;
      // The swap runs right before the anchor is first opened: after the look that named it, before the descriptor.
      const racing = {
        ...inner,
        openDirectory: async (path: string) => {
          if (!done && path === w.proj) {
            done = true;
            renameSync(w.proj, `${w.proj}-moved`);
            if (kind === 'link') symlinkSync(`${w.proj}-moved`, w.proj);
            else await mkdir(`${w.proj}/.claude/skills/x`, { recursive: true });
          }
          return await inner.openDirectory(path);
        },
      } as HostFs;
      const root = w.rootFor({ subfolder: w.proj, within: w.proj }, racing);
      expect(await refusalOf(() => root.writeText(at(root, '.claude/skills/x/SKILL.md'), FIXTURE))).toBe('changed');
      expect(await exists(`${w.proj}/.claude/skills/x/SKILL.md`)).toBe(false);
      expect(await exists(`${w.proj}-moved/.claude/skills/x/SKILL.md`)).toBe(false);
    }
  });
});

describe('S179 the LEAF folder of ensurePrivateDirectory and copyTree is made through the held folder', () => {
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
  const disks = {
    linux: () => nodeFs(() => crypto.randomUUID()),
    macOS: () =>
      nodeFs(() => crypto.randomUUID(), {
        descriptorFolder: '/nonexistent-descriptor-folder',
        descriptorCalls: standIn,
      }),
  };

  for (const [host, disk] of Object.entries(disks)) {
    test(`S179 ensurePrivateDirectory ${host}: a parent swapped for a link right before the leaf folder is made makes nothing outside`, async () => {
      const w = await world();
      const racing = swappingAt(disk(), { before: 'y', mkdirEndsWith: '/skills/y' }, () => {
        renameSync(`${w.proj}/.claude`, `${w.proj}/.claude-moved`);
        symlinkSync(w.outside, `${w.proj}/.claude`);
      });
      const root = w.rootFor({ subfolder: w.proj, within: w.proj }, racing);
      expect(await refusalOf(() => root.ensurePrivateDirectory(at(root, '.claude/skills/y')))).toBe('changed');
      expect(await exists(`${w.outside}/skills/y`)).toBe(false);
    });

    test(`S179 copyTree ${host}: a parent swapped for a link right before the new folder is made makes nothing outside`, async () => {
      const w = await world();
      await mkdir(`${w.home}-worktrees/src/pack`, { recursive: true });
      await writeFile(`${w.home}-worktrees/src/pack/SKILL.md`, FIXTURE);
      const racing = swappingAt(disk(), { before: 'y', mkdirEndsWith: '/skills/y' }, () => {
        renameSync(`${w.proj}/.claude`, `${w.proj}/.claude-moved`);
        symlinkSync(w.outside, `${w.proj}/.claude`);
      });
      const roots = rootsPortFor(
        racing,
        { home: w.home, plugin: 'skills', worktrees: `${w.home}-worktrees` },
        ['project-files', 'worktrees'],
        () => undefined,
        { random: () => 'rnd', projectFiles: DECLARED },
      );
      const source = roots.root('worktrees');
      const target = roots.root('project-files', { subfolder: w.proj, within: w.proj });
      expect(
        await refusalOf(() => target.copyTree(source, at(source, 'src/pack'), at(target, '.claude/skills/y'))),
      ).toBe('changed');
      expect(await exists(`${w.outside}/skills/y`)).toBe(false);
    });

    test(`S179 ${host}: the leaf folder is made through the held folder and owner-only, and a file at its name is refused outside`, async () => {
      const w = await world(disk());
      const root = w.rootFor({ subfolder: w.proj, within: w.proj });
      await root.ensurePrivateDirectory(at(root, '.claude/skills/made'));
      expect(((await stat(`${w.proj}/.claude/skills/made`)).mode & 0o777).toString(8)).toBe('700');
      await root.ensurePrivateDirectory(at(root, '.claude/skills/made'));
      await writeFile(`${w.proj}/.claude/skills/file`, FIXTURE);
      expect(await refusalOf(() => root.ensurePrivateDirectory(at(root, '.claude/skills/file')))).toBe('outside');
    });
  }
});

describe('S179 the walk where no path reaches an open descriptor (macOS) goes through the C calls', () => {
  /** The five calls over `/proc/self/fd`, which Linux resolves from the held descriptor itself (as the rename tests do). */
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
  const NO_PROC = '/nonexistent-descriptor-folder';

  test('S179 a write lands and a missing folder is made through the held folder (mkdirat, openat)', async () => {
    const disk = nodeFs(() => crypto.randomUUID(), { descriptorFolder: NO_PROC, descriptorCalls: standIn });
    const w = await world(disk);
    await rm(`${w.proj}/.claude`, { recursive: true });
    const root = w.rootFor({ subfolder: w.proj, within: w.proj });
    await root.writeText(at(root, '.claude/skills/new/SKILL.md'), FIXTURE);
    expect(await readFile(`${w.proj}/.claude/skills/new/SKILL.md`, 'utf8')).toBe(FIXTURE);
  });

  test('S179 a project folder swapped for a link after the check writes nothing outside it', async () => {
    const inner = nodeFs(() => crypto.randomUUID(), { descriptorFolder: NO_PROC, descriptorCalls: standIn });
    const w = await world(inner);
    const racing = pausing(
      inner,
      'openDirectory',
      path => path === w.proj,
      () => {
        renameSync(`${w.proj}/.claude`, `${w.proj}/.claude-moved`);
        symlinkSync(w.outside, `${w.proj}/.claude`);
      },
    );
    const root = w.rootFor({ subfolder: w.proj, within: w.proj }, racing);
    expect(await refusalOf(() => root.writeText(at(root, '.claude/skills/x/SKILL.md'), FIXTURE))).toBe('link_escape');
    expect(await readdir(`${w.outside}/skills/x`)).toEqual([]);
  });

  test('S179 a host that reaches a held folder by neither refuses the write no_descriptor_reach, and reads still work', async () => {
    const disk = nodeFs(() => crypto.randomUUID(), {
      descriptorFolder: NO_PROC,
      descriptorCalls: () => {
        throw new Error('the C library could not be loaded');
      },
    });
    const w = await world(disk);
    const root = w.rootFor({ subfolder: w.proj, within: w.proj });
    expect(await refusalOf(() => root.writeText(at(root, '.claude/skills/x/SKILL.md'), FIXTURE))).toBe(
      'no_descriptor_reach',
    );
    expect(await exists(`${w.proj}/.claude/skills/x/SKILL.md`)).toBe(false);
    await writeFile(`${w.proj}/.mcp.json`, FIXTURE);
    expect(await root.readText(at(root, '.mcp.json'))).toBe(FIXTURE);
  });
});
