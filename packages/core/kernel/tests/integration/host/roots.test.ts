import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, link, mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { err, ok } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import type { FerretId } from '../../../contract/ids.ts';
import { MAX_ROOT_WINDOW_BYTES } from '../../../contract/ports.ts';
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
    expect(await resolveInRoot(fs, home, work, true, 'innocent/vault.key')).toEqual({
      ok: false,
      error: 'link_escape',
    });
    expect(await resolveInRoot(fs, home, work, true, '../home/state/vault/vault.key')).toEqual({
      ok: false,
      error: 'outside',
    });
    expect(await resolveInRoot(fs, home, work, true, 'notes.md\0')).toEqual({ ok: false, error: 'outside' });
    const fine = await resolveInRoot(fs, home, work, true, 'notes.md');
    expect(fine.ok).toBe(true);
  });

  test('S41 a link swapped in after resolve is refused at read time', async () => {
    const { home, work } = await layout();
    const roots = rootsPortFor(fs, { home, plugin: 'terminals', worktrees: `${home}-worktrees` }, ['work'], () =>
      workFolders(work),
    );
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
    const roots = rootsPortFor(
      fs,
      { home, plugin: 'skills', worktrees: `${home}-worktrees` },
      ['imports'],
      () => undefined,
    );
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
    expect([...fenced].sort()).toEqual(
      [`${home}/state/board-before-2026-11-02-1000`, `${parent}/home-before-2026-11-01-0900`].sort(),
    );
    expect((await Bun.file(`${home}/state/board-before-2026-11-02-1000`).stat()).mode & 0o777).toBe(0o700);
  });
});

describe('RootHandle: makeDirectory, realPath, lstat and exclusive writes (worktree registry parity)', () => {
  const handle = async () => {
    const { home, work } = await layout();
    const roots = rootsPortFor(fs, { home, plugin: 'worktrees', worktrees: `${home}-worktrees` }, ['work'], () =>
      workFolders(work),
    );
    const root = roots.root('work', { ferret: 'F1' as FerretId });
    const at = (relative: string): FencedPath => {
      const resolved = root.resolve(relative);
      if (!resolved.ok) throw new Error(resolved.error);
      return resolved.value;
    };
    return { home, work, root, at };
  };

  test('makeDirectory creates with the mode; realPath answers the real path of an existing name', async () => {
    const { work, root, at } = await handle();
    await root.makeDirectory(at('a/b'), { mode: 0o750 });
    expect((await Bun.file(`${work}/a/b`).stat()).mode & 0o777).toBe(0o750);
    expect(await root.realPath(at('a/b'))).toBe((await realpath(`${work}/a/b`)) as FencedPath);
    await expect(root.realPath(at('missing'))).rejects.toThrow();
  });

  test('lstat reports a link as a symlink, never as what it points at', async () => {
    const { work, root, at } = await handle();
    await symlink(`${work}/notes.md`, `${work}/alias.md`);
    expect((await root.lstat(at('alias.md')))?.kind).toBe('symlink');
    expect((await root.lstat(at('notes.md')))?.kind).toBe('file');
    expect(await root.lstat(at('nothing'))).toBeUndefined();
  });

  test('an exclusive write creates with the mode, and refuses an existing file or a planted link', async () => {
    const { home, work, root, at } = await handle();
    await root.writeText(at('registry.json'), '{}', { exclusive: true, mode: 0o640 });
    expect((await Bun.file(`${work}/registry.json`).stat()).mode & 0o777).toBe(0o640);
    await expect(root.writeText(at('registry.json'), '{}', { exclusive: true })).rejects.toThrow();
    await symlink(`${home}/state/vault/elsewhere`, `${work}/planted.json`);
    await expect(root.writeText(at('planted.json'), 'x', { exclusive: true })).rejects.toThrow();
    expect(await Bun.file(`${home}/state/vault/elsewhere`).exists()).toBe(false);
  });
});

