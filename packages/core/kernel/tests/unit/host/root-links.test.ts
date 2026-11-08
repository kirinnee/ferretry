/**
 * `RootHandle.linkTo` and `RootHandle.setMode` on the real disk (§7.7, kernel batch #2 part 2): a link is written only
 * into `fleet` or `agent-homes`, only pointing at the REAL path of a name in one of the SAME plugin's own handles, only
 * where nothing is at the name and no link sits on the way; a mode is set only through a no-follow descriptor, only
 * within `0o700` on an internal root and `0o777` elsewhere, never on a read-only root and never on a hard-linked file.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import type { RootHandle, RootName, RootsPort } from '../../../contract/ports.ts';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const DECLARED: readonly RootName[] = ['fleet', 'harness-home', 'downloads', 'agent-homes', 'worktrees'];

async function fresh() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/root-links-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const owner = `${parent}/owner`;
  await mkdir(`${home}/state`, { recursive: true, mode: 0o700 });
  await mkdir(`${home}/config`, { recursive: true, mode: 0o700 });
  await mkdir(`${owner}/.claude`, { recursive: true, mode: 0o700 });
  await mkdir(`${home}-worktrees`, { recursive: true, mode: 0o700 });
  await writeFile(`${owner}/.claude/.credentials.json`, '{"planted":"credential"}\n', { mode: 0o600 });
  await mkdir(`${owner}/.claude/projects`, { mode: 0o700 });
  const fs = nodeFs(() => crypto.randomUUID());
  const port = (plugin: string, declared: readonly RootName[] = DECLARED): RootsPort =>
    rootsPortFor(fs, { home, plugin, worktrees: `${home}-worktrees` }, declared, () => undefined);
  await ensureInternalRootBases(fs, { home, plugin: 'runtimes' }, DECLARED);
  const runtimes = port('runtimes');
  const fleet = runtimes.root('fleet');
  const harness = runtimes.root('harness-home', { subfolder: `${owner}/.claude` });
  await fleet.makeDirectory(at(fleet, 'homes/claude-a'));
  return { parent, home, owner, fs, port, runtimes, fleet, harness };
}

const at = (root: RootHandle, path: string): FencedPath => {
  const resolved = root.resolve(path);
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value;
};

/** The refusal a call made, or `undefined` when it went through. */
async function refusalOf(call: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await call();
    return undefined;
  } catch (error) {
    if (error instanceof RootError) return error.refusal;
    throw error;
  }
}

