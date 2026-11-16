/**
 * `RootHandle.unlink` against the private-files fence (§7.7): the fence 5.0 put on every other door of an internal root
 * (`remove`, `rename`, `linkTo`, a write) holds for `unlink` too. A name that answers as one of the home's private
 * places (a bind mount of a key kept under an innocent name) is never one `unlink` removes, in `fleet` and in
 * `agent-homes` alike, and the same name is removed once the place is dropped from the composed list.
 *
 * A bind mount cannot be made without privilege in a unit test, so it is SIMULATED at the disk seam: the decoy name
 * answers with the private file's device and inode (and is still a link), exactly what a mount of it shows.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename } from 'node:path';
import type { FencedPath } from '../../../contract/bound.ts';
import type { RootHandle, RootName } from '../../../contract/ports.ts';
import { type FileIdentity, type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';
import { composePrivateFiles } from '../../../manifest/privacy.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const DECLARED: readonly RootName[] = ['fleet', 'agent-homes'];
const REAL = nodeFs(() => 'r');
/** What the composed list holds for one plugin that declared `secret.key` private. */
const PRIVATE = ['state/vaultish/secret.key'];

/** A name (a LINK unless `kind` says otherwise) that answers as another file's device and inode: what a bind mount of that file shows. */
function bound(base: HostFs, decoy: string, source: string, kind: 'link' | 'file' = 'link'): HostFs {
  // The name itself, or the same leaf reached through a folder descriptor (`/proc/self/fd/N/<leaf>`).
  const isDecoy = (path: string): boolean =>
    path === decoy || (path.startsWith('/proc/self/fd/') && path.endsWith(`/${basename(decoy)}`));
  return {
    ...base,
    identity: async path => {
      if (!isDecoy(path)) return await base.identity(path);
      const found = await base.identity(source);
      return found === undefined ? undefined : ({ ...found, kind, links: 1 } satisfies FileIdentity);
    },
  };
}

/** How many sessions hold the private file: past the 65,536 a `*` collection is indexed, its tree is closed on its devices. */
const PAST_THE_BUDGET = 65_536;
/** The inode an entry on the closed device answers with: never one the fence holds by key. */
const CLOSED_INODE = 9_000_000_000n;

/**
 * `base`, as a disk where the sessions tree holds {@link PAST_THE_BUDGET} sessions (so it is truncated and CLOSED on
 * `device`) and `decoy` is a link on that device: what a bind mount of an unindexed session's file shows.
 */
function closedDisk(base: HostFs, sessions: string, decoy: string, device: bigint): HostFs {
  const holders = Array.from({ length: PAST_THE_BUDGET }, (_, n) => `h${n}`);
  const isDecoy = (path: string): boolean =>
    path === decoy || (path.startsWith('/proc/self/fd/') && path.endsWith(`/${basename(decoy)}`));
  const made = (kind: 'directory' | 'file', inode: bigint): FileIdentity => ({
    kind,
    device,
    inode,
    links: kind === 'directory' ? 2 : 1,
    size: 0,
    mtimeMs: 0,
    mtimeNs: 1n,
    ctimeNs: 1n,
    mode: 0o600,
    owner: 0,
    group: 0,
  });
  return {
    ...base,
    list: async path => (path === sessions ? [...(await base.list(path)), ...holders] : await base.list(path)),
    identity: async path => {
      if (path === sessions) return made('directory', 1n);
      if (path.startsWith(`${sessions}/`)) {
        const [name, file] = path.slice(sessions.length + 1).split('/') as [string, string | undefined];
        if (/^h\d+$/.test(name)) {
          const number = BigInt(name.slice(1));
          if (file === undefined) return made('directory', 1_000_000_000n + number);
          return file === 'environment.json' ? made('file', 2_000_000_000n + number) : undefined;
        }
      }
      if (!isDecoy(path)) return await base.identity(path);
      const found = await base.identity(path.startsWith('/proc/') ? path : decoy);
      return found === undefined ? undefined : { ...found, kind: 'link', device, inode: CLOSED_INODE, links: 1 };
    },
  };
}

