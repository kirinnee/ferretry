import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { err, ok } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import type { FerretId } from '../../../contract/ids.ts';
import type { RootHandle, RootName } from '../../../contract/ports.ts';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { fencedByName, fencedReal, fenceOf } from '../../../host/fence-guard.ts';
import { RootError, rootsPortFor } from '../../../host/roots.ts';

/**
 * The fence rows (S40, S43, S44, S45, S46, S48) at the unit tier: the REAL roots and fence over real temp folders
 * (no tmux, no network). The integration tier keeps the same proofs; this is the copy the unit report can judge.
 */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const SECRET = 'protected-fixture';

async function layout() {
  const parent = await mkdtemp(`${tmpdir()}/fy-fence-`);
  parents.push(parent);
  const home = `${parent}/home`;
  const work = `${parent}/work`;
  await mkdir(`${home}/state/gate`, { recursive: true });
  await writeFile(`${home}/state/gate/probe`, SECRET);
  await mkdir(`${home}/state/codex/agent-homes/F1`, { recursive: true });
  await writeFile(`${home}/state/codex/agent-homes/F1/own.txt`, 'mine');
  await mkdir(`${parent}/home-before-2026-11-01-0900`, { recursive: true });
  await writeFile(`${parent}/home-before-2026-11-01-0900/probe`, SECRET);
  await mkdir(work, { recursive: true });
  await writeFile(`${work}/notes.md`, 'hello');
  return { parent, home, work };
}

const fs = nodeFs(() => 'r');

const workFolders = (folder: string): WorkFolders => ({
  folderOf: () => folder as FencedPath,
  check: (_ferret, path) => (path.startsWith(folder) ? ok(path as FencedPath) : err('outside')),
});

function rootOf(
  home: string,
  name: RootName,
  scope: { readonly ferret?: FerretId; readonly subfolder?: string },
  options: { readonly fs?: HostFs; readonly work?: string; readonly hardLinkRoots?: readonly string[] } = {},
): RootHandle {
  const roots = rootsPortFor(
    options.fs ?? fs,
    { home, plugin: 'codex', worktrees: `${home}-worktrees` },
    [name],
    () => (options.work === undefined ? undefined : workFolders(options.work)),
    { random: () => 'r', ...(options.hardLinkRoots === undefined ? {} : { hardLinkRoots: options.hardLinkRoots }) },
  );
  return roots.root(name, scope);
}

/** Reads `relative` through `root`; answers the text, or the refusal the root threw. */
async function attempt(root: RootHandle, relative: string): Promise<string> {
  const path = root.resolve(relative);
  if (!path.ok) return `refused:${path.error}`;
  try {
    return await root.readText(path.value);
  } catch (error) {
    if (error instanceof RootError) return `refused:${error.refusal}`;
    return `error:${(error as { code?: string }).code ?? String(error)}`;
  }
}

