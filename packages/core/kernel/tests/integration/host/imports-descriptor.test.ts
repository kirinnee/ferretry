/**
 * The `imports` root with a `within` anchor reaches its scoped folder BY DESCRIPTOR (the anchor opened once and proven,
 * each folder below it opened from its parent's descriptor with `O_DIRECTORY | O_NOFOLLOW`), so a folder swapped for a
 * link at ANY step of ONE call reads, stats and lists nothing outside it. Real temp disk, fixture text only.
 *
 * "The swap" is a test double on the host's disk seam: it counts every disk step of one call (the host's own calls and
 * the `openChild` steps of every folder it hands out) and, in turn, replaces one folder by a link to a folder outside
 * the project right AFTER step k, for every k (before the first step included). Wherever it lands, the outside text,
 * the outside names and the outside size are never answered.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { linkSync, mkdirSync, openSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { RootHandle } from '../../../contract/ports.ts';
import { type HostFs, type OpenedDirectory, nodeFs } from '../../../host/adapters/node-fs.ts';
import { type DescriptorCalls, isSingleName } from '../../../host/adapters/pinned/descriptor-calls.ts';
import { RootError, rootsPortFor } from '../../../host/roots.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const INSIDE = 'INSIDE-FIXTURE-TEXT';
const OUTSIDE = 'OUTSIDE-FIXTURE-TEXT-WITH-A-LONGER-BODY';
const NO_PROC = '/nonexistent-descriptor-folder';

/** The five calls over `/proc/self/fd`, which Linux resolves from the held descriptor itself (as the other host tests do). */
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
  linux: (): HostFs => nodeFs(() => crypto.randomUUID()),
  macOS: (): HostFs => nodeFs(() => crypto.randomUUID(), { descriptorFolder: NO_PROC, descriptorCalls: standIn }),
  noReach: (): HostFs =>
    nodeFs(() => crypto.randomUUID(), {
      descriptorFolder: NO_PROC,
      descriptorCalls: () => {
        throw new Error('the C library could not be loaded');
      },
    }),
};

/** The project `proj` with `a/b/c/f.txt` inside it, and a hostile tree of the same shape outside it for each folder. */
async function world(disk: HostFs = disks.linux()) {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-imports-descriptor-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const proj = `${parent}/ws/proj`;
  const scoped = `${proj}/a/b/c`;
  await mkdir(`${home}/state`, { recursive: true, mode: 0o700 });
  await mkdir(scoped, { recursive: true });
  await writeFile(`${scoped}/f.txt`, INSIDE);
  const hostile = {
    a: `${parent}/out-a`,
    b: `${parent}/out-b`,
    c: `${parent}/out-c`,
  };
  for (const folder of [`${hostile.a}/b/c`, `${hostile.b}/c`, hostile.c]) {
    await mkdir(folder, { recursive: true });
    await writeFile(`${folder}/f.txt`, OUTSIDE);
    await writeFile(`${folder}/OUTSIDE.txt`, OUTSIDE);
  }
  const rootFor = (
    fs: HostFs = disk,
    scope: { subfolder: string; within?: string } = { subfolder: scoped, within: proj },
  ) =>
    rootsPortFor(fs, { home, plugin: 'skills', worktrees: `${home}-worktrees` }, ['imports'], () => undefined).root(
      'imports',
      scope,
    );
  const folders = { a: `${proj}/a`, b: `${proj}/a/b`, c: scoped } as const;
  /** Moves the folder aside and puts a link to the hostile tree where it was. */
  const swap = (which: keyof typeof folders, hostileTree?: string): void => {
    renameSync(folders[which], `${folders[which]}-moved`);
    symlinkSync(hostileTree ?? hostile[which], folders[which]);
  };
  return { parent, home, proj, scoped, hostile, folders, rootFor, swap };
}

const at = (root: RootHandle, path: string) => {
  const resolved = root.resolve(path);
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value;
};

type Verb = 'readText' | 'readBytes' | 'readTail' | 'readDurable' | 'stat' | 'list' | 'entries';
const VERBS: readonly Verb[] = ['readText', 'readBytes', 'readTail', 'readDurable', 'stat', 'list', 'entries'];

type Seen =
  | { readonly kind: 'answer'; readonly leak: boolean; readonly inside: boolean }
  | { readonly kind: 'refused'; readonly refusal: string };