async function layout() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-unlink-private-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const key = `${home}/state/vaultish/secret.key`;
  await mkdir(`${home}/state/vaultish`, { recursive: true, mode: 0o700 });
  await mkdir(`${home}/config`, { recursive: true, mode: 0o700 });
  await mkdir(`${home}-worktrees`, { recursive: true, mode: 0o700 });
  await writeFile(key, 'private-fixture', { mode: 0o600 });
  await ensureInternalRootBases(REAL, { home, plugin: 'runtimes' }, DECLARED);
  return { parent, home, key };
}

async function rootsOf(
  l: Awaited<ReturnType<typeof layout>>,
  decoy: string,
  privateFiles: readonly string[],
  disk: HostFs = bound(REAL, decoy, l.key),
) {
  const port = rootsPortFor(
    disk,
    { home: l.home, plugin: 'runtimes', worktrees: `${l.home}-worktrees` },
    DECLARED,
    () => undefined,
    { privateFiles },
  );
  return { fleet: port.root('fleet'), homes: port.root('agent-homes', { subfolder: 'ferret-a' }) };
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

const there = async (path: string): Promise<boolean> => (await lstat(path).catch(() => undefined)) !== undefined;

describe('RootHandle.unlink and the private-files fence', () => {
  test('a link in fleet that answers as a private file is refused fenced, and left where it was', async () => {
    const l = await layout();
    const decoy = `${l.home}/fleet/homes/claude-a/innocent`;
    const { fleet } = await rootsOf(l, decoy, PRIVATE);
    await fleet.makeDirectory(at(fleet, 'homes/claude-a'));
    await symlink(`${l.parent}/nowhere`, decoy);
    expect(await refusalOf(() => fleet.unlink(at(fleet, 'homes/claude-a/innocent')))).toBe('fenced');
    expect(await there(decoy)).toBe(true);
  });

  test('the same name in fleet is removed once the private place is dropped from the list', async () => {
    const l = await layout();
    const decoy = `${l.home}/fleet/homes/claude-a/innocent`;
    const { fleet } = await rootsOf(l, decoy, []);
    await fleet.makeDirectory(at(fleet, 'homes/claude-a'));
    await symlink(`${l.parent}/nowhere`, decoy);
    await fleet.unlink(at(fleet, 'homes/claude-a/innocent'));
    expect(await there(decoy)).toBe(false);
  });

  test('a link in agent-homes that answers as a private file is refused fenced, and left where it was', async () => {
    const l = await layout();
    const decoy = `${l.home}/state/runtimes/agent-homes/ferret-a/.claude/innocent`;
    const { homes } = await rootsOf(l, decoy, PRIVATE);
    await homes.makeDirectory(at(homes, '.claude'));
    await symlink(`${l.parent}/nowhere`, decoy);
    expect(await refusalOf(() => homes.unlink(at(homes, '.claude/innocent')))).toBe('fenced');
    expect(await there(decoy)).toBe(true);
  });

  test('the same name in agent-homes is removed once the private place is dropped from the list', async () => {
    const l = await layout();
    const decoy = `${l.home}/state/runtimes/agent-homes/ferret-a/.claude/innocent`;
    const { homes } = await rootsOf(l, decoy, []);
    await homes.makeDirectory(at(homes, '.claude'));
    await symlink(`${l.parent}/nowhere`, decoy);
    await homes.unlink(at(homes, '.claude/innocent'));
    expect(await there(decoy)).toBe(false);
  });

  test('a FILE under an innocent name that answers as a private file is refused fenced, not outside: the fence is asked before the leaf’s kind', async () => {
    const l = await layout();
    const decoy = `${l.home}/fleet/homes/claude-a/innocent`;
    const { fleet } = await rootsOf(l, decoy, PRIVATE, bound(REAL, decoy, l.key, 'file'));
    await fleet.makeDirectory(at(fleet, 'homes/claude-a'));
    await writeFile(decoy, 'bytes');
    expect(await refusalOf(() => fleet.unlink(at(fleet, 'homes/claude-a/innocent')))).toBe('fenced');
    expect(await there(decoy)).toBe(true);
  });

  test('a FILE that is not a private place is outside, as unlink only removes a link (the control for the fenced file above)', async () => {
    const l = await layout();
    const decoy = `${l.home}/fleet/homes/claude-a/innocent`;
    const { fleet } = await rootsOf(l, decoy, [], bound(REAL, decoy, l.key, 'file'));
    await fleet.makeDirectory(at(fleet, 'homes/claude-a'));
    await writeFile(decoy, 'bytes');
    expect(await refusalOf(() => fleet.unlink(at(fleet, 'homes/claude-a/innocent')))).toBe('outside');
    expect(await there(decoy)).toBe(true);
  });
});

describe('RootHandle.unlink on a closed device (§7.7)', () => {
  const LIST = composePrivateFiles([{ id: 'ferrets', privacy: { private: ['sessions/*/environment.json'] } }]);

  /** The disk and roots of a machine whose sessions tree is past its budget, with `decoy` a link on that closed device. */
  async function closedRoots(l: Awaited<ReturnType<typeof layout>>, decoy: string, closedTree: boolean) {
    const sessions = `${l.home}/state/ferrets/sessions`;
    await mkdir(sessions, { recursive: true });
    const here = ((await REAL.identity(l.home)) as FileIdentity).device;
    // A device of its own: the root's base is on the real disk, so it is not refused whole.
    const disk = closedDisk(REAL, sessions, decoy, here + 4242n);
    return rootsOf(l, decoy, LIST, closedTree ? disk : bound(REAL, decoy, l.key));
  }

  test('a link in fleet that sits on a device the private places hold unproven is refused fenced, and left where it was', async () => {
    const l = await layout();
    const decoy = `${l.home}/fleet/homes/claude-a/innocent`;
    const { fleet } = await closedRoots(l, decoy, true);
    await fleet.makeDirectory(at(fleet, 'homes/claude-a'));
    await symlink(`${l.parent}/nowhere`, decoy);
    await symlink(`${l.parent}/nowhere`, `${l.home}/fleet/homes/claude-a/plain`);
    expect(await refusalOf(() => fleet.unlink(at(fleet, 'homes/claude-a/innocent')))).toBe('fenced');
    expect(await there(decoy)).toBe(true);
    // The control: a link beside it, on the real disk, goes.
    await fleet.unlink(at(fleet, 'homes/claude-a/plain'));
    expect(await there(`${l.home}/fleet/homes/claude-a/plain`)).toBe(false);
  }, 120_000);

  test('a link in agent-homes that sits on a device the private places hold unproven is refused fenced, and left where it was', async () => {
    const l = await layout();
    const decoy = `${l.home}/state/runtimes/agent-homes/ferret-a/.claude/innocent`;
    const { homes } = await closedRoots(l, decoy, true);
    await homes.makeDirectory(at(homes, '.claude'));
    await symlink(`${l.parent}/nowhere`, decoy);
    expect(await refusalOf(() => homes.unlink(at(homes, '.claude/innocent')))).toBe('fenced');
    expect(await there(decoy)).toBe(true);
  }, 120_000);

  test('the same link is removed when the sessions are inside the budget (the tree is not closed)', async () => {
    const l = await layout();
    const decoy = `${l.home}/fleet/homes/claude-a/innocent`;
    const { fleet } = await closedRoots(l, decoy, false);
    await fleet.makeDirectory(at(fleet, 'homes/claude-a'));
    await symlink(`${l.parent}/nowhere`, decoy);
    await fleet.unlink(at(fleet, 'homes/claude-a/innocent'));
    expect(await there(decoy)).toBe(false);
  });
});
