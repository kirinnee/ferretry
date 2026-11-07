import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import type { RootName, RootsPort } from '../../../contract/ports.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { bootHost, type HostOptions, type RunningHost } from '../../../host/host.ts';
import type { LogRecord } from '../../../host/log.ts';
import { openHome } from '../../../host/home.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { realAdapters, stateOpener } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { silentLog } from './fixtures.ts';

const parents: string[] = [];
const hosts: RunningHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

async function freshParent(): Promise<string> {
  const parent = await mkdtemp(`${tmpdir()}/root-bases-`);
  parents.push(parent);
  return parent;
}

const modeOf = async (path: string): Promise<number> => (await lstat(path)).mode & 0o777;
const resolved = (root: ReturnType<RootsPort['root']>, path: string): FencedPath => {
  const answer = root.resolve(path);
  if (!answer.ok) throw new Error(answer.error);
  return answer.value;
};

const base = { version: '5.0.0', api: 5, core: false, kinds: [] } as const;

/** A real boot on a brand-new, missing FY_HOME: each plugin declares roots and keeps its roots port. */
async function bootFresh(
  declared: Readonly<Record<string, readonly RootName[]>>,
  options: { readonly prepare?: (paths: { home: string; parent: string }) => Promise<void> } = {},
) {
  const parent = await freshParent();
  const home = `${parent}/home`;
  await options.prepare?.({ home, parent });
  const records: LogRecord[] = [];
  const clock = fixedClock();
  const real = realAdapters(home, () => {}, { binary: 'fy' });
  const adapters: HostOptions['adapters'] = {
    ...real,
    logSink: record => records.push(record),
    clock,
    homeLock: async () => ({ release: async () => {} }),
    state: stateOpener(home, createMemoryHostFs(), clock, silentLog),
  };
  const ports = new Map<string, RootsPort>();
  const implementations = Object.entries(declared).map(([id, roots]) =>
    implementDaemon(definePlugin({ ...base, id, title: id, permissions: { roots: [...roots] } }), {
      build: ctx => {
        ports.set(id, ctx.kernel.roots);
        return {};
      },
    }),
  );
  const result = await bootHost({ home, version: '5.0.0', implementations, adapters });
  if (result.kind !== 'running') throw new Error(result.sentence);
  hosts.push(result.host);
  return { parent, home, ports, records };
}

/** A home a first start already set up, private, with its `state` folder: what a second boot finds. */
async function plantHome(home: string): Promise<void> {
  const opened = await openHome(
    nodeFs(() => crypto.randomUUID()),
    home,
    'fixture',
    fixedClock().now(),
  );
  if (opened.kind !== 'ready') throw new Error('the fixture home was refused');
}

describe('S42 every declared internal root base exists on a fresh FY_HOME before plugin code asks for it', () => {
  test('S42 boot makes agent-homes, downloads and credentials bases 0700 and each plugin opens its root', async () => {
    const f = await bootFresh({
      'claude-code': ['agent-homes', 'harness-history'],
      codex: ['agent-homes'],
      terminals: ['downloads'],
      logins: ['credentials'],
    });
    for (const base of [
      'state/claude-code/agent-homes',
      'state/codex/agent-homes',
      'state/terminals/downloads',
      'state/logins/credentials',
    ]) {
      expect((await lstat(`${f.home}/${base}`)).isDirectory()).toBe(true);
      expect(await modeOf(`${f.home}/${base}`)).toBe(0o700);
    }
    expect(await modeOf(`${f.home}/state/claude-code`)).toBe(0o700);

    // The first ferret launch: a scoped agent home below the base, made on first write.
    const agentHome = f.ports.get('claude-code')?.root('agent-homes', { subfolder: 'ferret-1' });
    if (agentHome === undefined) throw new Error('claude-code was not built');
    await agentHome.writeText(resolved(agentHome, 'settings.json'), '{"fixture":true}');
    expect(await readFile(`${f.home}/state/claude-code/agent-homes/ferret-1/settings.json`, 'utf8')).toBe(
      '{"fixture":true}',
    );
    expect(await modeOf(`${f.home}/state/claude-code/agent-homes/ferret-1`)).toBe(0o700);

    const codexHome = f.ports.get('codex')?.root('agent-homes', { subfolder: 'ferret-2' });
    if (codexHome === undefined) throw new Error('codex was not built');
    await codexHome.ensurePrivateDirectory(resolved(codexHome, 'sessions'));
    expect(await modeOf(`${f.home}/state/codex/agent-homes/ferret-2/sessions`)).toBe(0o700);

    // The logins credentials root: its private store directory opens with no setup step.
    const credentials = f.ports.get('logins')?.root('credentials');
    if (credentials === undefined) throw new Error('logins was not built');
    await credentials.ensurePrivateDirectory(resolved(credentials, 'store'));
    expect(await modeOf(`${f.home}/state/logins/credentials/store`)).toBe(0o700);

    const downloads = f.ports.get('terminals')?.root('downloads');
    if (downloads === undefined) throw new Error('terminals was not built');
    expect(await downloads.list(resolved(downloads, ''))).toEqual([]);
  });

  test('S42 boot makes only declared internal bases: no owner root, no worktrees, no credentials for another plugin', async () => {
    const f = await bootFresh({ intruder: ['credentials', 'worktrees', 'work', 'imports'] });
    expect(await readdir(`${f.home}/state`).then(names => names.includes('intruder'))).toBe(false);
    expect(await readdir(f.parent)).toEqual(['home']);
  });
});

