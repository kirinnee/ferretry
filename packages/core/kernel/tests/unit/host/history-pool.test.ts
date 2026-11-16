/**
 * The history-pool door: `RootHandle.linkHistory` makes `<one ferret home>/<entry>` a symlink to the SAME entry of ONE
 * pool the harness plugin owns (`state/<plugin>/history-pool/<entry>`). On the real roots port and a real disk. Who may
 * link, which names, which homes, which pool, what may already be at the name, what the kernel makes on first use, that
 * a link is proved before it stays, and that no other door (`linkTo`, `copyTree`, `linkCredential`) is widened.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { err } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import { defineState, type StateFileDef } from '../../../contract/define.ts';
import type { RootHandle, RootName, RootsPort } from '../../../contract/ports.ts';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { HistoryPoolError, historyEntryFor, isFerretHome, poolCredentialVerdict } from '../../../host/history-pool.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';
import { credentialHomeLinkVerdict } from '../../../host/shared-credentials.ts';
import {
  declaredHistoryEntry,
  HISTORY_POOL_DENIED_NAMES,
  historyPoolFault,
  historyPoolNameRefusal,
  poolStateFolder,
} from '../../../manifest/history-pool.ts';
import { definePlugin, reachFaults } from '../../../manifest/index.ts';
import type { HistoryPoolPermission } from '../../../manifest/types.ts';

const POOL = defineState({ name: 'pool', path: 'history-pool/*', store: 'opaque', format: 1 });
const CREDENTIALS = defineState({ name: 'credentials', path: 'credentials/*', store: 'opaque', format: 1 });

/** Claude Code's declaration (the fixed list the harness plugin will make). */
const CLAUDE: HistoryPoolPermission = {
  state: 'pool',
  entries: [
    ...[
      'projects',
      'sessions',
      'session-env',
      'file-history',
      'plans',
      'tasks',
      'todos',
      'shell-snapshots',
      'paste-cache',
    ].map(name => ({ name, kind: 'folder' as const })),
    { name: 'history.jsonl', kind: 'file' as const },
  ],
};

