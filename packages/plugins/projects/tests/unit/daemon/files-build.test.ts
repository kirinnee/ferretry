/**
 * The project file index over a FAKE held root (&F6061 U5 review R1): what a real disk cannot be made to do on demand —
 * a folder on another device, a capped listing that misses `.git`, a pin that takes longer than the whole budget.
 */
import { describe, expect, test } from 'bun:test';
import { FsError, type HeldRoot } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import {
  buildProjectIndex,
  DEFAULT_PROJECT_INDEX_LIMITS,
  type ProjectIndexDeps,
} from '../../../daemon/features/files/build.ts';
import { GitTimedOut, type FolderPins } from '../../../daemon/features/files/pins.ts';

interface Node {
  readonly type: 'dir' | 'file';
  readonly dev?: bigint;
}

interface Disk {
  readonly nodes: Map<string, Node>;
  /** Folders whose listing says "more than I named", with the names it did name. */
  readonly capped: Map<string, readonly string[]>;
  /** Names the held root refuses to open for a reason that is not "not there". */
  readonly refused: Set<string>;
  /** Every path the held root was asked to open, in order. */
  readonly asked: string[];
}

const dir = (dev = 1n): Node => ({ type: 'dir', dev });
const file = (): Node => ({ type: 'file' });

/** A disk from a map of relative path to node; the held folder itself (`''`) is on device 1. */
const disk = (nodes: Readonly<Record<string, Node>>): Disk => ({
  nodes: new Map<string, Node>([['', dir()], ...Object.entries(nodes)]),
  capped: new Map(),
  refused: new Set(),
  asked: [],
});

const parentOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

function heldRoot(world: Disk, rootReal = '/p'): HeldRoot {
  const identity = (node: Node) => ({ dev: node.dev ?? 1n, ino: 1n, ctimeNs: 0n, mode: 0 });
  return {
    rootReal,
    policyCwd: 'cwd',
    fenced: async (rels: readonly string[]) => rels.map(() => false),
    open: async (rel: string, options?: { readonly wantDirectory?: boolean }) => {
      world.asked.push(rel);
      if (world.refused.has(rel)) throw new FsError('denied', 'refused');
      const node = world.nodes.get(rel);
      if (node === undefined) throw new FsError('not_found', 'not there');
      if (options?.wantDirectory === true && node.type !== 'dir') throw new FsError('not_a_directory', 'not a folder');
      return {
        metadata: { type: node.type },
        canonical: rel,
        identities: [identity(node)],
        read: async () => new Uint8Array(),
        list: async () => {
          const named = world.capped.get(rel);
          const entries = [...world.nodes.entries()]
            .filter(([path]) => path !== '' && parentOf(path) === rel)
            .filter(([path]) => named === undefined || named.includes(path.slice(rel === '' ? 0 : rel.length + 1)))
            .map(([path, child]) => ({ name: path.slice(rel === '' ? 0 : rel.length + 1), type: child.type }));
          return { entries, truncated: named !== undefined };
        },
        close: async () => undefined,
      };
    },
    probe: () => ({
      classify: async (rels: readonly string[]) =>
        rels.map(rel => (world.nodes.get(rel)?.type === 'file' ? 'file' : 'unsupported')),
      close: async () => undefined,
    }),
    close: async () => undefined,
  } as unknown as HeldRoot;
}

interface Setup {
  readonly pins?: Partial<FolderPins>;
  readonly git?: ProjectIndexDeps['git'];
  readonly nowMs?: () => number;
  readonly limits?: ProjectIndexDeps['limits'];
}

const NOT_A_REPO: ProjectIndexDeps['git'] = {
  isInsideWorkTree: async () => false,
  listFiles: async () => ({ paths: [], truncated: false }),
};