describe('HH writeBytes, a fenced tree copy or link, and the credentials root', () => {
  test('S40 copyTree refuses a nested home and a moved-aside home at every walk entry', async () => {
    const { home, parent } = await layout();
    const imports = rootsPortFor(
      fs,
      { home, plugin: 'skills', worktrees: `${home}-worktrees` },
      ['imports', 'agent-homes'],
      () => undefined,
    );
    const source = imports.root('imports', { subfolder: parent });
    const destination = imports.root('agent-homes', { subfolder: 'f1' });
    const at = (root: typeof source, path: string): FencedPath => {
      const result = root.resolve(path);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    };
    await mkdir(`${home}/state/skills/agent-homes/f1`, { recursive: true });
    await expect(
      destination.copyTree(source, at(source, ''), at(destination, 'copy'), { maxEntries: 32 }),
    ).rejects.toThrow('fenced');
    expect(await Bun.file(`${home}/state/skills/agent-homes/f1/copy/home/state/vault/vault.key`).exists()).toBe(false);
    await expect(
      destination.copyTree(source, `${home}-before-2026-11-01-0900` as FencedPath, at(destination, 'before')),
    ).rejects.toThrow('fenced');
  });

  async function homes() {
    const { home, parent } = await layout();
    const roots = rootsPortFor(
      fs,
      { home, plugin: 'skills', worktrees: `${home}-worktrees` },
      ['agent-homes', 'downloads'],
      () => undefined,
    );
    const homesRoot = roots.root('agent-homes', { subfolder: 'f1' });
    const downloads = roots.root('downloads');
    await mkdir(`${home}/state/skills/agent-homes/f1`, { recursive: true });
    const at = (root: typeof homesRoot, relative: string): FencedPath => {
      const resolved = root.resolve(relative);
      if (!resolved.ok) throw new Error(resolved.error);
      return resolved.value;
    };
    return { home, parent, homesRoot, downloads, at };
  }

  test('writeBytes keeps bytes and the mode', async () => {
    const { home, homesRoot, at } = await homes();
    await homesRoot.makeDirectory(at(homesRoot, ''));
    await homesRoot.writeBytes(at(homesRoot, 'blob.bin'), new Uint8Array([0, 255, 7]), { mode: 0o640 });
    const path = `${home}/state/skills/agent-homes/f1/blob.bin`;
    expect([...new Uint8Array(await Bun.file(path).arrayBuffer())]).toEqual([0, 255, 7]);
    expect((await Bun.file(path).stat()).mode & 0o777).toBe(0o640);
  });

  test('copyTree copies files with their modes, skips a link and a hard-linked file, and refuses an existing target', async () => {
    const { home, homesRoot, downloads, at } = await homes();
    const src = `${home}/state/skills/downloads/skill`;
    await mkdir(`${src}/bin`, { recursive: true });
    await writeFile(`${src}/SKILL.md`, '# skill');
    await writeFile(`${src}/bin/run`, '#!/bin/sh', { mode: 0o755 });
    await symlink(`${home}/state/vault/vault.key`, `${src}/key`);
    await link(`${home}/state/vault/vault.key`, `${src}/hard`);
    await homesRoot.makeDirectory(at(homesRoot, ''));
    await homesRoot.copyTree(downloads, at(downloads, 'skill'), at(homesRoot, 'skill'));
    const dest = `${home}/state/skills/agent-homes/f1/skill`;
    expect(await Bun.file(`${dest}/SKILL.md`).text()).toBe('# skill');
    expect((await Bun.file(`${dest}/bin/run`).stat()).mode & 0o777).toBe(0o755);
    expect(await Bun.file(`${dest}/key`).exists()).toBe(false);
    expect(await Bun.file(`${dest}/hard`).exists()).toBe(false);
    await expect(homesRoot.copyTree(downloads, at(downloads, 'skill'), at(homesRoot, 'skill'))).rejects.toThrow(
      RootError,
    );
  });

  test('copyTree with link makes one link to the source folder; a handle of another plugin is refused', async () => {
    const { home, homesRoot, downloads, at } = await homes();
    await mkdir(`${home}/state/skills/downloads/skill`, { recursive: true });
    await homesRoot.makeDirectory(at(homesRoot, ''));
    await homesRoot.copyTree(downloads, at(downloads, 'skill'), at(homesRoot, 'linked'), { link: true });
    expect(await readlink(`${home}/state/skills/agent-homes/f1/linked`)).toBe(
      await realpath(`${home}/state/skills/downloads/skill`),
    );
    const other = rootsPortFor(
      fs,
      { home, plugin: 'mcp', worktrees: `${home}-worktrees` },
      ['downloads'],
      () => undefined,
    ).root('downloads');
    await expect(homesRoot.copyTree(other, at(other, 'x'), at(homesRoot, 'y'))).rejects.toThrow(RootError);
  });

  test('the credentials root is Logins’ alone, and ensurePrivateDirectory makes or narrows a folder to 0700', async () => {
    const { home } = await layout();
    const declaredByOther = rootsPortFor(
      fs,
      { home, plugin: 'accounts', worktrees: `${home}-worktrees` },
      ['credentials'],
      () => undefined,
    );
    expect(() => declaredByOther.root('credentials')).toThrow(RootError);
    const logins = rootsPortFor(
      fs,
      { home, plugin: 'logins', worktrees: `${home}-worktrees` },
      ['credentials'],
      () => undefined,
    ).root('credentials');
    const resolved = logins.resolve('claude');
    if (!resolved.ok) throw new Error(resolved.error);
    await mkdir(`${home}/state/logins/credentials`, { recursive: true, mode: 0o755 });
    await logins.ensurePrivateDirectory(resolved.value);
    expect((await Bun.file(`${home}/state/logins/credentials/claude`).stat()).mode & 0o777).toBe(0o700);
    await writeFile(`${home}/state/logins/credentials/file`, 'x');
    const file = logins.resolve('file');
    if (!file.ok) throw new Error(file.error);
    await expect(logins.ensurePrivateDirectory(file.value)).rejects.toThrow(RootError);
  });
});