const parents: string[] = [];
afterEach(async () => {
  hook.beforeSymlink = undefined;
  hook.symlinkTo = undefined;
  hook.noReach = false;
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const baseFs = nodeFs(() => crypto.randomUUID());
/** Test seams on the disk: a step run just before the symlink is made, a different target, a host with no descriptor path. */
const hook: {
  beforeSymlink: undefined | ((path: string) => Promise<void>);
  symlinkTo: undefined | ((target: string) => string);
  noReach: boolean;
} = { beforeSymlink: undefined, symlinkTo: undefined, noReach: false };
const fs: HostFs = {
  ...baseFs,
  symlink: async (target, path) => {
    await hook.beforeSymlink?.(path);
    await baseFs.symlink(hook.symlinkTo?.(target) ?? target, path);
  },
  openDirectory: async path => {
    const folder = await baseFs.openDirectory(path);
    return hook.noReach ? { ...folder, entryPath: () => undefined, at: undefined } : folder;
  },
};

interface PortOptions {
  readonly historyPool?: HistoryPoolPermission | undefined;
  readonly stateFiles?: readonly StateFileDef[];
  readonly privateFiles?: readonly string[];
  readonly shareCredentials?: readonly string[];
}

async function world() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-history-pool-`));
  parents.push(parent);
  const home = `${parent}/home`;
  await mkdir(`${home}/state/logins/credentials/work`, { recursive: true, mode: 0o700 });
  await writeFile(`${home}/state/logins/credentials/work/auth.json`, '{"fake":"tokens"}\n', { mode: 0o600 });
  await ensureInternalRootBases(fs, { home, plugin: 'logins' }, ['credentials']);
  for (const plugin of ['claude-code', 'codex', 'other'])
    await ensureInternalRootBases(fs, { home, plugin }, ['agent-homes', 'downloads']);
  const workFolders: WorkFolders = { folderOf: () => undefined, check: () => err('outside') };
  const port = (plugin: string, declared: readonly RootName[], options: PortOptions = {}): RootsPort =>
    rootsPortFor(fs, { home, plugin, worktrees: `${home}-worktrees` }, declared, () => workFolders, {
      ...('historyPool' in options
        ? options.historyPool === undefined
          ? {}
          : { historyPool: options.historyPool }
        : { historyPool: CLAUDE }),
      ...(options.shareCredentials === undefined ? {} : { shareCredentials: options.shareCredentials }),
      stateFiles: options.stateFiles ?? [POOL, CREDENTIALS],
      privateFiles: options.privateFiles ?? [],
    });
  const claude = port('claude-code', ['agent-homes', 'downloads']);
  const all = claude.root('agent-homes');
  const homePath = (ferret: string) => `${home}/state/claude-code/agent-homes/${ferret}`;
  const poolPath = `${home}/state/claude-code/history-pool`;
  const makeHome = async (ferret: string) => {
    await mkdir(homePath(ferret), { recursive: true, mode: 0o700 });
    await writeFile(`${homePath(ferret)}/.claude.json`, '{}', { mode: 0o600 });
  };
  return { parent, home, port, claude, all, homePath, poolPath, makeHome };
}
type World = Awaited<ReturnType<typeof world>>;

const resolved = (root: RootHandle, path: string): FencedPath => {
  const answer = root.resolve(path);
  if (!answer.ok) throw new Error(answer.error);
  return answer.value;
};

/** What a call came to: the door's refusal, `root:<refusal>`, or `ok`. */
async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    if (error instanceof HistoryPoolError) return error.refusal;
    if (error instanceof RootError) return `root:${error.refusal}`;
    throw error;
  }
}

const link = async (w: World, ferret: string, entry: string, handle: RootHandle = w.all): Promise<string> =>
  await refusalOf(handle.linkHistory(resolved(handle, ferret), entry));

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;
const exists = async (path: string): Promise<boolean> => (await lstat(path).catch(() => undefined)) !== undefined;

describe('RootHandle.linkHistory: the link', () => {
  test('1: a folder entry is a symlink to the real path of the pool entry, made 0700 on first use', async () => {
    const w = await world();
    await w.makeHome('f1');
    expect(await link(w, 'f1', 'projects')).toBe('ok');
    const at = `${w.homePath('f1')}/projects`;
    expect((await lstat(at)).isSymbolicLink()).toBe(true);
    expect(await readlink(at)).toBe(`${await realpath(w.poolPath)}/projects`);
    expect(await realpath(at)).toBe(`${await realpath(w.poolPath)}/projects`);
    expect(await modeOf(w.poolPath)).toBe(0o700);
    expect(await modeOf(`${w.poolPath}/projects`)).toBe(0o700);
  });

  test('2: a file entry is a symlink to an empty 0600 file, made on first use', async () => {
    const w = await world();
    await w.makeHome('f1');
    expect(await link(w, 'f1', 'history.jsonl')).toBe('ok');
    expect(await readlink(`${w.homePath('f1')}/history.jsonl`)).toBe(`${await realpath(w.poolPath)}/history.jsonl`);
    expect((await lstat(`${w.poolPath}/history.jsonl`)).isFile()).toBe(true);
    expect(await modeOf(`${w.poolPath}/history.jsonl`)).toBe(0o600);
    expect(await readFile(`${w.poolPath}/history.jsonl`, 'utf8')).toBe('');
  });

  test('3: two ferrets share one pool: a conversation written through one is read through the other', async () => {
    const w = await world();
    await w.makeHome('f1');
    await w.makeHome('f2');
    expect(await link(w, 'f1', 'projects')).toBe('ok');
    expect(await link(w, 'f2', 'projects')).toBe('ok');
    await mkdir(`${w.homePath('f1')}/projects/-work`, { recursive: true });
    await writeFile(`${w.homePath('f1')}/projects/-work/abc.jsonl`, '{"turn":1}\n');
    expect(await readFile(`${w.homePath('f2')}/projects/-work/abc.jsonl`, 'utf8')).toBe('{"turn":1}\n');
  });

  test('4: a pool entry that already holds history is kept exactly as it is', async () => {
    const w = await world();
    await w.makeHome('f1');
    await mkdir(`${w.poolPath}/projects/-work`, { recursive: true, mode: 0o700 });
    await writeFile(`${w.poolPath}/projects/-work/old.jsonl`, 'kept');
    await writeFile(`${w.poolPath}/history.jsonl`, 'kept too', { mode: 0o600 });
    expect(await link(w, 'f1', 'projects')).toBe('ok');
    expect(await link(w, 'f1', 'history.jsonl')).toBe('ok');
    expect(await readFile(`${w.homePath('f1')}/projects/-work/old.jsonl`, 'utf8')).toBe('kept');
    expect(await readFile(`${w.homePath('f1')}/history.jsonl`, 'utf8')).toBe('kept too');
  });

  test('5: a handle scoped to one ferret home links its own home, the way a harness is scoped', async () => {
    const w = await world();
    await w.makeHome('f1');
    const own = w.claude.root('agent-homes', { subfolder: 'f1' });
    expect(await refusalOf(own.linkHistory(resolved(own, ''), 'projects'))).toBe('ok');
    expect((await lstat(`${w.homePath('f1')}/projects`)).isSymbolicLink()).toBe(true);
  });

  test('6: every one of the harness lists links, and a second ferret with the same list reaches the same entries', async () => {
    const w = await world();
    await w.makeHome('f1');
    await w.makeHome('f2');
    for (const decl of CLAUDE.entries) {
      expect(await link(w, 'f1', decl.name)).toBe('ok');
      expect(await link(w, 'f2', decl.name)).toBe('ok');
      expect(await readlink(`${w.homePath('f2')}/${decl.name}`)).toBe(
        await readlink(`${w.homePath('f1')}/${decl.name}`),
      );
    }
  });

  test('7: the same entry linked at once for one home makes one link and refuses the rest', async () => {
    const w = await world();
    await w.makeHome('f1');
    const answers = await Promise.all(Array.from({ length: 6 }, () => link(w, 'f1', 'projects')));
    expect(answers.filter(answer => answer === 'ok')).toHaveLength(1);
    expect(answers.filter(answer => answer === 'exists')).toHaveLength(5);
  });

  test('8: many homes linked at once all reach the one pool entry', async () => {
    const w = await world();
    const ferrets = Array.from({ length: 8 }, (_, at) => `f${String(at)}`);
    for (const ferret of ferrets) await w.makeHome(ferret);
    const answers = await Promise.all(ferrets.map(ferret => link(w, ferret, 'sessions')));
    expect(answers.every(answer => answer === 'ok')).toBe(true);
    const targets = await Promise.all(ferrets.map(ferret => readlink(`${w.homePath(ferret)}/sessions`)));
    expect(new Set(targets).size).toBe(1);
  });
});

describe('RootHandle.linkHistory: the permission and the entry', () => {
  test('9: a plugin whose manifest lacks permissions.historyPool is refused not_permitted, and nothing is written', async () => {
    const w = await world();
    await w.makeHome('f1');
    const bare = w.port('claude-code', ['agent-homes'], { historyPool: undefined }).root('agent-homes');
    expect(await refusalOf(bare.linkHistory(resolved(bare, 'f1'), 'projects'))).toBe('not_permitted');
    expect(await exists(w.poolPath)).toBe(false);
    expect(await exists(`${w.homePath('f1')}/projects`)).toBe(false);
  });

  test('10: a name on the fixed deny list is refused denied even when the manifest declares it', async () => {
    const w = await world();
    await w.makeHome('f1');
    const names = [
      '.credentials.json',
      '.claude.json',
      '.anything',
      'settings.json',
      'settings.local.json',
      'settings-team.json',
      'SETTINGS.JSON',
      'auth.json',
      'config.toml',
      'CLAUDE.md',
      'claude.md',
      'AGENTS.md',
      'skills',
      'Skills',
      'plugins',
      'a/b',
      '/etc',
      '..',
      '.',
      '',
      'a\0b',
      'oauth-cache',
      'token.txt',
    ];
    const lax = w.port('claude-code', ['agent-homes'], {
      historyPool: { state: 'pool', entries: names.map(name => ({ name, kind: 'folder' as const })) },
    });
    const handle = lax.root('agent-homes');
    for (const name of names) expect(await refusalOf(handle.linkHistory(resolved(handle, 'f1'), name))).toBe('denied');
    expect(await refusalOf(handle.linkHistory(resolved(handle, 'f1'), 7 as unknown as string))).toBe('denied');
    expect(await exists(w.poolPath)).toBe(false);
    expect([...(await w.all.list(resolved(w.all, 'f1')))].sort()).toEqual(['.claude.json']);
  });

  test('11: a legal name the closed list does not name is refused not_listed (exact, case-sensitive)', async () => {
    const w = await world();
    await w.makeHome('f1');
    for (const name of ['statsig', 'Projects', 'projects ', 'projects.bak', 'history.jsonl2'])
      expect(await link(w, 'f1', name)).toBe(name.includes(' ') ? 'denied' : 'not_listed');
    expect(await exists(w.poolPath)).toBe(false);
  });

  test('12: the closed list is checked before the disk: an undeclared name does not even look at the home', async () => {
    const w = await world();
    expect(await link(w, 'nobody', 'todos2')).toBe('not_listed');
  });

  test('13: a handle on any root but agent-homes is refused not_internal', async () => {
    const w = await world();
    await w.makeHome('f1');
    const downloads = w.claude.root('downloads');
    expect(await refusalOf(downloads.linkHistory(resolved(downloads, 'f1'), 'projects'))).toBe('not_internal');
    expect(await exists(w.poolPath)).toBe(false);
  });
});

describe('RootHandle.linkHistory: the home', () => {
  test('14: only exactly one ferret home at the top of agent-homes is a home', async () => {
    const w = await world();
    await w.makeHome('f1');
    await mkdir(`${w.homePath('f1')}/sub`, { recursive: true });
    expect(await link(w, '', 'projects')).toBe('not_home');
    expect(await link(w, 'f1/sub', 'projects')).toBe('not_home');
    const nested = w.claude.root('agent-homes', { subfolder: 'f1/sub' });
    expect(await refusalOf(nested.linkHistory(resolved(nested, ''), 'projects'))).toBe('not_home');
    expect(await exists(w.poolPath)).toBe(false);
    expect(await exists(`${w.homePath('f1')}/sub/projects`)).toBe(false);
  });

  test('15: a path outside the root is refused outside', async () => {
    const w = await world();
    expect(await refusalOf(w.all.linkHistory('/etc' as FencedPath, 'projects'))).toBe('root:outside');
    expect(await refusalOf(w.all.linkHistory('../x' as FencedPath, 'projects'))).toBe('root:outside');
    expect(await exists(w.poolPath)).toBe(false);
  });

  test('16: a home that is not there is refused outside, and this call makes none', async () => {
    const w = await world();
    expect(await link(w, 'nobody', 'projects')).toBe('root:outside');
    expect(await exists(w.homePath('nobody'))).toBe(false);
    expect(await exists(w.poolPath)).toBe(false);
  });

  test('17: a home that is itself a link is refused link_escape and nothing is written through it', async () => {
    const w = await world();
    await mkdir(`${w.parent}/outside`, { recursive: true });
    await symlink(`${w.parent}/outside`, w.homePath('f9'));
    expect(await link(w, 'f9', 'projects')).toBe('root:link_escape');
    expect(await exists(`${w.parent}/outside/projects`)).toBe(false);
    expect(await exists(w.poolPath)).toBe(false);
  });

  test('18: the agent-homes folder itself being a link makes every call link_escape-or-outside, never a link', async () => {
    const w = await world();
    await w.makeHome('f1');
    await rm(`${w.home}/state/claude-code/agent-homes`, { recursive: true });
    await mkdir(`${w.parent}/elsewhere/f1`, { recursive: true });
    await symlink(`${w.parent}/elsewhere`, `${w.home}/state/claude-code/agent-homes`);
    const answer = await refusalOf(w.claude.root('agent-homes').linkHistory('x' as FencedPath, 'projects'));
    expect(['root:outside', 'root:link_escape']).toContain(answer);
    expect(await exists(`${w.parent}/elsewhere/f1/projects`)).toBe(false);
  });
});

describe('RootHandle.linkHistory: what may already be there', () => {
  test('19: a real folder, a file or a link at the name is refused exists, left as it was, and the pool is not made', async () => {
    const w = await world();
    await w.makeHome('f1');
    await mkdir(`${w.homePath('f1')}/projects/-w`, { recursive: true });
    await writeFile(`${w.homePath('f1')}/projects/-w/x.jsonl`, 'mine');
    await writeFile(`${w.homePath('f1')}/history.jsonl`, 'mine');
    await symlink('/nowhere', `${w.homePath('f1')}/sessions`);
    expect(await link(w, 'f1', 'projects')).toBe('exists');
    expect(await link(w, 'f1', 'history.jsonl')).toBe('exists');
    expect(await link(w, 'f1', 'sessions')).toBe('exists');
    expect(await readFile(`${w.homePath('f1')}/projects/-w/x.jsonl`, 'utf8')).toBe('mine');
    expect(await readFile(`${w.homePath('f1')}/history.jsonl`, 'utf8')).toBe('mine');
    expect(await readlink(`${w.homePath('f1')}/sessions`)).toBe('/nowhere');
    expect(await exists(w.poolPath)).toBe(false);
  });

  test('20: a second link of the same entry is exists, never an overwrite or a re-point', async () => {
    const w = await world();
    await w.makeHome('f1');
    expect(await link(w, 'f1', 'projects')).toBe('ok');
    const before = await readlink(`${w.homePath('f1')}/projects`);
    expect(await link(w, 'f1', 'projects')).toBe('exists');
    expect(await readlink(`${w.homePath('f1')}/projects`)).toBe(before);
  });

  test('21: the caller moves a real folder aside with rename, then the link is made', async () => {
    const w = await world();
    await w.makeHome('f1');
    await mkdir(`${w.homePath('f1')}/projects/-w`, { recursive: true });
    await writeFile(`${w.homePath('f1')}/projects/-w/x.jsonl`, 'mine');
    expect(await link(w, 'f1', 'projects')).toBe('exists');
    await w.all.rename(resolved(w.all, 'f1/projects'), resolved(w.all, 'f1/projects.aside'));
    expect(await link(w, 'f1', 'projects')).toBe('ok');
    expect(await readFile(`${w.homePath('f1')}/projects.aside/-w/x.jsonl`, 'utf8')).toBe('mine');
  });

  test('22: a name that appears between the look and the symlink is exists, and what appeared is untouched', async () => {
    const w = await world();
    await w.makeHome('f1');
    hook.beforeSymlink = async path => {
      await mkdir(path);
      await writeFile(`${path}/theirs`, 'theirs');
    };
    expect(await link(w, 'f1', 'projects')).toBe('exists');
    expect(await readFile(`${w.homePath('f1')}/projects/theirs`, 'utf8')).toBe('theirs');
    expect((await lstat(`${w.homePath('f1')}/projects`)).isDirectory()).toBe(true);
  });

  test('23: a link that does not land on the pool entry is taken back and refused changed', async () => {
    const w = await world();
    await w.makeHome('f1');
    await mkdir(`${w.parent}/elsewhere`, { recursive: true });
    hook.symlinkTo = () => `${w.parent}/elsewhere`;
    expect(await link(w, 'f1', 'projects')).toBe('root:changed');
    expect(await exists(`${w.homePath('f1')}/projects`)).toBe(false);
  });

  test('24: a host that reaches an open folder by no descriptor path refuses no_descriptor_reach before anything is made', async () => {
    const w = await world();
    await w.makeHome('f1');
    hook.noReach = true;
    expect(await link(w, 'f1', 'projects')).toBe('root:no_descriptor_reach');
    expect(await exists(`${w.homePath('f1')}/projects`)).toBe(false);
    expect(await exists(w.poolPath)).toBe(false);
  });
});

describe('RootHandle.linkHistory: the pool is the caller’s own', () => {
  test('25: a permission whose state names no def of the plugin is refused not_own', async () => {
    const w = await world();
    await w.makeHome('f1');
    const port = w.port('claude-code', ['agent-homes'], { stateFiles: [CREDENTIALS] }).root('agent-homes');
    expect(await refusalOf(port.linkHistory(resolved(port, 'f1'), 'projects'))).toBe('not_own');
    expect(await exists(w.poolPath)).toBe(false);
  });

  test('26: a state def that is not an opaque <folder>/* tree is refused not_own', async () => {
    const w = await world();
    await w.makeHome('f1');
    for (const def of [
      defineState({ name: 'pool', path: 'history-pool/*', store: 'json', format: 1 }),
      defineState({ name: 'pool', path: 'history-pool/index', store: 'opaque', format: 1 }),
      defineState({ name: 'pool', path: 'deep/history-pool/*', store: 'opaque', format: 1 }),
    ]) {
      const port = w.port('claude-code', ['agent-homes'], { stateFiles: [def] }).root('agent-homes');
      expect(await refusalOf(port.linkHistory(resolved(port, 'f1'), 'projects'))).toBe('not_own');
    }
    expect(await exists(w.poolPath)).toBe(false);
  });

  test('27: a pool that sits in a root the kernel makes (agent-homes, credentials, …) is refused not_own', async () => {
    const w = await world();
    await w.makeHome('f1');
    for (const folder of ['agent-homes', 'credentials', 'sessions', 'downloads']) {
      const def = defineState({ name: 'pool', path: `${folder}/*`, store: 'opaque', format: 1 });
      const port = w.port('claude-code', ['agent-homes'], { stateFiles: [def] }).root('agent-homes');
      expect(await refusalOf(port.linkHistory(resolved(port, 'f1'), 'projects'))).toBe('not_own');
    }
    expect(await exists(`${w.homePath('f1')}/projects`)).toBe(false);
  });

  test('28: a pool that holds a private place of the plugin is refused not_own', async () => {
    const w = await world();
    await w.makeHome('f1');
    const port = w
      .port('claude-code', ['agent-homes'], { privateFiles: ['state/claude-code/history-pool/projects'] })
      .root('agent-homes');
    expect(await refusalOf(port.linkHistory(resolved(port, 'f1'), 'projects'))).toBe('not_own');
    expect(await link(w, 'f1', 'sessions')).toBe('ok');
    const wholeTree = w.port('claude-code', ['agent-homes'], { privateFiles: ['state/claude-code/history-pool'] });
    expect(await refusalOf(wholeTree.root('agent-homes').linkHistory(resolved(w.all, 'f1'), 'plans'))).toBe('not_own');
  });

  test('29: another plugin cannot link the claude-code pool: its pool is its own state folder', async () => {
    const w = await world();
    await mkdir(`${w.home}/state/other/agent-homes/o1`, { recursive: true, mode: 0o700 });
    const other = w.port('other', ['agent-homes']).root('agent-homes');
    expect(await refusalOf(other.linkHistory(resolved(other, 'o1'), 'projects'))).toBe('ok');
    expect(await readlink(`${w.home}/state/other/agent-homes/o1/projects`)).toBe(
      `${await realpath(`${w.home}/state/other/history-pool`)}/projects`,
    );
    expect(await exists(w.poolPath)).toBe(false);
  });

  test('30: a pool folder that is a link is refused link_escape, and nothing is made behind it', async () => {
    const w = await world();
    await w.makeHome('f1');
    await mkdir(`${w.parent}/elsewhere`, { recursive: true });
    await symlink(`${w.parent}/elsewhere`, w.poolPath);
    expect(await link(w, 'f1', 'projects')).toBe('root:link_escape');
    expect(await exists(`${w.parent}/elsewhere/projects`)).toBe(false);
    expect(await exists(`${w.homePath('f1')}/projects`)).toBe(false);
  });

  test('31: a pool entry that is a link is refused link_escape, even one that points inside the state folder', async () => {
    const w = await world();
    await w.makeHome('f1');
    await mkdir(`${w.poolPath}`, { recursive: true, mode: 0o700 });
    await mkdir(`${w.home}/state/claude-code/inside`, { recursive: true });
    await symlink(`${w.home}/state/claude-code/inside`, `${w.poolPath}/projects`);
    expect(await link(w, 'f1', 'projects')).toBe('root:link_escape');
    await symlink(`${w.parent}`, `${w.poolPath}/sessions`);
    expect(await link(w, 'f1', 'sessions')).toBe('root:link_escape');
    expect(await exists(`${w.homePath('f1')}/projects`)).toBe(false);
    expect(await exists(`${w.homePath('f1')}/sessions`)).toBe(false);
  });

  test('32: the wrong kind in the pool (a file where a folder is declared, and the reverse) is refused changed', async () => {
    const w = await world();
    await w.makeHome('f1');
    await mkdir(w.poolPath, { recursive: true, mode: 0o700 });
    await writeFile(`${w.poolPath}/projects`, 'a file');
    await mkdir(`${w.poolPath}/history.jsonl`, { mode: 0o700 });
    expect(await link(w, 'f1', 'projects')).toBe('root:changed');
    expect(await link(w, 'f1', 'history.jsonl')).toBe('root:changed');
    expect(await exists(`${w.homePath('f1')}/projects`)).toBe(false);
    expect(await exists(`${w.homePath('f1')}/history.jsonl`)).toBe(false);
  });

  test('33: a pool file with a second name is refused hard_link', async () => {
    const w = await world();
    await w.makeHome('f1');
    await mkdir(w.poolPath, { recursive: true, mode: 0o700 });
    await writeFile(`${w.parent}/other.txt`, 'x');
    await Bun.$`ln ${w.parent}/other.txt ${w.poolPath}/history.jsonl`.quiet();
    expect(await link(w, 'f1', 'history.jsonl')).toBe('root:hard_link');
    expect(await exists(`${w.homePath('f1')}/history.jsonl`)).toBe(false);
  });
});

describe('the pool and the credential doors', () => {
  test('34: credentialHomeLinkVerdict is unchanged: every link into or out of a credential home is still link_escape', () => {
    const roots: (RootName | undefined)[] = [
      'agent-homes',
      'credentials',
      'fleet',
      'harness-home',
      'work',
      'downloads',
      undefined,
    ];
    for (const source of roots)
      for (const target of roots)
        expect(credentialHomeLinkVerdict({ source, target })).toBe(
          ['agent-homes', 'credentials'].includes(source ?? '') || ['agent-homes', 'credentials'].includes(target ?? '')
            ? 'link_escape'
            : undefined,
        );
  });

  test('35: linkTo and copyTree link mode still refuse every link into agent-homes, the pool link included', async () => {
    const w = await world();
    await w.makeHome('f1');
    expect(await link(w, 'f1', 'projects')).toBe('ok');
    const fleetless = w.claude.root('downloads');
    await fleetless.makeDirectory(resolved(fleetless, 'd'));
    expect(
      await refusalOf(w.all.linkTo(resolved(w.all, 'f1/other'), { root: fleetless, path: resolved(fleetless, 'd') })),
    ).toBe('root:link_escape');
    expect(
      await refusalOf(w.all.copyTree(fleetless, resolved(fleetless, 'd'), resolved(w.all, 'f1/other'), { link: true })),
    ).toBe('root:link_escape');
    // through the pool link: the parent is a link, so nothing is written through it either
    expect(
      await refusalOf(
        w.all.linkTo(resolved(w.all, 'f1/projects/x'), { root: fleetless, path: resolved(fleetless, 'd') }),
      ),
    ).toBe('root:link_escape');
  });

  test('36: the kernel never reads or writes through a pool link: it is link_escape for every call', async () => {
    const w = await world();
    await w.makeHome('f1');
    expect(await link(w, 'f1', 'projects')).toBe('ok');
    await writeFile(`${w.poolPath}/projects/real.jsonl`, 'x');
    const through = resolved(w.all, 'f1/projects/real.jsonl');
    expect(await refusalOf(w.all.readText(through))).toBe('root:link_escape');
    expect(await refusalOf(w.all.writeText(resolved(w.all, 'f1/projects/new.jsonl'), 'x'))).toBe('root:link_escape');
    expect(await exists(`${w.poolPath}/projects/new.jsonl`)).toBe(false);
  });

  test('37: a credential cannot be placed in the pool: linkCredential names one level of one home, and never a pooled entry', async () => {
    const w = await world();
    await w.makeHome('f1');
    expect(await link(w, 'f1', 'projects')).toBe('ok');
    const logins = w.port('logins', ['credentials'], { shareCredentials: ['auth.json'] });
    const receiver = w.port('claude-code', ['agent-homes'], { shareCredentials: [] });
    const own = receiver.root('agent-homes', { subfolder: 'f1' });
    const credential = await logins.shareCredential({ folder: 'work', file: 'auth.json', receiver: 'claude-code' });
    // into the pooled folder: the placement is `<home>/auth.json` only
    expect(await refusalOf(own.linkCredential(credential, resolved(own, 'projects/auth.json')))).toBe('root:outside');
    expect(await exists(`${w.poolPath}/projects/auth.json`)).toBe(false);
    // and the credential itself is unharmed: it can still be placed where it belongs
    expect(await refusalOf(own.linkCredential(credential, resolved(own, 'auth.json')))).toBe('ok');
    expect((await lstat(`${w.homePath('f1')}/auth.json`)).isSymbolicLink()).toBe(true);
  });

  test('38: poolCredentialVerdict refuses any credential end at or below the pool, and nothing else', () => {
    const pool = '/h/state/claude-code/history-pool';
    expect(poolCredentialVerdict(pool, [pool])).toBe('link_escape');
    expect(poolCredentialVerdict(pool, [`${pool}/projects/auth.json`])).toBe('link_escape');
    expect(poolCredentialVerdict(pool, ['/h/state/claude-code/agent-homes/f1/auth.json', `${pool}/x`])).toBe(
      'link_escape',
    );
    expect(poolCredentialVerdict(pool, ['/h/state/claude-code/agent-homes/f1/auth.json'])).toBeUndefined();
    expect(poolCredentialVerdict(pool, [`${pool}-other/x`])).toBeUndefined();
    expect(poolCredentialVerdict(undefined, [pool])).toBeUndefined();
  });

  test('39: the history door shares nothing else: only the entry linked is shared, the rest of the home is private to the ferret', async () => {
    const w = await world();
    await w.makeHome('f1');
    await w.makeHome('f2');
    await writeFile(`${w.homePath('f1')}/settings.json`, '{"mine":1}');
    for (const decl of CLAUDE.entries) expect(await link(w, 'f1', decl.name)).toBe('ok');
    expect(await exists(`${w.homePath('f2')}/settings.json`)).toBe(false);
    expect(await exists(`${w.homePath('f2')}/.claude.json`)).toBe(true);
    expect((await lstat(`${w.homePath('f1')}/.claude.json`)).isSymbolicLink()).toBe(false);
    expect((await lstat(`${w.homePath('f1')}/settings.json`)).isSymbolicLink()).toBe(false);
  });
});

describe('the pure rules', () => {
  test('40: the harness lists are legal names, and nothing on the deny list is', () => {
    for (const decl of CLAUDE.entries) expect(historyPoolNameRefusal(decl.name)).toBeUndefined();
    for (const name of ['sessions', 'archived_sessions', 'history.jsonl'])
      expect(historyPoolNameRefusal(name)).toBeUndefined();
    for (const name of HISTORY_POOL_DENIED_NAMES) expect(historyPoolNameRefusal(name)).toBeDefined();
    for (const name of [
      '',
      '.',
      '..',
      '.x',
      'a/b',
      'a\\b',
      'a\0b',
      'a b',
      'x'.repeat(256),
      'settings-1.json',
      'Settings.JSON',
    ])
      expect(historyPoolNameRefusal(name)).toBeDefined();
    expect(historyPoolNameRefusal(undefined)).toBeDefined();
    expect(historyPoolNameRefusal(3)).toBeDefined();
  });

  test('41: a listed name the rules refuse is treated as not listed, so a bad declaration never widens the door', () => {
    const lax: HistoryPoolPermission = { state: 'pool', entries: [{ name: 'skills', kind: 'folder' }] };
    expect(declaredHistoryEntry(lax, 'skills')).toBeUndefined();
    expect(() => historyEntryFor(lax, 'skills')).toThrow(HistoryPoolError);
    expect(declaredHistoryEntry(CLAUDE, 'projects')).toEqual({ name: 'projects', kind: 'folder' });
    expect(declaredHistoryEntry(CLAUDE, 'Projects')).toBeUndefined();
    expect(declaredHistoryEntry(undefined, 'projects')).toBeUndefined();
  });

  test('42: isFerretHome is exactly one folder below the top', () => {
    const top = '/h/state/p/agent-homes';
    expect(isFerretHome(top, `${top}/f1`)).toBe(true);
    expect(isFerretHome(top, top)).toBe(false);
    expect(isFerretHome(top, `${top}/f1/sub`)).toBe(false);
    expect(isFerretHome(top, '/h/state/p/other/f1')).toBe(false);
    expect(isFerretHome(top, `${top}x/f1`)).toBe(false);
  });

  test('43: historyPoolFault and poolStateFolder judge the declaration against the plugin’s own state files', () => {
    expect(historyPoolFault(CLAUDE, [POOL])).toBeUndefined();
    expect(poolStateFolder(CLAUDE, [POOL])).toBe('history-pool');
    expect(historyPoolFault(undefined, [])).toBeUndefined();
    expect(historyPoolFault(CLAUDE, [])).toContain('state');
    expect(historyPoolFault({ state: 'pool', entries: [] }, [POOL])).toContain('at least one');
    expect(historyPoolFault({ state: 'pool', entries: [{ name: 'a', kind: 'link' as never }] }, [POOL])).toContain(
      'kind',
    );
    expect(
      historyPoolFault(
        {
          state: 'pool',
          entries: [
            { name: 'a', kind: 'file' },
            { name: 'A', kind: 'folder' },
          ],
        },
        [POOL],
      ),
    ).toContain('twice');
    expect(historyPoolFault({ state: 'pool', entries: [{ name: 'auth.json', kind: 'file' }] }, [POOL])).toContain(
      'auth.json',
    );
    expect(
      poolStateFolder(CLAUDE, [defineState({ name: 'pool', path: '.hidden/*', store: 'opaque', format: 1 })]),
    ).toBeUndefined();
  });

  test('44: reachFaults refuses a manifest whose historyPool is illegal or has no agent-homes root', () => {
    const base = { title: 'X', version: '5.0.0', api: 5, core: false, kinds: [] } as const;
    const good = definePlugin({
      ...base,
      id: 'good',
      permissions: { roots: ['agent-homes'], historyPool: CLAUDE },
      data: { state: [POOL] },
    });
    const badName = definePlugin({
      ...base,
      id: 'bad-name',
      permissions: {
        roots: ['agent-homes'],
        historyPool: { state: 'pool', entries: [{ name: 'skills', kind: 'folder' }] },
      },
      data: { state: [POOL] },
    });
    const badState = definePlugin({
      ...base,
      id: 'bad-state',
      permissions: { roots: ['agent-homes'], historyPool: CLAUDE },
    });
    const noRoot = definePlugin({
      ...base,
      id: 'no-root',
      permissions: { roots: ['downloads'], historyPool: CLAUDE },
      data: { state: [POOL] },
    });
    expect(reachFaults([good])).toEqual([]);
    const faults = reachFaults([badName, badState, noRoot]);
    expect(faults.map(fault => [fault.plugin, fault.code])).toEqual([
      ['bad-name', 'history-pool'],
      ['bad-state', 'history-pool'],
      ['no-root', 'history-pool'],
    ]);
    expect(faults[0]?.sentence).toContain("'skills'");
    expect(faults[2]?.sentence).toContain('agent-homes');
  });
});