const build = (world: Disk, setup: Setup = {}) =>
  buildProjectIndex('/p', {
    pins: async () => ({
      project: async () => ({ ok: true, root: heldRoot(world) }),
      nested: async (path: string) => ({ ok: true, root: heldRoot(world, path) }),
      descendant: async () => undefined,
      ...setup.pins,
    }),
    git: setup.git ?? NOT_A_REPO,
    nowMs: setup.nowMs ?? (() => 0),
    ...(setup.limits === undefined ? {} : { limits: setup.limits }),
    instant: () => '2026-11-22T00:00:00.000Z' as Instant,
  } as unknown as ProjectIndexDeps);

const paths = (index: { readonly files: readonly { readonly path: string }[] }) => index.files.map(f => f.path);
const skip = (
  index: { readonly summary: { readonly skipped: readonly { reason: string; count: number }[] } },
  reason: string,
) => index.summary.skipped.find(row => row.reason === reason)?.count ?? 0;

describe('a folder on another device (a mount) is not entered, by the held descriptor’s own device', () => {
  test('the plain walk leaves a mounted folder out and counts it', async () => {
    const world = disk({ same: dir(), 'same/a.txt': file(), mnt: dir(2n), 'mnt/b.txt': file() });

    const index = await build(world);

    expect(paths(index)).toEqual(['same/a.txt']);
    expect(skip(index, 'excluded')).toBe(1);
  });

  test('a Git list does not name files below a folder that is on another device', async () => {
    const world = disk({ same: dir(), 'same/a.ts': file(), mnt: dir(2n), 'mnt/b.ts': file(), 'top.ts': file() });
    const git: ProjectIndexDeps['git'] = {
      isInsideWorkTree: async () => true,
      listFiles: async () => ({ paths: ['same/a.ts', 'mnt/b.ts', 'top.ts'], truncated: false }),
    };

    const index = await build(world, { git });

    expect(paths(index)).toEqual(['top.ts', 'same/a.ts']);
    expect(skip(index, 'excluded')).toBeGreaterThanOrEqual(1);
  });
});

describe('a descendant folder is judged by the shared folder policy', () => {
  test('the plain walk does not list a folder the policy calls private, and counts it denied', async () => {
    const world = disk({ vault: dir(), 'vault/notes.txt': file(), open: dir(), 'open/a.txt': file() });
    const descendant: FolderPins['descendant'] = async real => (real === '/p/vault' ? 'private' : undefined);

    const index = await build(world, { pins: { descendant } });

    expect(paths(index)).toEqual(['open/a.txt']);
    expect(skip(index, 'denied')).toBeGreaterThanOrEqual(1);
  });

  test('a Git list drops the files of a private folder AND of every folder below it', async () => {
    const world = disk({
      vault: dir(),
      'vault/deep': dir(),
      'vault/deep/x.ts': file(),
      'vault/y.ts': file(),
      'ok.ts': file(),
    });
    const git: ProjectIndexDeps['git'] = {
      isInsideWorkTree: async () => true,
      listFiles: async () => ({ paths: ['vault/deep/x.ts', 'vault/y.ts', 'ok.ts'], truncated: false }),
    };
    const descendant: FolderPins['descendant'] = async real => (real === '/p/vault' ? 'private' : undefined);

    const index = await build(world, { git, pins: { descendant } });

    expect(paths(index)).toEqual(['ok.ts']);
    expect(skip(index, 'denied')).toBe(2);
  });

  test('a folder the policy cannot prove (not private, not readable) is left out and the answer is partial', async () => {
    const world = disk({ odd: dir(), 'odd/a.txt': file() });
    const descendant: FolderPins['descendant'] = async () => 'unreadable';

    const index = await build(world, { pins: { descendant } });

    expect(paths(index)).toEqual([]);
    expect(index.summary.coverage).toBe('partial');
  });
});

describe('whether a nested folder is a repository is asked of the held folder, never of a capped listing', () => {
  test('a linked worktree whose `.git` the capped listing did not name is named, not walked', async () => {
    const world = disk({ wt: dir(), 'wt/.git': file(), 'wt/a.txt': file(), 'wt/ignored.log': file() });
    world.capped.set('wt', ['a.txt', 'ignored.log']);

    const index = await build(world);

    expect(paths(index)).toEqual([]);
    expect(index.summary.nestedWorktrees).toEqual(['wt']);
  });

  test('a `.git` whose state cannot be established fails closed: the folder is not listed and the answer is partial', async () => {
    const world = disk({ odd: dir(), 'odd/.git': dir(), 'odd/a.txt': file() });
    world.refused.add('odd/.git');

    const index = await build(world);

    expect(paths(index)).toEqual([]);
    expect(index.summary.coverage).toBe('partial');
    expect(skip(index, 'unreadable')).toBeGreaterThanOrEqual(1);
  });
});