describe('S42 an existing base that is not a private folder of the home is refused, never followed or replaced', () => {
  async function home() {
    const parent = await freshParent();
    const homePath = `${parent}/home`;
    const outside = `${parent}/outside`;
    await mkdir(`${homePath}/state`, { recursive: true, mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    return { home: homePath, outside, fs: nodeFs(() => crypto.randomUUID()) };
  }

  test('S42 a base that is a symlink to a folder outside the home is refused and left as a link', async () => {
    const f = await home();
    await mkdir(`${f.home}/state/claude-code`, { mode: 0o700 });
    await symlink(f.outside, `${f.home}/state/claude-code/agent-homes`);
    const refused = await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'claude-code' }, ['agent-homes']);
    expect(refused).toEqual([{ name: 'agent-homes', refusal: 'link_escape' }]);
    expect((await lstat(`${f.home}/state/claude-code/agent-homes`)).isSymbolicLink()).toBe(true);
    expect(await readdir(f.outside)).toEqual([]);
  });

  test('S42 a plugin state folder that is a symlink is refused and nothing is made through it', async () => {
    const f = await home();
    await symlink(f.outside, `${f.home}/state/logins`);
    const refused = await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'logins' }, ['credentials']);
    expect(refused).toEqual([{ name: 'credentials', refusal: 'link_escape' }]);
    expect(await readdir(f.outside)).toEqual([]);
    expect((await lstat(`${f.home}/state/logins`)).isSymbolicLink()).toBe(true);
  });

  test('S42 a base that is a file is refused and the file is kept as it was', async () => {
    const f = await home();
    await mkdir(`${f.home}/state/terminals`, { mode: 0o700 });
    await writeFile(`${f.home}/state/terminals/downloads`, 'fixture-file');
    const refused = await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'terminals' }, ['downloads']);
    expect(refused).toEqual([{ name: 'downloads', refusal: 'not_a_file' }]);
    expect(await readFile(`${f.home}/state/terminals/downloads`, 'utf8')).toBe('fixture-file');
  });

  test('S42 a base owned by someone other than the home owner is not claimed as refused: only what every later use refuses is', async () => {
    const f = await home();
    await mkdir(`${f.home}/state/codex/agent-homes`, { recursive: true, mode: 0o700 });
    const real = f.fs;
    const fs = {
      ...real,
      identity: async (path: string) => {
        const found = await real.identity(path);
        return path.endsWith('/agent-homes') && found !== undefined ? { ...found, owner: found.owner + 1 } : found;
      },
    };
    expect(await ensureInternalRootBases(fs, { home: f.home, plugin: 'codex' }, ['agent-homes'])).toEqual([]);
  });

  test('S42 a refused base still refuses every use of the root afterwards', async () => {
    const f = await home();
    await mkdir(`${f.home}/state/claude-code`, { mode: 0o700 });
    await symlink(f.outside, `${f.home}/state/claude-code/agent-homes`);
    await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'claude-code' }, ['agent-homes']);
    const root = rootsPortFor(
      f.fs,
      { home: f.home, plugin: 'claude-code', worktrees: `${f.home}-worktrees` },
      ['agent-homes'],
      () => undefined,
    ).root('agent-homes', { subfolder: 'ferret-1' });
    await expect(root.writeText(resolved(root, 'memory.md'), 'must-not-land')).rejects.toEqual(
      new RootError('link_escape'),
    );
    expect(await readdir(f.outside)).toEqual([]);
  });

  test('S42 an existing private base is accepted as is and nothing else is made', async () => {
    const f = await home();
    await mkdir(`${f.home}/state/logins/credentials`, { recursive: true, mode: 0o700 });
    await writeFile(`${f.home}/state/logins/credentials/kept`, 'fixture');
    const refused = await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'logins' }, ['credentials']);
    expect(refused).toEqual([]);
    expect(await readdir(`${f.home}/state/logins/credentials`)).toEqual(['kept']);
  });
});

