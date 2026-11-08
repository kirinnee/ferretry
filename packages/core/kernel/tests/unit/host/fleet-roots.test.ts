/**
 * The `fleet` root (Runtimes' internal `<home>/fleet`) and the `harness-home` root (a harness's own home on this
 * machine, read-only): the same descriptor-checked rules every root keeps — no `..`, no link out, no device file, no
 * cross-root escape, an owner's root refused inside the fence — and each held by Runtimes alone.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import type { RootHandle, RootName, RootsPort } from '../../../contract/ports.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { ensureInternalRootBases, mayHoldRoot, RootError, rootsPortFor } from '../../../host/roots.ts';
import { scopedSubfolder } from '../../../host/roots.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

async function fresh() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fleet-roots-`));
  parents.push(parent);
  const home = `${parent}/home`;
  await mkdir(`${home}/state`, { recursive: true, mode: 0o700 });
  await mkdir(`${home}/config`, { recursive: true, mode: 0o700 });
  const fs = nodeFs(() => crypto.randomUUID());
  const port = (plugin: string, declared: readonly RootName[]): RootsPort =>
    rootsPortFor(fs, { home, plugin, worktrees: `${home}-worktrees` }, declared, () => undefined);
  return { parent, home, fs, port };
}

const resolved = (root: RootHandle, path: string): FencedPath => {
  const answer = root.resolve(path);
  if (!answer.ok) throw new Error(answer.error);
  return answer.value;
};
const modeOf = async (path: string): Promise<number> => (await lstat(path)).mode & 0o777;

describe('the fleet root', () => {
  test('its base is <home>/fleet, made 0700 by the kernel, internal and writable through the handle', async () => {
    const f = await fresh();
    expect(await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'runtimes' }, ['fleet'])).toEqual([]);
    expect(await modeOf(`${f.home}/fleet`)).toBe(0o700);
    const fleet = f.port('runtimes', ['fleet']).root('fleet');
    expect(fleet.internal).toBe(true);
    await fleet.writeText(resolved(fleet, 'ids.json'), '{}\n');
    expect(await readFile(`${f.home}/fleet/ids.json`, 'utf8')).toBe('{}\n');
    expect(await fleet.readText(resolved(fleet, 'ids.json'))).toBe('{}\n');
  });

  test('it is Runtimes’ alone: another plugin that declares it is refused, and so is one that does not', async () => {
    const f = await fresh();
    expect(mayHoldRoot('runtimes', 'fleet')).toBe(true);
    expect(mayHoldRoot('claude-code', 'fleet')).toBe(false);
    expect(() => f.port('claude-code', ['fleet']).root('fleet')).toThrow(new RootError('not_declared'));
    expect(() => f.port('runtimes', []).root('fleet')).toThrow(new RootError('not_declared'));
    // nor is its base made for another plugin
    expect(await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'claude-code' }, ['fleet'])).toEqual([]);
    await expect(lstat(`${f.home}/fleet`)).rejects.toThrow();
  });

  test('`..`, an absolute path and NUL are refused before anything is touched', async () => {
    const f = await fresh();
    const fleet = f.port('runtimes', ['fleet']).root('fleet');
    expect(fleet.resolve('../config/runtimes.yaml')).toEqual({ ok: false, error: expect.any(String) });
    expect(fleet.resolve('/etc/passwd').ok).toBe(false);
    expect(fleet.resolve('bin/\0x').ok).toBe(false);
  });

  test('a link inside it that points out of it — into config/, state/ or outside the home — is never followed', async () => {
    const f = await fresh();
    await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'runtimes' }, ['fleet']);
    await writeFile(`${f.home}/config/runtimes.yaml`, 'secret-free: true\n');
    await writeFile(`${f.parent}/outside.txt`, 'outside\n');
    await symlink(`${f.home}/config`, `${f.home}/fleet/to-config`);
    await symlink(`${f.home}/state`, `${f.home}/fleet/to-state`);
    await symlink(`${f.parent}/outside.txt`, `${f.home}/fleet/outside.txt`);
    const fleet = f.port('runtimes', ['fleet']).root('fleet');
    await expect(fleet.readText(resolved(fleet, 'to-config/runtimes.yaml'))).rejects.toThrow(RootError);
    await expect(fleet.writeText(resolved(fleet, 'to-state/planted.json'), '{}')).rejects.toThrow(RootError);
    await expect(fleet.readText(resolved(fleet, 'outside.txt'))).rejects.toThrow(RootError);
    await expect(lstat(`${f.home}/state/planted.json`)).rejects.toThrow();
    // the link itself is reported as a link, never as what it points at
    expect((await fleet.lstat(resolved(fleet, 'outside.txt')))?.kind).toBe('symlink');
  });

  test('a fleet base that is itself a link (to a folder outside the home) is refused, made or not', async () => {
    const f = await fresh();
    await mkdir(`${f.parent}/elsewhere`, { mode: 0o700 });
    await symlink(`${f.parent}/elsewhere`, `${f.home}/fleet`);
    const refusals = await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'runtimes' }, ['fleet']);
    expect(refusals.map(item => item.name)).toEqual(['fleet']);
    const fleet = f.port('runtimes', ['fleet']).root('fleet');
    await expect(fleet.writeText(resolved(fleet, 'ids.json'), '{}')).rejects.toThrow(RootError);
    await expect(lstat(`${f.parent}/elsewhere/ids.json`)).rejects.toThrow();
  });

  test('a handle scoped to ONE runtime home reaches that home and nothing beside it', async () => {
    const f = await fresh();
    await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'runtimes' }, ['fleet']);
    const port = f.port('runtimes', ['fleet']);
    const mine = port.root('fleet', { subfolder: 'homes/abc' });
    await mine.writeText(resolved(mine, 'settings.json'), '{}\n');
    expect(await readFile(`${f.home}/fleet/homes/abc/settings.json`, 'utf8')).toBe('{}\n');
    expect(mine.resolve('../other/settings.json').ok).toBe(false);
    // an escaping scope resolves nothing at all
    expect(scopedSubfolder('fleet', '../state')).toBeUndefined();
    expect(scopedSubfolder('fleet', '/abs')).toBeUndefined();
    expect(port.root('fleet', { subfolder: '../state' }).resolve('x').ok).toBe(false);
    // a link put where the scoped home should be is refused, not followed
    await mkdir(`${f.parent}/elsewhere`);
    await symlink(`${f.parent}/elsewhere`, `${f.home}/fleet/homes/linked`);
    const linked = port.root('fleet', { subfolder: 'homes/linked' });
    await expect(linked.writeText(resolved(linked, 'settings.json'), '{}')).rejects.toThrow(RootError);
    await expect(lstat(`${f.parent}/elsewhere/settings.json`)).rejects.toThrow();
  });
});

describe('the harness-home root', () => {
  test('a harness’s own home outside the home is read through the handle, and never written', async () => {
    const f = await fresh();
    const claude = `${f.parent}/owner/.claude`;
    await mkdir(`${claude}/skills/one`, { recursive: true });
    await writeFile(`${claude}/CLAUDE.md`, '# mine\n');
    const handle = f.port('runtimes', ['harness-home']).root('harness-home', { subfolder: claude });
    expect(handle.internal).toBe(false);
    expect(await handle.readText(resolved(handle, 'CLAUDE.md'))).toBe('# mine\n');
    expect(await handle.list(resolved(handle, 'skills'))).toEqual(['one']);
    await expect(handle.writeText(resolved(handle, 'CLAUDE.md'), 'changed')).rejects.toThrow(
      new RootError('read_only'),
    );
    await expect(handle.remove(resolved(handle, 'CLAUDE.md'))).rejects.toThrow(RootError);
    expect(await readFile(`${claude}/CLAUDE.md`, 'utf8')).toBe('# mine\n');
  });

  test('it is Runtimes’ alone, and its scope must be an absolute folder', async () => {
    const f = await fresh();
    expect(mayHoldRoot('claude-code', 'harness-home')).toBe(false);
    expect(() => f.port('claude-code', ['harness-home']).root('harness-home', { subfolder: '/x' })).toThrow(
      new RootError('not_declared'),
    );
    const port = f.port('runtimes', ['harness-home']);
    expect(port.root('harness-home', { subfolder: 'relative/.claude' }).resolve('CLAUDE.md').ok).toBe(false);
    expect(port.root('harness-home').resolve('CLAUDE.md').ok).toBe(false);
  });

  test('a harness home inside the fence (the daemon’s own home, a runtime home under fleet/) is refused', async () => {
    const f = await fresh();
    await mkdir(`${f.home}/fleet/homes/abc`, { recursive: true, mode: 0o700 });
    await writeFile(`${f.home}/fleet/homes/abc/CLAUDE.md`, 'x');
    const port = f.port('runtimes', ['harness-home']);
    for (const subfolder of [f.home, `${f.home}/fleet/homes/abc`]) {
      const handle = port.root('harness-home', { subfolder });
      const answer = handle.resolve('CLAUDE.md');
      if (answer.ok) await expect(handle.readText(answer.value)).rejects.toThrow(RootError);
    }
  });

  test('a link in a harness home that points into the fence is never followed', async () => {
    const f = await fresh();
    const claude = `${f.parent}/owner/.claude`;
    await mkdir(claude, { recursive: true });
    await mkdir(`${f.home}/state/logins`, { recursive: true });
    await writeFile(`${f.home}/state/logins/token.json`, '{"not":"for you"}');
    await symlink(`${f.home}/state/logins/token.json`, `${claude}/settings.json`);
    const handle = f.port('runtimes', ['harness-home']).root('harness-home', { subfolder: claude });
    await expect(handle.readText(resolved(handle, 'settings.json'))).rejects.toThrow(RootError);
  });
});