/** One call of `verb` on the scoped folder (`f.txt`, or the folder itself): what it answered, or the refusal it gave. */
async function observe(root: RootHandle, scoped: string, verb: Verb): Promise<Seen> {
  const text = new TextDecoder();
  try {
    switch (verb) {
      case 'readText': {
        const got = await root.readText(at(root, `${scoped}/f.txt`), 1000);
        return { kind: 'answer', leak: got.includes('OUTSIDE'), inside: got === INSIDE };
      }
      case 'readBytes': {
        const got = text.decode(await root.readBytes(at(root, `${scoped}/f.txt`), 1000));
        return { kind: 'answer', leak: got.includes('OUTSIDE'), inside: got === INSIDE };
      }
      case 'readTail': {
        const got = text.decode((await root.readTail(at(root, `${scoped}/f.txt`), 1000)).bytes);
        return { kind: 'answer', leak: got.includes('OUTSIDE'), inside: got === INSIDE };
      }
      case 'readDurable': {
        const got = await root.readDurable(at(root, `${scoped}/f.txt`), 1000);
        const body = got === undefined ? '' : text.decode(got.bytes);
        return { kind: 'answer', leak: body.includes('OUTSIDE'), inside: body === INSIDE };
      }
      case 'stat': {
        const got = await root.stat(at(root, `${scoped}/f.txt`));
        return { kind: 'answer', leak: got?.size === OUTSIDE.length, inside: got?.size === INSIDE.length };
      }
      case 'list': {
        const got = await root.list(at(root, scoped));
        return { kind: 'answer', leak: got.includes('OUTSIDE.txt'), inside: got.join() === 'f.txt' };
      }
      case 'entries': {
        const got = (await root.entries(at(root, scoped))).map(entry => entry.name);
        return { kind: 'answer', leak: got.includes('OUTSIDE.txt'), inside: got.join() === 'f.txt' };
      }
    }
  } catch (error) {
    if (error instanceof RootError) return { kind: 'refused', refusal: error.refusal };
    throw error;
  }
}

/**
 * The host's disk with every step counted: the host's own calls (after they return) and the `openChild` of every folder
 * it opens (after it returns). `after` runs ONCE right after the step numbered `swapAfter`.
 */
function counting(inner: HostFs, swapAfter: number | undefined, swap: () => void, counter: { steps: number }): HostFs {
  const step = (): void => {
    counter.steps += 1;
    if (counter.steps === swapAfter) swap();
  };
  const watched = (folder: OpenedDirectory): OpenedDirectory => ({
    ...folder,
    openChild: async (leaf, make) => {
      const child = await folder.openChild(leaf, make);
      step();
      return { ...child, folder: watched(child.folder) };
    },
  });
  return Object.fromEntries(
    Object.entries(inner).map(([name, run]) => [
      name,
      async (...args: never[]): Promise<unknown> => {
        const result = await (run as (...args: never[]) => unknown)(...args);
        step();
        return name === 'openDirectory' ? watched(result as OpenedDirectory) : result;
      },
    ]),
  ) as unknown as HostFs;
}

/** Every outcome of `verb` with the swap landing after each step in turn (and before the first). */
async function sweep(
  host: keyof typeof disks,
  verb: Verb,
  which: 'a' | 'b' | 'c',
): Promise<{ readonly dry: Seen; readonly seen: readonly Seen[] }> {
  const run = async (swapAfter: number | undefined): Promise<{ seen: Seen; steps: number }> => {
    const w = await world(disks[host]());
    const counter = { steps: 0 };
    const racing = counting(disks[host](), swapAfter, () => w.swap(which), counter);
    if (swapAfter === 0) w.swap(which);
    const seen = await observe(w.rootFor(racing), w.scoped, verb);
    return { seen, steps: counter.steps };
  };
  const dry = await run(undefined);
  const seen: Seen[] = [];
  for (let after = 0; after <= dry.steps + 1; after += 1) seen.push((await run(after)).seen);
  return { dry: dry.seen, seen };
}

/** What a swap may leave: the inside answer (it landed after the folder was held) or a content-free refusal. */
function expectNothingOutside(dry: Seen, seen: readonly Seen[]): void {
  expect(dry).toMatchObject({ kind: 'answer', leak: false, inside: true });
  expect(seen.filter(one => one.kind === 'answer' && one.leak)).toEqual([]);
  for (const one of seen) {
    if (one.kind === 'answer') expect(one.inside).toBe(true);
    else expect(['link_escape', 'changed']).toContain(one.refusal);
  }
  // The swap did land mid-call somewhere and was refused, not merely missed.
  expect(seen.some(one => one.kind === 'refused' && one.refusal === 'link_escape')).toBe(true);
}

describe('R-0198 imports reaches its scoped folder by descriptor: a folder swapped for a link inside ONE call', () => {
  for (const host of ['linux', 'macOS'] as const) {
    for (const which of ['c', 'b', 'a'] as const) {
      for (const verb of VERBS) {
        test(`R-0198 ${host}: ${verb} with the ${which === 'c' ? 'scoped folder' : which === 'b' ? "scoped folder's parent" : 'first folder below the anchor'} swapped at any step answers nothing outside`, async () => {
          const { dry, seen } = await sweep(host, verb, which);
          expectNothingOutside(dry, seen);
        }, 120_000);
      }
    }
  }
});