describe('RootHandle.linkTo', () => {
  test('writes a link whose text is the REAL path of a file in one of this plugin’s own roots', async () => {
    const f = await fresh();
    await f.fleet.linkTo(at(f.fleet, 'homes/claude-a/.credentials.json'), {
      root: f.harness,
      path: at(f.harness, '.credentials.json'),
    });
    const placed = `${f.home}/fleet/homes/claude-a/.credentials.json`;
    expect((await lstat(placed)).isSymbolicLink()).toBe(true);
    expect(await readlink(placed)).toBe(`${f.owner}/.claude/.credentials.json`);
    expect((await f.fleet.lstat(at(f.fleet, 'homes/claude-a/.credentials.json')))?.kind).toBe('symlink');
    // the kernel's own reads still never follow it out of the root
    expect(await refusalOf(() => f.fleet.readText(at(f.fleet, 'homes/claude-a/.credentials.json')))).toBe(
      'link_escape',
    );
  });

  test('links a folder too, and names a target reached through a link inside its root by its real path', async () => {
    const f = await fresh();
    await symlink(`${f.owner}/.claude/projects`, `${f.owner}/.claude/projects-alias`);
    await f.fleet.linkTo(at(f.fleet, 'homes/claude-a/projects'), {
      root: f.harness,
      path: at(f.harness, 'projects-alias'),
    });
    expect(await readlink(`${f.home}/fleet/homes/claude-a/projects`)).toBe(`${f.owner}/.claude/projects`);
  });

  test('a target outside this plugin’s own roots is refused: forged paths, another plugin’s handle, a look-alike', async () => {
    const f = await fresh();
    const place = at(f.fleet, 'homes/claude-a/x');
    // a forged path outside the target's root
    expect(await refusalOf(() => f.fleet.linkTo(place, { root: f.harness, path: '/etc/passwd' as FencedPath }))).toBe(
      'outside',
    );
    expect(
      await refusalOf(() =>
        f.fleet.linkTo(place, { root: f.harness, path: `${f.owner}/.claude/../.ssh/id` as FencedPath }),
      ),
    ).toBe('outside');
    // another plugin's handle on an owner's folder it may hold
    const stranger = f.port('stranger', ['downloads']).root('downloads');
    await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'stranger' }, ['downloads']);
    await stranger.writeText(at(stranger, 'a.txt'), 'a');
    expect(await refusalOf(() => f.fleet.linkTo(place, { root: stranger, path: at(stranger, 'a.txt') }))).toBe(
      'not_declared',
    );
    // a copy of a real handle is not a handle the kernel made
    expect(
      await refusalOf(() =>
        f.fleet.linkTo(place, { root: { ...f.harness }, path: at(f.harness, '.credentials.json') }),
      ),
    ).toBe('not_declared');
    expect((await f.fleet.lstat(place)) === undefined).toBe(true);
  });

  test('anything already at the name is refused: a file, a link, a dangling link, a folder', async () => {
    const f = await fresh();
    const target = { root: f.harness, path: at(f.harness, '.credentials.json') };
    const dir = `${f.home}/fleet/homes/claude-a`;
    await writeFile(`${dir}/file`, 'mine');
    await symlink(`${f.parent}/elsewhere`, `${dir}/dangling`);
    await symlink(`${f.owner}/.claude/.credentials.json`, `${dir}/linked`);
    await mkdir(`${dir}/folder`);
    for (const name of ['file', 'dangling', 'linked', 'folder'])
      expect(await refusalOf(() => f.fleet.linkTo(at(f.fleet, `homes/claude-a/${name}`), target))).toBe('outside');
    expect(await readlink(`${dir}/dangling`)).toBe(`${f.parent}/elsewhere`);
  });

  test('only into fleet or agent-homes: an owner’s root, a read-only root and any other internal root refuse', async () => {
    const f = await fresh();
    const target = { root: f.harness, path: at(f.harness, '.credentials.json') };
    expect(await refusalOf(() => f.harness.linkTo(at(f.harness, 'copy.json'), target))).toBe('read_only');
    const downloads = f.runtimes.root('downloads');
    expect(await refusalOf(() => downloads.linkTo(at(downloads, 'x'), target))).toBe('read_only');
    const worktrees = f.runtimes.root('worktrees');
    expect(await refusalOf(() => worktrees.linkTo(at(worktrees, 'x'), target))).toBe('read_only');
    const homes = f.runtimes.root('agent-homes', { subfolder: 'ferret-a' });
    await homes.makeDirectory(at(homes, '.claude'));
    await homes.linkTo(at(homes, '.claude/.credentials.json'), target);
    expect(await readlink(`${f.home}/state/runtimes/agent-homes/ferret-a/.claude/.credentials.json`)).toBe(
      `${f.owner}/.claude/.credentials.json`,
    );
  });

  test('a link on the way to the name is refused, even one that stays inside the root', async () => {
    const f = await fresh();
    await mkdir(`${f.home}/fleet/homes/claude-b`, { mode: 0o700 });
    await symlink(`${f.home}/fleet/homes/claude-b`, `${f.home}/fleet/homes/alias`);
    const target = { root: f.harness, path: at(f.harness, '.credentials.json') };
    expect(await refusalOf(() => f.fleet.linkTo(at(f.fleet, 'homes/alias/.credentials.json'), target))).toBe(
      'link_escape',
    );
    expect((await f.fleet.lstat(at(f.fleet, 'homes/claude-b/.credentials.json'))) === undefined).toBe(true);
  });

  test('its folder must already exist: nothing is made for a link', async () => {
    const f = await fresh();
    const target = { root: f.harness, path: at(f.harness, '.credentials.json') };
    expect(await refusalOf(() => f.fleet.linkTo(at(f.fleet, 'homes/never/.credentials.json'), target))).toBe('outside');
    expect(await f.fleet.lstat(at(f.fleet, 'homes/never'))).toBeUndefined();
  });

  test('a missing target is refused unless it is declared dangling; dangling still needs its folder', async () => {
    const f = await fresh();
    const place = at(f.fleet, 'homes/claude-a/.credentials-empty.json');
    const missing = at(f.harness, 'not-yet.json');
    expect(await refusalOf(() => f.fleet.linkTo(place, { root: f.harness, path: missing }))).toBe('outside');
    await f.fleet.linkTo(place, { root: f.harness, path: missing, dangling: true });
    expect(await readlink(`${f.home}/fleet/homes/claude-a/.credentials-empty.json`)).toBe(
      `${f.owner}/.claude/not-yet.json`,
    );
    expect(
      await refusalOf(() =>
        f.fleet.linkTo(at(f.fleet, 'homes/claude-a/deep'), {
          root: f.harness,
          path: at(f.harness, 'no-folder/x.json'),
          dangling: true,
        }),
      ),
    ).toBe('outside');
  });

  test('a dangling link at the target is never pointed at, dangling or not', async () => {
    const f = await fresh();
    await symlink(`${f.parent}/gone`, `${f.owner}/.claude/broken.json`);
    const place = at(f.fleet, 'homes/claude-a/broken.json');
    const target = { root: f.harness, path: at(f.harness, 'broken.json') };
    expect(await refusalOf(() => f.fleet.linkTo(place, target))).toBe('not_a_file');
    expect(await refusalOf(() => f.fleet.linkTo(place, { ...target, dangling: true }))).toBe('not_a_file');
    expect(await f.fleet.lstat(place)).toBeUndefined();
  });

  test('a target with a second hard link, or reached through a link out of its root, is refused', async () => {
    const f = await fresh();
    await writeFile(`${f.parent}/outside.json`, 'outside');
    await link(`${f.parent}/outside.json`, `${f.owner}/.claude/twin.json`);
    await symlink(`${f.parent}/outside.json`, `${f.owner}/.claude/out.json`);
    const place = at(f.fleet, 'homes/claude-a/t');
    expect(await refusalOf(() => f.fleet.linkTo(place, { root: f.harness, path: at(f.harness, 'twin.json') }))).toBe(
      'hard_link',
    );
    expect(await refusalOf(() => f.fleet.linkTo(place, { root: f.harness, path: at(f.harness, 'out.json') }))).toBe(
      'link_escape',
    );
  });

  test('a target that leads into the fence is refused', async () => {
    const f = await fresh();
    await writeFile(`${f.home}/config/runtimes.yaml`, 'x: 1\n');
    await symlink(`${f.home}/config`, `${f.owner}/.claude/to-config`);
    const place = at(f.fleet, 'homes/claude-a/c');
    // out of the harness home first: refused as a link out of its root
    expect(
      await refusalOf(() => f.fleet.linkTo(place, { root: f.harness, path: at(f.harness, 'to-config/runtimes.yaml') })),
    ).toBe('link_escape');
    // a harness-home handle whose folder holds the kernel home: the fence itself refuses, by name and through a link
    const wide = f.runtimes.root('harness-home', { subfolder: f.parent });
    await symlink(`${f.home}/config`, `${f.parent}/to-config`);
    expect(
      await refusalOf(() =>
        f.fleet.linkTo(place, { root: wide, path: `${f.home}/config/runtimes.yaml` as FencedPath }),
      ),
    ).toBe('fenced');
    expect(
      await refusalOf(() => f.fleet.linkTo(place, { root: wide, path: at(wide, 'to-config/runtimes.yaml') })),
    ).toBe('fenced');
    expect(await f.fleet.lstat(place)).toBeUndefined();
  });
});