describe('QQ replace an existing file without following a link; links and mode at list and stat time', () => {
  async function downloads() {
    const { home } = await layout();
    const root = rootsPortFor(
      fs,
      { home, plugin: 'mcp', worktrees: `${home}-worktrees` },
      ['downloads'],
      () => undefined,
    ).root('downloads');
    const at = (relative: string): FencedPath => {
      const resolved = root.resolve(relative);
      if (!resolved.ok) throw new Error(resolved.error);
      return resolved.value;
    };
    const dir = `${home}/state/mcp/downloads`;
    await mkdir(dir, { recursive: true });
    return { home, root, at, dir };
  }

  test('replaceExisting keeps the old mode, and refuses a link at the leaf, a missing file and a folder', async () => {
    const { home, root, at, dir } = await downloads();
    await writeFile(`${dir}/.mcp.json`, '{}', { mode: 0o664 });
    await chmod(`${dir}/.mcp.json`, 0o664);
    await root.writeText(at('.mcp.json'), '{"a":1}', { replaceExisting: true });
    expect(await Bun.file(`${dir}/.mcp.json`).text()).toBe('{"a":1}');
    expect((await Bun.file(`${dir}/.mcp.json`).stat()).mode & 0o777).toBe(0o664);
    await writeFile(`${dir}/target.json`, 'kept');
    await symlink(`${dir}/target.json`, `${dir}/linked.json`);
    await expect(root.writeText(at('linked.json'), 'x', { replaceExisting: true })).rejects.toThrow(RootError);
    expect(await Bun.file(`${dir}/target.json`).text()).toBe('kept');
    expect(await readlink(`${dir}/linked.json`)).toBe(`${dir}/target.json`);
    await expect(root.writeText(at('absent.json'), 'x', { replaceExisting: true })).rejects.toThrow(RootError);
    await mkdir(`${dir}/folder`);
    await expect(root.writeBytes(at('folder'), new Uint8Array([1]), { replaceExisting: true })).rejects.toThrow(
      RootError,
    );
    void home;
  });

  test('entries lists each leaf with its kind, mode and hard-link count, a link listed and never followed', async () => {
    const { home, root, at, dir } = await downloads();
    await writeFile(`${dir}/one`, 'x', { mode: 0o640 });
    await chmod(`${dir}/one`, 0o640);
    await link(`${dir}/one`, `${dir}/two`);
    await symlink(`${home}/state/vault/vault.key`, `${dir}/key`);
    const entries = Object.fromEntries((await root.entries(at(''))).map(entry => [entry.name, entry]));
    expect(entries['one']).toMatchObject({ kind: 'file', links: 2, mode: 0o640 });
    expect(entries['two']).toMatchObject({ kind: 'file', links: 2 });
    expect(entries['key']?.kind).toBe('symlink');
  });

  test('stat and lstat carry the mode and the link count', async () => {
    const { root, at, dir } = await downloads();
    await writeFile(`${dir}/run`, '#!/bin/sh', { mode: 0o755 });
    await chmod(`${dir}/run`, 0o755);
    expect(await root.stat(at('run'))).toMatchObject({ kind: 'file', mode: 0o755, links: 1 });
    expect(await root.lstat(at('run'))).toMatchObject({ kind: 'file', mode: 0o755, links: 1 });
  });
});

describe('WW bounded reads: a window from an offset, and a tail with the size, fenced as readBytes', () => {
  test('readBytes with a window, readTail, and a window over the cap or a link out of the root refused', async () => {
    const { home } = await layout();
    const root = rootsPortFor(
      fs,
      { home, plugin: 'codex', worktrees: `${home}-worktrees` },
      ['downloads'],
      () => undefined,
    ).root('downloads');
    const dir = `${home}/state/codex/downloads`;
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/rollout.jsonl`, '0123456789');
    const at = (relative: string): FencedPath => {
      const resolved = root.resolve(relative);
      if (!resolved.ok) throw new Error(resolved.error);
      return resolved.value;
    };
    const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
    expect(text(await root.readBytes(at('rollout.jsonl'), { offset: 2, length: 3 }))).toBe('234');
    expect(text(await root.readBytes(at('rollout.jsonl'), { offset: 8, length: 10 }))).toBe('89');
    const tail = await root.readTail(at('rollout.jsonl'), 4);
    expect({ text: text(tail.bytes), size: tail.size }).toEqual({ text: '6789', size: 10 });
    expect(text((await root.readTail(at('rollout.jsonl'), 64)).bytes)).toBe('0123456789');
    await expect(root.readBytes(at('rollout.jsonl'), { offset: 0, length: MAX_ROOT_WINDOW_BYTES + 1 })).rejects.toThrow(
      RootError,
    );
    await expect(root.readTail(at('rollout.jsonl'), MAX_ROOT_WINDOW_BYTES + 1)).rejects.toThrow(RootError);
    await expect(root.readBytes(at('rollout.jsonl'), { offset: -1, length: 1 })).rejects.toThrow(RootError);
    await writeFile(`${home}/outside.txt`, 'secret');
    await symlink(`${home}/outside.txt`, `${dir}/escape`);
    await expect(root.readTail(at('escape'), 4)).rejects.toThrow(RootError);
  });
});