describe('one deadline covers the whole build, pinning included', () => {
  test('time spent holding the project folder is spent from the same budget the walk has', async () => {
    const clock = { now: 0 };
    const world = disk({ 'a.txt': file(), d: dir(), 'd/b.txt': file() });

    const index = await build(world, {
      nowMs: () => clock.now,
      pins: {
        project: async () => {
          clock.now += 20_000;
          return { ok: true, root: heldRoot(world) };
        },
      },
    });

    expect(paths(index)).toEqual([]);
    expect(index.summary.coverage).toBe('partial');
    expect(skip(index, 'truncated')).toBeGreaterThanOrEqual(1);
  });
});

describe('a Git child that runs out of the build’s time is the budget, not damage', () => {
  test('a list that timed out is counted as cut short (truncated), never as unreadable', async () => {
    const world = disk({ 'a.ts': file() });
    const git: ProjectIndexDeps['git'] = {
      isInsideWorkTree: async () => true,
      listFiles: async () => {
        throw new GitTimedOut('git ls-files');
      },
    };

    const index = await build(world, { git });

    expect(skip(index, 'truncated')).toBeGreaterThanOrEqual(1);
    expect(skip(index, 'unreadable')).toBe(0);
    expect(index.summary.coverage).toBe('partial');
  });

  test('a list that failed after the deadline passed is the deadline, whatever Git said', async () => {
    const clock = { now: 0 };
    const world = disk({ 'a.ts': file() });
    const git: ProjectIndexDeps['git'] = {
      isInsideWorkTree: async () => true,
      listFiles: async () => {
        clock.now += 60_000;
        throw new Error('git ls-files failed: killed');
      },
    };

    const index = await build(world, { git, nowMs: () => clock.now });

    expect(skip(index, 'truncated')).toBeGreaterThanOrEqual(1);
    expect(skip(index, 'unreadable')).toBe(0);
  });

  test('the same for the question "is this a repository": a timeout is truncated, not unreadable', async () => {
    const world = disk({ 'a.ts': file() });
    const git: ProjectIndexDeps['git'] = {
      isInsideWorkTree: async () => {
        throw new GitTimedOut('git rev-parse');
      },
      listFiles: async () => ({ paths: [], truncated: false }),
    };

    const index = await build(world, { git });

    expect(skip(index, 'truncated')).toBeGreaterThanOrEqual(1);
    expect(skip(index, 'unreadable')).toBe(0);
  });
});

describe('one candidate allowance covers the nested folders Git names and the files, together', () => {
  test('folders past the allowance are not inspected at all (no `.git` is asked of them) and the answer is partial', async () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    const world = disk({
      ...Object.fromEntries(
        names.flatMap(name => [
          [name, dir()],
          [`${name}/.git`, file()],
        ]),
      ),
    });
    const git: ProjectIndexDeps['git'] = {
      isInsideWorkTree: async () => true,
      listFiles: async () => ({ paths: names.map(name => `${name}/`), truncated: false }),
    };

    const index = await build(world, { git, limits: { ...DEFAULT_PROJECT_INDEX_LIMITS, maxCandidates: 3 } });

    // A marker is asked as a folder and then as a file, so folders are counted, not questions.
    const markers = [...new Set(world.asked.filter(path => path.endsWith('/.git')))];
    expect(markers.length).toBeLessThanOrEqual(3);
    expect(index.summary.nestedWorktrees.length).toBeLessThanOrEqual(3);
    expect(index.summary.coverage).toBe('partial');
    expect(skip(index, 'truncated')).toBeGreaterThanOrEqual(1);
  });
});