describe('RootHandle.setMode', () => {
  test('an internal root keeps only 0o700: group, other, setuid, setgid and sticky bits are dropped', async () => {
    const f = await fresh();
    const file = at(f.fleet, 'homes/claude-a/settings.json');
    await f.fleet.writeText(file, '{}');
    await f.fleet.setMode(file, 0o755);
    expect((await stat(file)).mode & 0o7777).toBe(0o700);
    await f.fleet.setMode(file, 0o6644);
    expect((await stat(file)).mode & 0o7777).toBe(0o600);
    await f.fleet.setMode(file, 0o1777);
    expect((await stat(file)).mode & 0o7777).toBe(0o700);
    await f.fleet.setMode(file, 0o400);
    expect((await f.fleet.stat(file))?.mode).toBe(0o400);
    const folder = at(f.fleet, 'homes/claude-a');
    await f.fleet.setMode(folder, 0o755);
    expect((await stat(folder)).mode & 0o7777).toBe(0o700);
  });

  test('another writable root keeps 0o777 but never setuid, setgid or sticky', async () => {
    const f = await fresh();
    const worktrees = f.runtimes.root('worktrees');
    const file = at(worktrees, 'repo/run.sh');
    await worktrees.writeText(file, '#!/bin/sh\n');
    await worktrees.setMode(file, 0o4755);
    expect((await stat(file)).mode & 0o7777).toBe(0o755);
  });

  test('a read-only root refuses, and nothing changes', async () => {
    const f = await fresh();
    expect(await refusalOf(() => f.harness.setMode(at(f.harness, '.credentials.json'), 0o600))).toBe('read_only');
    expect((await stat(`${f.owner}/.claude/.credentials.json`)).mode & 0o777).toBe(0o600);
  });

  test('a link at the name is refused and never followed: what it points at keeps its mode', async () => {
    const f = await fresh();
    const dir = `${f.home}/fleet/homes/claude-a`;
    await writeFile(`${dir}/real.json`, '{}', { mode: 0o600 });
    await symlink(`${dir}/real.json`, `${dir}/alias.json`);
    await writeFile(`${f.parent}/outside.json`, '{}', { mode: 0o644 });
    await chmod(`${f.parent}/outside.json`, 0o644);
    await symlink(`${f.parent}/outside.json`, `${dir}/out.json`);
    expect(await refusalOf(() => f.fleet.setMode(at(f.fleet, 'homes/claude-a/alias.json'), 0o400))).toBe('link_escape');
    expect(await refusalOf(() => f.fleet.setMode(at(f.fleet, 'homes/claude-a/out.json'), 0o400))).toBe('link_escape');
    expect((await stat(`${dir}/real.json`)).mode & 0o777).toBe(0o600);
    expect((await stat(`${f.parent}/outside.json`)).mode & 0o777).toBe(0o644);
  });

  test('a file with a second hard link is refused: its mode is that other name’s too', async () => {
    const f = await fresh();
    const dir = `${f.home}/fleet/homes/claude-a`;
    await writeFile(`${f.parent}/outside.json`, '{}', { mode: 0o644 });
    await chmod(`${f.parent}/outside.json`, 0o644);
    await link(`${f.parent}/outside.json`, `${dir}/twin.json`);
    expect(await refusalOf(() => f.fleet.setMode(at(f.fleet, 'homes/claude-a/twin.json'), 0o400))).toBe('hard_link');
    expect((await stat(`${f.parent}/outside.json`)).mode & 0o777).toBe(0o644);
  });

  test('a file swapped in between the look at the name and the open is refused, and keeps its mode', async () => {
    const f = await fresh();
    const dir = `${f.home}/fleet/homes/claude-a`;
    await writeFile(`${dir}/swap.json`, '{}', { mode: 0o600 });
    await writeFile(`${dir}/other.json`, 'other', { mode: 0o600 });
    await chmod(`${dir}/other.json`, 0o640);
    let swapped = false;
    const racing: HostFs = {
      ...f.fs,
      openRead: async path => {
        if (!swapped && path.endsWith('/swap.json')) {
          swapped = true;
          await rename(`${dir}/other.json`, `${dir}/swap.json`);
        }
        return await f.fs.openRead(path);
      },
    };
    const fleet = rootsPortFor(
      racing,
      { home: f.home, plugin: 'runtimes', worktrees: `${f.home}-worktrees` },
      DECLARED,
      () => undefined,
    ).root('fleet');
    expect(await refusalOf(() => fleet.setMode(at(fleet, 'homes/claude-a/swap.json'), 0o400))).toBe('changed');
    expect(swapped).toBe(true);
    expect((await stat(`${dir}/swap.json`)).mode & 0o777).toBe(0o640);
  });

  test('a mode that is not an integer in 0..0o7777, and a missing name, are refused', async () => {
    const f = await fresh();
    const file = at(f.fleet, 'homes/claude-a/s.json');
    await f.fleet.writeText(file, '{}');
    for (const mode of [-1, 0o10000, 1.5, Number.NaN])
      expect(await refusalOf(() => f.fleet.setMode(file, mode))).toBe('outside');
    expect(await refusalOf(() => f.fleet.setMode(at(f.fleet, 'homes/claude-a/missing'), 0o600))).toBe('outside');
  });

  test('a path through a link out of the root, or the root itself, is refused', async () => {
    const f = await fresh();
    await mkdir(`${f.parent}/outside`, { mode: 0o755 });
    await writeFile(`${f.parent}/outside/x`, 'x', { mode: 0o644 });
    await chmod(`${f.parent}/outside/x`, 0o644);
    await symlink(`${f.parent}/outside`, `${f.home}/fleet/out`);
    expect(await refusalOf(() => f.fleet.setMode(at(f.fleet, 'out/x'), 0o600))).toBe('link_escape');
    expect((await stat(`${f.parent}/outside/x`)).mode & 0o777).toBe(0o644);
    const scoped = f.runtimes.root('fleet', { subfolder: 'homes/claude-a' });
    expect(await refusalOf(() => scoped.setMode(`${f.home}/fleet/homes/claude-a` as FencedPath, 0o755))).toBe(
      'outside',
    );
  });
});
