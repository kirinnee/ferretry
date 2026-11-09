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

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const DECLARED: readonly RootName[] = ['fleet', 'agent-homes'];
const REAL = nodeFs(() => 'r');
/** What the composed list holds for one plugin that declared `secret.key` private. */
const PRIVATE = ['state/vaultish/secret.key'];

/** A LINK name that answers as another file's device and inode: what a bind mount of that file shows. */
function bound(base: HostFs, decoy: string, source: string): HostFs {
  // The name itself, or the same leaf reached through a folder descriptor (`/proc/self/fd/N/<leaf>`).
  const isDecoy = (path: string): boolean =>
    path === decoy || (path.startsWith('/proc/self/fd/') && path.endsWith(`/${basename(decoy)}`));
  return {
    ...base,
    identity: async path => {
      if (!isDecoy(path)) return await base.identity(path);
      const found = await base.identity(source);
      return found === undefined ? undefined : ({ ...found, kind: 'link', links: 1 } satisfies FileIdentity);
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

async function rootsOf(l: Awaited<ReturnType<typeof layout>>, decoy: string, privateFiles: readonly string[]) {
  const port = rootsPortFor(
    bound(REAL, decoy, l.key),
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
});