describe('S42 a base the kernel will not make or accept never stops the boot and never reaches the log as a path', () => {
  const refusalWarns = (records: readonly LogRecord[]) =>
    records.filter(record => record.message === 'a root base was refused and left as it is');

  test('S42 boot with a planted symlink base keeps running, builds the plugin, logs plugin/root/refusal only, and makes the others', async () => {
    let outside = '';
    const f = await bootFresh(
      { 'claude-code': ['agent-homes'], codex: ['agent-homes'] },
      {
        prepare: async ({ home, parent }) => {
          outside = `${parent}/outside`;
          await mkdir(outside, { mode: 0o700 });
          await plantHome(home);
          await mkdir(`${home}/state/claude-code`, { mode: 0o700 });
          await symlink(outside, `${home}/state/claude-code/agent-homes`);
        },
      },
    );
    expect(f.ports.has('claude-code')).toBe(true);
    expect(f.ports.has('codex')).toBe(true);
    expect(refusalWarns(f.records).map(record => record.fields)).toEqual([
      { plugin: 'claude-code', root: 'agent-homes', refusal: 'link_escape' },
    ]);
    expect(JSON.stringify(f.records)).not.toContain(f.parent);
    expect((await lstat(`${f.home}/state/claude-code/agent-homes`)).isSymbolicLink()).toBe(true);
    expect((await lstat(`${f.home}/state/codex/agent-homes`)).isDirectory()).toBe(true);
    const root = f.ports.get('claude-code')?.root('agent-homes', { subfolder: 'ferret-1' });
    if (root === undefined) throw new Error('claude-code was not built');
    await expect(root.writeText(resolved(root, 'memory.md'), 'must-not-land')).rejects.toEqual(
      new RootError('link_escape'),
    );
    expect(await readdir(outside)).toEqual([]);
  });

  test('S42 boot with an unreadable state folder keeps running, builds that plugin, refuses its root, and still makes another plugin base', async () => {
    // Mode 000 does not stop root: the disk state this proves is not reachable there.
    if (process.getuid?.() === 0) return;
    let locked = '';
    try {
      const f = await bootFresh(
        { codex: ['agent-homes'], zeta: ['agent-homes'] },
        {
          prepare: async ({ home }) => {
            await plantHome(home);
            locked = `${home}/state/codex`;
            await mkdir(locked, { mode: 0o700 });
            await chmod(locked, 0o000);
          },
        },
      );
      expect(f.ports.has('codex')).toBe(true);
      expect(f.ports.has('zeta')).toBe(true);
      expect(refusalWarns(f.records).map(record => record.fields)).toEqual([
        { plugin: 'codex', root: 'agent-homes', refusal: 'changed', code: 'EACCES' },
      ]);
      expect(JSON.stringify(f.records)).not.toContain(f.parent);
      expect((await lstat(`${f.home}/state/zeta/agent-homes`)).isDirectory()).toBe(true);
      const root = f.ports.get('codex')?.root('agent-homes', { subfolder: 'ferret-1' });
      if (root === undefined) throw new Error('codex was not built');
      await expect(root.writeText(resolved(root, 'memory.md'), 'must-not-land')).rejects.toThrow();
    } finally {
      if (locked !== '') await chmod(locked, 0o700).catch(() => undefined);
    }
  });
});

