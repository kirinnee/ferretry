import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import type { RootName, RootsPort } from '../../../contract/ports.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { bootHost, type HostOptions, type RunningHost } from '../../../host/host.ts';
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
async function bootFresh(declared: Readonly<Record<string, readonly RootName[]>>) {
  const parent = await freshParent();
  const home = `${parent}/home`;
  const clock = fixedClock();
  const real = realAdapters(home, () => {}, { binary: 'fy' });
  const adapters: HostOptions['adapters'] = {
    ...real,
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
  return { parent, home, ports };
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

  test('S42 a base owned by someone other than the home owner is refused', async () => {
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
    const refused = await ensureInternalRootBases(fs, { home: f.home, plugin: 'codex' }, ['agent-homes']);
    expect(refused).toEqual([{ name: 'agent-homes', refusal: 'outside' }]);
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
