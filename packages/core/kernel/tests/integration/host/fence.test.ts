import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { err, ok } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import type { FerretId } from '../../../contract/ids.ts';
import type { RootHandle, RootName } from '../../../contract/ports.ts';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { bootHost, type RunningHost } from '../../../host/host.ts';
import { listenLocal, runSocketPath } from '../../../host/listener.ts';
import { RootError, rootsPortFor } from '../../../host/roots.ts';
import { realAdapters } from '../../../host/wiring.ts';

/**
 * The fence's retained proofs (§7.7, §9.3), ported from today's state-home guard fixtures: dot segments, the
 * ancestor root, a swap AT the open boundary, hard links and the immutable-store exception, internal roots'
 * anchored bases, link hops through the home, descriptor-reached writes — and the home lock boot takes (G57).
 */

const parents: string[] = [];
const running: RunningHost[] = [];
afterEach(async () => {
  for (const host of running.splice(0)) await host.stop();
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

describe('the fence (§7.7, §9.3)', () => {
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

  test('S41 a root at the PARENT of the home: dot segments are normalized before every fence comparison', async () => {
    const { parent, home } = await layout();
    const imports = rootOf(home, 'imports', { subfolder: parent });
    expect(await attempt(imports, 'work/./notes.md')).toBe('hello');
    expect(await attempt(imports, 'work/../home/state/gate/probe')).toBe('refused:outside');
    // A symlinked home is fenced by its real path too.
    await symlink(home, `${parent}/alias`);
    expect(await attempt(imports, 'alias/state/gate/probe')).toBe('refused:fenced');
    expect(await attempt(imports, './alias/./state/gate/probe')).toBe('refused:fenced');
    // A not-yet-made write suffix is judged normalized as well.
    const work = rootOf(home, 'work', { ferret: 'F1' as FerretId }, { work: parent });
    const write = work.resolve('./home/./state/gate/new.txt');
    expect(write.ok).toBe(false);
  });

  test('S41 the final file swapped for a link AT the open boundary is refused, never read', async () => {
    const { home, work } = await layout();
    await writeFile(`${work}/swap.txt`, 'ordinary');
    const swapping = interleaved('openRead', async () => {
      await rm(`${work}/swap.txt`);
      await symlink(`${home}/state/gate/probe`, `${work}/swap.txt`);
    });
    const root = rootOf(home, 'work', { ferret: 'F1' as FerretId }, { fs: swapping, work });
    expect(await attempt(root, 'swap.txt')).toBe('refused:changed');
  });

  test('S41 a parent folder swapped for a link to the home AT the open boundary is refused', async () => {
    const { home, work } = await layout();
    await mkdir(`${work}/sub`);
    await writeFile(`${work}/sub/probe`, 'ordinary');
    const swapping = interleaved('openRead', async () => {
      await rename(`${work}/sub`, `${work}/sub-moved`);
      await symlink(`${home}/state/gate`, `${work}/sub`);
    });
    const root = rootOf(home, 'work', { ferret: 'F1' as FerretId }, { fs: swapping, work });
    const read = await attempt(root, 'sub/probe');
    expect(read).not.toBe(SECRET);
    expect(read.startsWith('refused:')).toBe(true);
  });

  test('S42 an internal root reaches only its own subtree: a substituted (linked) base fails closed', async () => {
    const { home } = await layout();
    expect(await attempt(rootOf(home, 'agent-homes', { subfolder: 'F1' }), 'own.txt')).toBe('mine');
    await symlink(`${home}/state/gate`, `${home}/state/codex/agent-homes/escape`);
    expect(await attempt(rootOf(home, 'agent-homes', { subfolder: 'escape' }), 'probe')).toBe('refused:link_escape');
    expect(await attempt(rootOf(home, 'agent-homes', { subfolder: '../../gate' }), 'probe')).toBe('refused:outside');
    expect(await attempt(rootOf(home, 'agent-homes', { subfolder: '/etc' }), 'passwd')).toBe('refused:outside');
    // The agent-homes folder itself substituted.
    await rename(`${home}/state/codex/agent-homes`, `${home}/state/codex/agent-homes-real`);
    await symlink(`${home}/state/gate`, `${home}/state/codex/agent-homes`);
    expect(await attempt(rootOf(home, 'agent-homes', {}), 'probe')).toBe('refused:link_escape');
    // A linked downloads base and a linked worktrees base.
    await symlink(`${home}/state/gate`, `${home}/state/codex/downloads`);
    expect(await attempt(rootOf(home, 'downloads', {}), 'probe')).toBe('refused:link_escape');
    await symlink(`${home}/state/gate`, `${home}-worktrees`);
    expect(await attempt(rootOf(home, 'worktrees', {}), 'probe')).toBe('refused:link_escape');
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

  test('S44 without descriptor reach nothing outside the daemon folders is removed', async () => {
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

  test('S49 a hard link is refused — a home file hard-linked into a root reads nothing', async () => {
    const { home, work } = await layout();
    await link(`${home}/state/gate/probe`, `${work}/hard`);
    const root = rootOf(home, 'work', { ferret: 'F1' as FerretId }, { work });
    expect(await attempt(root, 'hard')).toBe('refused:hard_link');
    await writeFile(`${work}/single`, 'one name');
    expect(await attempt(root, 'single')).toBe('one name');
  });

  test('S49 a hard link under a PROVEN immutable store is allowed; naming an ordinary folder grants nothing', async () => {
    const { parent, home } = await layout();
    const store = `${parent}/store`;
    await mkdir(`${store}/pkg`, { recursive: true });
    await writeFile(`${store}/pkg/a`, 'store file');
    await link(`${store}/pkg/a`, `${store}/pkg/b`);
    const imports = (disk: HostFs) =>
      rootOf(home, 'imports', { subfolder: `${store}/pkg` }, { fs: disk, hardLinkRoots: [store] });
    // An ordinary temp folder is this user's: not proven, so the hard link is refused.
    expect(await attempt(imports(fs), 'a')).toBe('refused:hard_link');
    // A disk that reports the store chain root-owned and closed (as a multi-user Nix store is).
    const closed: HostFs = {
      ...fs,
      identity: async path => {
        const real = await fs.identity(path);
        if (real === undefined || !(store.startsWith(path) || path.startsWith(store))) return real;
        return { ...real, owner: 0, group: 0, mode: real.kind === 'directory' ? 0o755 : 0o444 };
      },
      writable: async () => false,
      groups: async () => [1000],
    };
    expect(await attempt(imports(closed), 'a')).toBe('store file');
  });

  test('G57 a second boot on one home is refused naming `fy daemon adopt`, and the first daemon’s socket survives', async () => {
    const parent = await mkdtemp(`${tmpdir()}/fy-g57-`);
    parents.push(parent);
    const home = `${parent}/h`;
    const boot = async (listen?: () => Promise<never>) =>
      await bootHost({
        home,
        version: '5.0.0',
        implementations: [],
        adapters: realAdapters(home, () => {}, { binary: 'fy' }),
        listen:
          listen ??
          (async host =>
            await listenLocal(host, {
              home,
              port: 0,
              pid: process.pid,
              version: '5.0.0',
              write: (path, text) => writeFile(path, text, { mode: 0o600 }),
              chmod: (path, mode) => chmod(path, mode),
              remove: path => rm(path, { force: true }),
            })),
      });
    const first = await boot();
    if (first.kind !== 'running') throw new Error(first.sentence);
    running.push(first.host);
    const socket = runSocketPath(home);
    const before = (await Bun.file(socket).stat()).ino;
    const second = await boot();
    expect(second.kind).toBe('refused');
    if (second.kind === 'refused') {
      expect(second.sentence).toContain('`fy daemon adopt`');
      expect(second.trace).toEqual(['home', 'lock']);
    }
    expect((await Bun.file(socket).stat()).ino).toBe(before);
    const answer = await fetch('http://localhost/v1/kernel/plugins', { unix: socket } as RequestInit);
    // The first daemon still answers on its own socket (503: no plugin binds admission in this bare host).
    expect(answer.status).toBe(503);
    await first.host.stop();
    running.splice(0);
    // A boot that fails after the lock releases it, so the next one can claim the home.
    await expect(boot(async () => await Promise.reject(new Error('bind failed')))).rejects.toThrow('bind failed');
    const third = await boot();
    expect(third.kind).toBe('running');
    if (third.kind === 'running') running.push(third.host);
  });
});
