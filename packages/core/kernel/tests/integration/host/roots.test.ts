import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { err, ok } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import type { FerretId } from '../../../contract/ids.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { fenceFolders } from '../../../host/home.ts';
import { resolveInRoot, RootError, rootsPortFor } from '../../../host/roots.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

async function layout() {
  const parent = await mkdtemp(`${tmpdir()}/fy-roots-`);
  parents.push(parent);
  const home = `${parent}/home`;
  const work = `${parent}/work`;
  await mkdir(`${home}/state/vault`, { recursive: true });
  await writeFile(`${home}/state/vault/vault.key`, 'k');
  await mkdir(`${parent}/home-before-2026-11-01-0900`, { recursive: true });
  await mkdir(work, { recursive: true });
  await writeFile(`${work}/notes.md`, 'hello');
  return { parent, home, work };
}

const fs = nodeFs(() => 'r');

const workFolders = (folder: string): WorkFolders => ({
  folderOf: () => folder as FencedPath,
  check: (_ferret, path) => (path.startsWith(folder) ? ok(path as FencedPath) : err('outside')),
});

describe('roots and the fence (§7.7, §9.3)', () => {
  test('S40 an owner root reaches nothing inside the home, named directly', async () => {
    const { home } = await layout();
    expect(await resolveInRoot(fs, home, home, true, 'state/vault/vault.key')).toEqual({ ok: false, error: 'fenced' });
    const before = `${home.slice(0, home.lastIndexOf('/'))}/home-before-2026-11-01-0900`;
    expect((await resolveInRoot(fs, home, before, true, '')).ok).toBe(false);
  });

  test('S41 a symlink or .. cannot get past the fence: checks run on the real path', async () => {
    const { home, work } = await layout();
    await symlink(`${home}/state/vault`, `${work}/innocent`);
    expect(await resolveInRoot(fs, home, work, true, 'innocent/vault.key')).toEqual({ ok: false, error: 'link_escape' });
    expect(await resolveInRoot(fs, home, work, true, '../home/state/vault/vault.key')).toEqual({ ok: false, error: 'outside' });
    expect(await resolveInRoot(fs, home, work, true, 'notes.md\0')).toEqual({ ok: false, error: 'outside' });
    const fine = await resolveInRoot(fs, home, work, true, 'notes.md');
    expect(fine.ok).toBe(true);
  });

  test('S41 a link swapped in after resolve is refused at read time', async () => {
    const { home, work } = await layout();
    const roots = rootsPortFor(fs, { home, plugin: 'terminals', worktrees: `${home}-worktrees` }, ['work'], () => workFolders(work));
    const root = roots.root('work', { ferret: 'F1' as FerretId });
    const resolved = root.resolve('later.txt');
    expect(resolved.ok).toBe(true);
    await symlink(`${home}/state/vault/vault.key`, `${work}/later.txt`);
    if (resolved.ok) await expect(root.readText(resolved.value)).rejects.toBeInstanceOf(RootError);
    const notes = root.resolve('notes.md');
    if (notes.ok) expect(await root.readText(notes.value)).toBe('hello');
  });

  test('a root the manifest did not declare throws; a read-only owner root refuses writes', async () => {
    const { home, work } = await layout();
    const roots = rootsPortFor(fs, { home, plugin: 'skills', worktrees: `${home}-worktrees` }, ['imports'], () => undefined);
    expect(() => roots.root('work')).toThrow(RootError);
    const imports = roots.root('imports', { subfolder: work });
    const path = imports.resolve('notes.md');
    expect(path.ok).toBe(true);
    if (path.ok) await expect(imports.writeText(path.value, 'x')).rejects.toBeInstanceOf(RootError);
  });

  test('every -before- folder is set to 0700 on start', async () => {
    const { home, parent } = await layout();
    await mkdir(`${home}/state/board-before-2026-11-02-1000`, { recursive: true, mode: 0o755 });
    const fenced = await fenceFolders(fs, home);
    expect([...fenced].sort()).toEqual([`${home}/state/board-before-2026-11-02-1000`, `${parent}/home-before-2026-11-01-0900`].sort());
    expect((await Bun.file(`${home}/state/board-before-2026-11-02-1000`).stat()).mode & 0o777).toBe(0o700);
  });
});