describe('R-0198 the anchor is proven once and held', () => {
  test('R-0198 the anchor swapped for a link to a same-shaped tree right after it was opened keeps reading the original', async () => {
    const w = await world();
    const hostileProject = `${w.parent}/out-project`;
    await mkdir(`${hostileProject}/a/b/c`, { recursive: true });
    await writeFile(`${hostileProject}/a/b/c/f.txt`, OUTSIDE);
    const inner = disks.linux();
    let fired = false;
    const racing = {
      ...inner,
      openDirectory: async (path: string) => {
        const opened = await inner.openDirectory(path);
        if (!fired && path === w.proj) {
          fired = true;
          renameSync(w.proj, `${w.proj}-moved`);
          symlinkSync(hostileProject, w.proj);
        }
        return opened;
      },
    } as HostFs;
    const seen = await observe(w.rootFor(racing), w.scoped, 'readText');
    // The anchor is opened by descriptor: the swap after that open is not followed.
    expect(fired).toBe(true);
    expect(seen).toMatchObject({ kind: 'answer', leak: false, inside: true });
  });
});

describe('R-0198 a link anywhere below the anchor is refused; the project folder itself may be a link', () => {
  test('R-0198 a project folder that is a link reads, lists and stats (the anchor is excluded)', async () => {
    const w = await world();
    const linked = `${w.parent}/linked-proj`;
    await symlink(w.proj, linked);
    const root = w.rootFor(disks.linux(), { subfolder: `${linked}/a/b/c`, within: linked });
    for (const verb of VERBS)
      expect(await observe(root, `${linked}/a/b/c`, verb)).toMatchObject({ kind: 'answer', leak: false });
    expect(await root.readText(at(root, `${linked}/a/b/c/f.txt`), 1000)).toBe(INSIDE);
  });

  for (const which of ['a', 'b', 'c'] as const) {
    test(`R-0198 a link at ${which} (even to a folder inside the project) is refused link_escape on every verb`, async () => {
      const w = await world();
      w.swap(which, `${w.parent}/out-${which}`);
      for (const verb of VERBS) {
        expect(await observe(w.rootFor(), w.scoped, verb)).toEqual({ kind: 'refused', refusal: 'link_escape' });
      }
    });
  }

  test('R-0198 a dangling link and a link loop at the scoped folder are refused link_escape', async () => {
    for (const kind of ['dangling', 'loop'] as const) {
      const w = await world();
      renameSync(w.scoped, `${w.scoped}-moved`);
      await symlink(kind === 'dangling' ? `${w.parent}/nowhere` : w.scoped, w.scoped);
      for (const verb of VERBS) {
        expect(await observe(w.rootFor(), w.scoped, verb)).toEqual({ kind: 'refused', refusal: 'link_escape' });
      }
    }
  });

  test('R-0198 no within: a scoped folder that is a link reads as before', async () => {
    const w = await world();
    const linked = `${w.parent}/linked-scoped`;
    await symlink(w.scoped, linked);
    const root = w.rootFor(disks.linux(), { subfolder: linked });
    expect(await root.readText(at(root, `${linked}/f.txt`), 1000)).toBe(INSIDE);
    expect(await root.list(at(root, linked))).toEqual(['f.txt']);
  });

  test('R-0198 within equal to the scoped folder walks nothing: a link there reads', async () => {
    const w = await world();
    const linked = `${w.parent}/linked-scoped`;
    await symlink(w.scoped, linked);
    const root = w.rootFor(disks.linux(), { subfolder: linked, within: linked });
    expect(await root.readText(at(root, `${linked}/f.txt`), 1000)).toBe(INSIDE);
    expect(await root.list(at(root, linked))).toEqual(['f.txt']);
  });
});

describe('R-0198 a host that reaches no folder by descriptor path', () => {
  test('R-0198 macOS (no /proc/self/fd, the C calls loaded) reads, stats and lists every verb', async () => {
    const w = await world(disks.macOS());
    for (const verb of VERBS)
      expect(await observe(w.rootFor(), w.scoped, verb)).toMatchObject({ kind: 'answer', leak: false, inside: true });
  });

  test('R-0198 a host with neither (the C library unloadable) still reads, stats and lists every verb', async () => {
    const w = await world(disks.noReach());
    for (const verb of VERBS)
      expect(await observe(w.rootFor(), w.scoped, verb)).toMatchObject({ kind: 'answer', leak: false, inside: true });
  });
});