/** A disk that runs `before` once, just before the real call named `at` — the deterministic interleave. */
function interleaved(at: 'openRead' | 'writeNew' | 'openDirectory', before: () => Promise<void>): HostFs {
  let armed = true;
  const wrap =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      if (armed) {
        armed = false;
        await before();
      }
      return await call(...args);
    };
  return { ...fs, [at]: wrap(fs[at] as (...args: unknown[]) => Promise<unknown>) } as HostFs;
}
describe('the fence (§7.7, §9.3), unit tier', () => {
  test('S40 an owner root reaches nothing inside the home or a moved-aside home, whatever the spelling', async () => {
    const { parent, home } = await layout();
    const imports = rootOf(home, 'imports', { subfolder: parent });
    for (const spelling of [
      'home/state/gate/probe',
      './home/state/gate/probe',
      'home/./state/gate/probe',
      './/home//state/./gate/probe',
      `${parent}/./home/state/gate/probe`,
      './home-before-2026-11-01-0900/probe',
    ])
      expect(await attempt(imports, spelling)).toBe('refused:fenced');
    // The root itself spelled with a dot is the same root, judged after normalizing.
    expect(await attempt(rootOf(home, 'imports', { subfolder: `${parent}/./work` }), './notes.md')).toBe('hello');
    expect(await attempt(rootOf(home, 'imports', { subfolder: `${parent}/./home` }), 'state/gate/probe')).toBe(
      'refused:fenced',
    );
  });

  test('S43 a path whose resolution hops through a link living inside the home is refused', async () => {
    const { parent, home, work } = await layout();
    await mkdir(`${parent}/outside`);
    await writeFile(`${parent}/outside/component.md`, 'component');
    // work/source -> <home>/state/gate/out -> <parent>/outside: lands outside, but its hop lives in the home.
    await symlink(`${parent}/outside`, `${home}/state/gate/out`);
    await symlink(`${home}/state/gate/out`, `${parent}/source`);
    const imports = rootOf(home, 'imports', { subfolder: parent });
    expect(await attempt(imports, 'source/component.md')).toBe('refused:fenced');
    expect(await attempt(imports, 'outside/component.md')).toBe('component');
    expect(await attempt(rootOf(home, 'imports', { subfolder: work }), 'notes.md')).toBe('hello');
  });

  test('S44 a write goes through the checked folder: a folder swapped for a link to the home is never written', async () => {
    const { home, work } = await layout();
    await mkdir(`${work}/sub`);
    const swapping = interleaved('writeNew', async () => {
      await rename(`${work}/sub`, `${work}/sub-moved`);
      await symlink(`${home}/state/gate`, `${work}/sub`);
    });
    const root = rootOf(home, 'work', { ferret: 'F1' as FerretId }, { fs: swapping, work });
    const path = root.resolve('sub/out.txt');
    if (!path.ok) throw new Error('resolve');
    await root.writeText(path.value, 'written');
    expect((await readdir(`${home}/state/gate`)).sort()).toEqual(['probe']);
    expect(await readFile(`${work}/sub-moved/out.txt`, 'utf8')).toBe('written');
  });

  test('S44 without descriptor reach an owner root removes nothing and an internal root removes a file, never a folder', async () => {
    const { home, work } = await layout();
    const blind = nodeFs(() => 'r', { descriptorFolder: `${work}/no-such-descriptor-folder` });
    const owner = rootOf(home, 'work', { ferret: 'F1' as FerretId }, { fs: blind, work });
    const notes = owner.resolve('notes.md');
    if (!notes.ok) throw new Error('resolve');
    await expect(owner.remove(notes.value)).rejects.toMatchObject({ refusal: 'no_descriptor_reach' });
    expect(await readFile(`${work}/notes.md`, 'utf8')).toBe('hello');
    const internal = rootOf(home, 'agent-homes', { subfolder: 'F1' }, { fs: blind });
    const own = internal.resolve('own.txt');
    if (!own.ok) throw new Error('resolve');
    await internal.remove(own.value);
    expect(await readdir(`${home}/state/codex/agent-homes/F1`)).toEqual([]);
    await mkdir(`${home}/state/codex/agent-homes/F1/tree`);
    const tree = internal.resolve('tree');
    if (!tree.ok) throw new Error('resolve');
    await expect(internal.remove(tree.value)).rejects.toMatchObject({ refusal: 'no_descriptor_reach' });
    expect(await readdir(`${home}/state/codex/agent-homes/F1`)).toEqual(['tree']);
  });

  test('S44 a folder tree is removed one name at a time through descriptors, never following a link out', async () => {
    const { home, work } = await layout();
    await mkdir(`${work}/tree/deep`, { recursive: true });
    await writeFile(`${work}/tree/deep/a.txt`, 'a');
    await symlink(`${home}/state/gate`, `${work}/tree/link`);
    const root = rootOf(home, 'work', { ferret: 'F1' as FerretId }, { work });
    const tree = root.resolve('tree');
    if (!tree.ok) throw new Error('resolve');
    await root.remove(tree.value);
    expect(await readdir(work)).toEqual(['notes.md']);
    expect(await readFile(`${home}/state/gate/probe`, 'utf8')).toBe(SECRET);
  });

  test('S44 removing a name that is a link to a folder unlinks the link and leaves the folder it points at', async () => {
    const { home, work } = await layout();
    await mkdir(`${work}/kept`, { recursive: true });
    await writeFile(`${work}/kept/SKILL.md`, 'kept');
    await symlink(`${work}/kept`, `${work}/to-folder`);
    await symlink(`${home}/state/gate`, `${work}/to-outside`);
    const root = rootOf(home, 'work', { ferret: 'F1' as FerretId }, { work });
    for (const name of ['to-folder', 'to-outside']) {
      const at = root.resolve(name);
      if (!at.ok) throw new Error('resolve');
      await root.remove(at.value);
    }
    expect((await readdir(work)).toSorted()).toEqual(['kept', 'notes.md']);
    expect(await readFile(`${work}/kept/SKILL.md`, 'utf8')).toBe('kept');
    expect(await readFile(`${home}/state/gate/probe`, 'utf8')).toBe(SECRET);
  });

  test('S46 a read takes only a regular file, never blocks on a pipe, and reads no more than its limit', async () => {
    const { home, work } = await layout();
    execFileSync('mkfifo', [`${work}/pipe`]);
    const root = rootOf(home, 'work', { ferret: 'F1' as FerretId }, { work });
    expect(await attempt(root, 'pipe')).toBe('refused:device_file');
    await writeFile(`${work}/big.txt`, 'x'.repeat(200 * 1024));
    const big = root.resolve('big.txt');
    if (!big.ok) throw new Error('resolve');
    expect((await root.readBytes(big.value, 64 * 1024)).byteLength).toBe(64 * 1024);
    const missing = root.resolve('none.txt');
    if (!missing.ok) throw new Error('resolve');
    await expect(root.readText(missing.value)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('S46 a write is an exclusive temp file renamed in the same folder: a link at the name is replaced, not followed', async () => {
    const { home, work } = await layout();
    await symlink(`${home}/state/gate/probe`, `${work}/lease`);
    const root = rootOf(home, 'work', { ferret: 'F1' as FerretId }, { work });
    const path = root.resolve('lease');
    expect(path.ok).toBe(true);
    // The name resolves through the link into the home, so the write is refused outright...
    if (path.ok) await expect(root.writeText(path.value, 'lease')).rejects.toBeInstanceOf(RootError);
    expect(await readFile(`${home}/state/gate/probe`, 'utf8')).toBe(SECRET);
    // ...and an ordinary write leaves no temp file behind.
    const fresh = root.resolve('fresh/lease');
    if (!fresh.ok) throw new Error('resolve');
    await root.writeText(fresh.value, 'one');
    await root.writeText(fresh.value, 'two');
    expect(await readdir(`${work}/fresh`)).toEqual(['lease']);
    expect(await readFile(`${work}/fresh/lease`, 'utf8')).toBe('two');
  });

  test('S48 a work folder inside the home, named directly or through a link, reaches nothing', async () => {
    const { parent, home } = await layout();
    for (const folder of [`${home}/state/gate`, `${parent}/./home/state/gate`]) {
      const root = rootOf(home, 'work', { ferret: 'F1' as FerretId }, { work: folder });
      expect(await attempt(root, 'probe')).toBe('refused:fenced');
    }
    await symlink(`${home}/state/gate`, `${parent}/linked-cwd`);
    const linked = rootOf(home, 'work', { ferret: 'F1' as FerretId }, { work: `${parent}/linked-cwd` });
    expect(await attempt(linked, 'probe')).toBe('refused:fenced');
  });

  test('S40 the fence is the home, its state and config by real path, every moved-aside home, and the key files by identity', async () => {
    const { parent, home } = await layout();
    await writeFile(`${home}/api-token`, 'token-fixture');
    const fence = await fenceOf(fs, home);
    expect(fence.real).toBe(home);
    for (const inside of [
      home,
      `${home}/state/gate/probe`,
      `${home}/config`,
      `${parent}/home-before-2026-11-01-0900/probe`,
    ])
      expect(fencedByName(fence, inside)).toBe(true);
    expect(fencedByName(fence, `${parent}/work/notes.md`)).toBe(false);
    // A real path inside the home is fenced whatever route found it; a folder beside it is not.
    expect(await fencedReal(fs, fence, `${home}/state/gate`)).toBe(true);
    expect(await fencedReal(fs, fence, `${parent}/work`)).toBe(false);
    // A key file hard-linked into a work folder is recognised by IDENTITY under another name.
    await link(`${home}/api-token`, `${parent}/work/innocent.txt`);
    expect(await fencedReal(fs, fence, `${parent}/work/innocent.txt`)).toBe(true);
    // A folder that cannot be looked at fails closed.
    expect(await fencedReal(fs, fence, `${parent}/work/not-there/at-all`)).toBe(true);
  });

  test('S45 the kernel part of an id at a boundary: a name that would climb out of its root never resolves, a plain one does', async () => {
    const { home } = await layout();
    const root = rootOf(home, 'agent-homes', { subfolder: 'F1' });
    for (const id of ['../other', '../../gate', '/other', 'a/../../other', 'F1/../../x'])
      expect(root.resolve(id).ok, id).toBe(false);
    for (const id of ['own.txt', 'conversation_1-a', 'a'.repeat(128)]) expect(root.resolve(id).ok, id).toBe(true);
    // The grammar of a conversation id itself (letters, digits, - and _, at most 128) is the harness's own test (S45
    // in claude-code); the kernel's part is that no id can reach past the root it names.
    expect(await attempt(root, '../other')).toMatch(/^refused:/u);
  });
});

/**
 * F-0033: the daemon's identity key (`state/kernel/identity.json`, the file the kernel writes) is pinned BY IDENTITY.
 * Inside the home it is fenced by name; the pin matters where a name cannot help — a hard link to it placed in a work
 * folder under an innocent name. Every door that could reach that name must refuse it as `fenced` (not merely as a
 * hard link, which is a different and weaker rule), and the key's bytes must be what they were.
 */
describe('F-0033 the daemon identity key is held by identity, whatever door reaches it', () => {
  const KEY = 'state/kernel/identity.json';
  const KEY_BYTES = 'identity-key-fixture';

  async function planted() {
    const fixture = await layout();
    await mkdir(`${fixture.home}/state/kernel`, { recursive: true });
    await writeFile(`${fixture.home}/${KEY}`, KEY_BYTES);
    await link(`${fixture.home}/${KEY}`, `${fixture.work}/innocent.txt`);
    return fixture;
  }

  const refusal = async (run: () => Promise<unknown>): Promise<string> => {
    try {
      await run();
      return 'allowed';
    } catch (error) {
      return error instanceof RootError ? `refused:${error.refusal}` : `error:${String(error)}`;
    }
  };

  test('F-0033 the fence holds the key file by device and inode', async () => {
    const { home } = await planted();
    const fence = await fenceOf(fs, home);
    const identity = await fs.identity(`${home}/${KEY}`);
    expect(fence.identities.some(held => held.device === identity?.device && held.inode === identity.inode)).toBe(true);
  });

  test('F-0033 a name that is the key by identity is fenced in the real-path verdict', async () => {
    const { home, work } = await planted();
    expect(await fencedReal(fs, await fenceOf(fs, home), `${work}/innocent.txt`)).toBe(true);
  });

  for (const name of ['work', 'imports'] as const) {
    test(`F-0033 the ${name} root refuses to read the key under another name: every read door says fenced`, async () => {
      const { home, work, parent } = await planted();
      const root =
        name === 'work'
          ? rootOf(home, 'work', { ferret: 'F1' as FerretId }, { work })
          : rootOf(home, 'imports', { subfolder: work });
      const path = root.resolve('innocent.txt');
      if (!path.ok) throw new Error('resolve');
      expect(await refusal(() => root.readText(path.value))).toBe('refused:fenced');
      expect(await refusal(() => root.readBytes(path.value))).toBe('refused:fenced');
      expect(await refusal(() => root.readTail(path.value, 64))).toBe('refused:fenced');
      expect(await refusal(() => root.readDurable(path.value))).toBe('refused:fenced');
      expect(await readFile(`${home}/${KEY}`, 'utf8')).toBe(KEY_BYTES);
      expect(await readdir(parent)).toContain('home');
    });
  }

  test('F-0033 the work root refuses to write or remove the key under another name, and the key is unchanged', async () => {
    const { home, work } = await planted();
    const root = rootOf(home, 'work', { ferret: 'F1' as FerretId }, { work });
    const path = root.resolve('innocent.txt');
    if (!path.ok) throw new Error('resolve');
    expect(await refusal(() => root.writeText(path.value, 'overwritten'))).toBe('refused:fenced');
    expect(await refusal(() => root.writeBytes(path.value, new Uint8Array([1, 2, 3])))).toBe('refused:fenced');
    expect(await refusal(() => root.remove(path.value))).toBe('refused:fenced');
    expect(await readFile(`${home}/${KEY}`, 'utf8')).toBe(KEY_BYTES);
    expect(await readFile(`${work}/innocent.txt`, 'utf8')).toBe(KEY_BYTES);
  });

  test('F-0033 a copy of the work folder does not carry the key out under another name', async () => {
    const { home, work } = await planted();
    const root = rootOf(home, 'work', { ferret: 'F1' as FerretId }, { work });
    const from = root.resolve('.');
    const to = root.resolve('copied');
    if (!from.ok || !to.ok) throw new Error('resolve');
    await root.copyTree(root, from.value, to.value).catch(() => undefined);
    expect(await readdir(`${work}/copied`).catch(() => [])).not.toContain('innocent.txt');
  });

  test('F-0033 the key is also held when it is a link TARGET placed by name: a symlink to it from the work folder is refused (as an escape)', async () => {
    const { home, work } = await planted();
    await symlink(`${home}/${KEY}`, `${work}/via-link`);
    const root = rootOf(home, 'work', { ferret: 'F1' as FerretId }, { work });
    expect(await attempt(root, 'via-link')).toMatch(/^refused:/u);
  });
});