describe('S42 every refusal the boot makes is still a refusal of every later use of that root', () => {
  async function home() {
    const parent = await freshParent();
    const homePath = `${parent}/home`;
    const outside = `${parent}/outside`;
    await mkdir(`${homePath}/state`, { recursive: true, mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    const fs = nodeFs(() => crypto.randomUUID());
    const roots = (plugin: string, declared: readonly RootName[]) =>
      rootsPortFor(fs, { home: homePath, plugin, worktrees: `${homePath}-worktrees` }, declared, () => undefined);
    return { home: homePath, outside, fs, roots };
  }

  test('S42 a base that is a file is refused at boot and every later write into the root is refused', async () => {
    const f = await home();
    await mkdir(`${f.home}/state/terminals`, { mode: 0o700 });
    await writeFile(`${f.home}/state/terminals/downloads`, 'fixture-file');
    expect(await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'terminals' }, ['downloads'])).toEqual([
      { name: 'downloads', refusal: 'not_a_file' },
    ]);
    const root = f.roots('terminals', ['downloads']).root('downloads');
    // The base is not a folder, so the use itself fails on the disk; nothing is made or replaced.
    await expect(root.writeText(resolved(root, 'a.txt'), 'must-not-land')).rejects.toThrow();
    expect(await readFile(`${f.home}/state/terminals/downloads`, 'utf8')).toBe('fixture-file');
  });

  test('S42 a linked base is refused at boot and every later write into the root is refused', async () => {
    const f = await home();
    await mkdir(`${f.home}/state/terminals`, { mode: 0o700 });
    await symlink(f.outside, `${f.home}/state/terminals/downloads`);
    expect(await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'terminals' }, ['downloads'])).toEqual([
      { name: 'downloads', refusal: 'link_escape' },
    ]);
    const root = f.roots('terminals', ['downloads']).root('downloads');
    await expect(root.writeText(resolved(root, 'a.txt'), 'must-not-land')).rejects.toEqual(
      new RootError('link_escape'),
    );
    expect(await readdir(f.outside)).toEqual([]);
  });

  test('S42 a linked state folder is refused at boot and every later write into the root is refused', async () => {
    const f = await home();
    await symlink(f.outside, `${f.home}/state/logins`);
    expect(await ensureInternalRootBases(f.fs, { home: f.home, plugin: 'logins' }, ['credentials'])).toEqual([
      { name: 'credentials', refusal: 'link_escape' },
    ]);
    const root = f.roots('logins', ['credentials']).root('credentials');
    await expect(root.ensurePrivateDirectory(resolved(root, 'store'))).rejects.toBeInstanceOf(RootError);
    await expect(root.writeText(resolved(root, 'a.txt'), 'must-not-land')).rejects.toBeInstanceOf(RootError);
    expect(await readdir(f.outside)).toEqual([]);
  });
});

describe('S42 the bases are 0700 exactly, whatever the umask, through the descriptor that was checked', () => {
  async function withUmask<T>(mask: number, use: () => Promise<T>): Promise<T> {
    const before = process.umask(mask);
    try {
      return await use();
    } finally {
      process.umask(before);
    }
  }

  test('S42 a restrictive umask still gives every new folder from state/<plugin> down to the base mode 0700', async () => {
    const parent = await freshParent();
    const home = `${parent}/home`;
    await mkdir(`${home}/state`, { recursive: true, mode: 0o700 });
    const refused = await withUmask(0o277, () =>
      ensureInternalRootBases(
        nodeFs(() => crypto.randomUUID()),
        { home, plugin: 'codex' },
        ['agent-homes'],
      ),
    );
    expect(refused).toEqual([]);
    expect(await modeOf(`${home}/state/codex`)).toBe(0o700);
    expect(await modeOf(`${home}/state/codex/agent-homes`)).toBe(0o700);
  });

  test('S42 an existing checked base at a wider mode is held to 0700, not replaced', async () => {
    const parent = await freshParent();
    const home = `${parent}/home`;
    await mkdir(`${home}/state/logins/credentials`, { recursive: true, mode: 0o700 });
    await writeFile(`${home}/state/logins/credentials/kept`, 'fixture');
    await chmod(`${home}/state/logins/credentials`, 0o755);
    const before = await lstat(`${home}/state/logins/credentials`);
    const refused = await ensureInternalRootBases(
      nodeFs(() => crypto.randomUUID()),
      { home, plugin: 'logins' },
      ['credentials'],
    );
    expect(refused).toEqual([]);
    expect(await modeOf(`${home}/state/logins/credentials`)).toBe(0o700);
    expect((await lstat(`${home}/state/logins/credentials`)).ino).toBe(before.ino);
    expect(await readdir(`${home}/state/logins/credentials`)).toEqual(['kept']);
  });
});

describe('S41 a link swapped in at state/<plugin> between the boot walk and the creation is refused', () => {
  test('S41 state/<plugin> turned into a link after the walk is refused link_escape and nothing lands outside the home', async () => {
    const parent = await freshParent();
    const home = `${parent}/home`;
    const outside = `${parent}/outside`;
    await mkdir(`${home}/state/logins`, { recursive: true, mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    const real = nodeFs(() => crypto.randomUUID());
    let swapped = false;
    // The boot walk reads identities only; the first lstat is the creation step starting.
    const fs = {
      ...real,
      lstat: async (path: string) => {
        if (!swapped) {
          swapped = true;
          await rm(`${home}/state/logins`, { recursive: true });
          await symlink(outside, `${home}/state/logins`);
        }
        return real.lstat(path);
      },
    };
    const refused = await ensureInternalRootBases(fs, { home, plugin: 'logins' }, ['credentials']);
    expect(swapped).toBe(true);
    expect(refused).toEqual([{ name: 'credentials', refusal: 'link_escape' }]);
    expect(await readdir(outside)).toEqual([]);
    expect((await lstat(`${home}/state/logins`)).isSymbolicLink()).toBe(true);
  });
});
