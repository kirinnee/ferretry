/**
 * The history-pool door: `RootHandle.linkHistory` makes `<one ferret home>/<entry>` a symlink to the SAME entry of ONE
 * pool the harness plugin owns (`state/<plugin>/history-pool/<entry>`). On the real roots port and a real disk. Who may
 * link, which names, which homes, which pool, what may already be at the name, what the kernel makes on first use, that
 * a link is proved before it stays, and that no other door (`linkTo`, `copyTree`, `linkCredential`) is widened.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  link as hardLink,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
  hook.beforePool = undefined;
  hook.afterSymlink = undefined;
  hook.beforeRename = undefined;
  hook.afterOpenDirectory = undefined;

  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const baseFs = nodeFs(() => crypto.randomUUID());
/** Test seams on the disk: a step run just before the symlink is made, a different target, a host with no descriptor path. */
const hook: {
  beforeSymlink: undefined | ((path: string) => Promise<void>);
  symlinkTo: undefined | ((target: string) => string);
  noReach: boolean;
  /** Run once, just before the first folder of the plugin's state (outside `agent-homes`) is opened: the pool is reached. */
  beforePool: undefined | (() => Promise<void>);
  /** Run just after the link is made, before the kernel proves it: the target is replaced in that instant. */
  afterSymlink: undefined | ((path: string) => Promise<void>);
  beforeRename?: () => Promise<void>;
  afterOpenDirectory?: (path: string) => Promise<void>;
} = { beforeSymlink: undefined, symlinkTo: undefined, noReach: false, beforePool: undefined, afterSymlink: undefined };
let stateOfPlugin = '';

const fs: HostFs = {
  ...baseFs,
  rename: async (from, to) => {
    await hook.beforeRename?.();
    await baseFs.rename(from, to);
  },
  symlink: async (target, path) => {
    await hook.beforeSymlink?.(path);
    await baseFs.symlink(hook.symlinkTo?.(target) ?? target, path);
    await hook.afterSymlink?.(path);
  },
  openDirectory: async path => {
    if (hook.beforePool !== undefined && path.startsWith(stateOfPlugin) && !path.includes('/agent-homes')) {
      const run = hook.beforePool;
      hook.beforePool = undefined;
      await run();
    }
    const folder = await baseFs.openDirectory(path);
    await hook.afterOpenDirectory?.(path);
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
  stateOfPlugin = `${home}/state/claude-code`;
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

/** Production boot makes the pool's base before the plugin can request its synchronous view. */
async function poolWorld() {
  const w = await world();
  expect(
    await ensureInternalRootBases(fs, { home: w.home, plugin: 'claude-code' }, ['agent-homes'], {
      historyPool: CLAUDE,
      stateFiles: [POOL],
    }),
  ).toEqual([]);
  const pool = w.claude.historyPool();
  return { ...w, pool };
}

describe('the pool view and checked move', () => {
  test('boot never follows an existing pool alias or a plugin-state folder swapped during descent', async () => {
    const w = await world();
    const sibling = `${w.home}/state/claude-code/sibling`;
    await mkdir(sibling, { mode: 0o755 });
    await symlink(sibling, w.poolPath);
    const boot = async () =>
      await ensureInternalRootBases(fs, { home: w.home, plugin: 'claude-code' }, ['agent-homes'], {
        historyPool: CLAUDE,
        stateFiles: [POOL],
      });
    expect(await boot()).toEqual([{ name: 'agent-homes', refusal: 'link_escape' }]);
    expect(await modeOf(sibling)).toBe(0o755);
    await rm(w.poolPath);
    const outside = `${w.parent}/outside`;
    await mkdir(outside, { mode: 0o755 });
    hook.afterOpenDirectory = async at => {
      if (at !== `${w.home}/state/claude-code`) return;
      hook.afterOpenDirectory = undefined;
      const state = `${w.home}/state/claude-code`;
      await rename(state, `${state}-held`);
      await symlink(outside, state);
    };
    expect(['link_escape', 'changed']).toContain((await boot())[0]?.refusal ?? 'none');
    expect(await exists(`${outside}/history-pool`)).toBe(false);
    expect(await modeOf(outside)).toBe(0o755);
  });
  test('a swapped pool base is refused during descriptor descent, before an outside transcript is read', async () => {
    const w = await poolWorld();
    const path = resolved(w.pool, 'projects/a');
    await w.pool.writeText(path, 'inside');
    const outside = `${w.parent}/outside`;
    await mkdir(`${outside}/projects`, { recursive: true });
    await writeFile(`${outside}/projects/a`, 'outside');
    hook.beforePool = async () => {
      await rename(w.poolPath, `${w.poolPath}-held`);
      await symlink(outside, w.poolPath);
    };
    expect(['root:link_escape', 'root:changed']).toContain(await refusalOf(w.pool.readText(path)));
    expect(await readFile(`${outside}/projects/a`, 'utf8')).toBe('outside');
  });

  for (const operation of ['read', 'write', 'move', 'boot'] as const)
    test(`${operation} refuses a real agent home swapped in for the pool after its identity check`, async () => {
      const w = await poolWorld();
      if (operation === 'read') await w.pool.writeText(resolved(w.pool, '.claude.json'), 'old pool');
      await w.makeHome('f1');
      await w.all.writeText(resolved(w.all, 'f1/projects/a'), 'source');
      hook.beforePool = async () => {
        await rename(w.poolPath, `${w.poolPath}-held`);
        await rename(w.homePath('f1'), w.poolPath);
      };
      if (operation === 'boot') {
        const answer = await ensureInternalRootBases(fs, { home: w.home, plugin: 'claude-code' }, ['agent-homes'], {
          historyPool: CLAUDE,
          stateFiles: [POOL],
        });
        expect(answer).toEqual([{ name: 'agent-homes', refusal: 'changed' }]);
      } else {
        const action =
          operation === 'read'
            ? w.pool.readText(resolved(w.pool, '.claude.json'))
            : operation === 'write'
              ? w.pool.writeText(resolved(w.pool, 'projects/new/note'), 'bad')
              : w.all.moveToHistoryPool(
                  resolved(w.all, 'f1/projects/a'),
                  w.pool,
                  resolved(w.pool, 'projects/new/note'),
                );
        expect(await refusalOf(action)).toBe('root:changed');
      }
      expect(await readFile(`${w.poolPath}/projects/a`, 'utf8')).toBe('source');
      expect(await readFile(`${w.poolPath}/.claude.json`, 'utf8')).toBe('{}');
      expect(await exists(`${w.poolPath}/projects/new`)).toBe(false);
    });

  for (const swapped of ['home', 'parent'] as const)
    test(`a ${swapped} swapped before the held descent refuses and leaves both entries untouched`, async () => {
      const w = await poolWorld();
      await w.makeHome('f1');
      await w.all.writeText(resolved(w.all, 'f1/projects/a'), 'inside');
      const outside = `${w.parent}/outside`;
      await mkdir(`${outside}/projects`, { recursive: true });
      await writeFile(`${outside}/a`, 'outside parent');
      await writeFile(`${outside}/projects/a`, 'outside home');
      const from = swapped === 'home' ? w.homePath('f1') : `${w.homePath('f1')}/projects`;
      hook.afterOpenDirectory = async at => {
        if (at !== w.home) return;
        hook.afterOpenDirectory = undefined;
        await rename(from, `${from}-held`);
        await symlink(outside, from);
      };
      expect(['root:link_escape', 'root:changed']).toContain(
        await refusalOf(
          w.all.moveToHistoryPool(resolved(w.all, 'f1/projects/a'), w.pool, resolved(w.pool, 'projects/a')),
        ),
      );
      expect(await readFile(`${outside}/a`, 'utf8')).toBe('outside parent');
      expect(await readFile(`${outside}/projects/a`, 'utf8')).toBe('outside home');
      expect(await exists(`${w.poolPath}/projects/a`)).toBe(false);
      expect(await readFile(swapped === 'home' ? `${from}-held/projects/a` : `${from}-held/a`, 'utf8')).toBe('inside');
    });
  test('boot makes the base 0700; the view writes, lists, reads windows and holds arbitrary bytes', async () => {
    const w = await poolWorld();
    expect(w.pool.internal).toBe(true);
    expect(await modeOf(w.poolPath)).toBe(0o700);
    const path = resolved(w.pool, 'projects/-home-user-proj/abc.jsonl');
    const bytes = new Uint8Array([0, 255, 11, 128, 65]);
    await w.pool.writeBytes(path, bytes);
    expect(await w.pool.list(resolved(w.pool, 'projects'))).toEqual(['-home-user-proj']);
    expect(await w.pool.readBytes(path)).toEqual(bytes);
    expect(await w.pool.readBytes(path, { offset: 1, length: 3 })).toEqual(bytes.slice(1, 4));
    const held = await w.pool.openBytes?.(path);
    expect(held).toBeDefined();
    try {
      expect(await held?.read(1, 2)).toEqual(bytes.slice(1, 3));
      expect(await held?.stillNames()).toBe(true);
    } finally {
      await held?.close();
    }
    await w.pool.writeText(resolved(w.pool, 'projects/-home-user-proj/text'), 'hello');
    expect(await w.pool.readText(resolved(w.pool, 'projects/-home-user-proj/text'))).toBe('hello');
    await w.makeHome('f1');
    expect(await link(w, 'f1', 'projects')).toBe('ok');
    expect(await readFile(`${w.homePath('f1')}/projects/-home-user-proj/abc.jsonl`)).toEqual(Buffer.from(bytes));
    expect(await refusalOf(w.all.readBytes(resolved(w.all, 'f1/projects/-home-user-proj/abc.jsonl')))).toBe(
      'root:link_escape',
    );
  });

  test('permission, ownership, private state and declared root refusals are synchronous and ordered', async () => {
    const w = await world();
    const get = (port: RootsPort) => refusalOf(Promise.resolve().then(() => port.historyPool()));
    expect(await get(w.port('claude-code', [], { historyPool: undefined }))).toBe('not_permitted');
    expect(await get(w.port('claude-code', [], { stateFiles: [] }))).toBe('not_own');
    expect(
      await get(w.port('claude-code', ['agent-homes'], { privateFiles: ['state/claude-code/history-pool/private/*'] })),
    ).toBe('not_own');
    expect(await get(w.port('claude-code', []))).toBe('root:not_declared');
    for (const folder of ['agent-homes', 'credentials', 'sessions']) {
      const def = defineState({ name: 'pool', path: `${folder}/*`, store: 'opaque', format: 1 });
      expect(await get(w.port('claude-code', ['agent-homes'], { stateFiles: [def] }))).toBe('not_own');
    }
    expect(await exists(w.poolPath)).toBe(false);
  });

  test('pool views cannot reach other state, credentials, homes or another plugin', async () => {
    const w = await poolWorld();
    await w.makeHome('f1');
    for (const path of [w.homePath('f1') + '/.claude.json', `${w.home}/state/logins/credentials/work/auth.json`])
      expect(await refusalOf(w.pool.readText(path as FencedPath))).toBe('root:outside');
    expect(w.pool.resolve('../agent-homes/f1').ok).toBe(false);
    const other = w.port('other', ['agent-homes']).historyPool();
    await w.all.writeText(resolved(w.all, 'f1/projects/a'), 'mine');
    expect(
      await refusalOf(w.all.moveToHistoryPool(resolved(w.all, 'f1/projects/a'), other, resolved(other, 'projects/a'))),
    ).toBe('not_own');
    expect(await w.all.readText(resolved(w.all, 'f1/projects/a'))).toBe('mine');
  });

  test('links inside the pool, even to another pool file, and hard-linked files are never read', async () => {
    const w = await poolWorld();
    await w.pool.writeText(resolved(w.pool, 'projects/good'), 'kept');
    await symlink(`${w.poolPath}/projects/good`, `${w.poolPath}/projects/alias`);
    await hardLink(`${w.poolPath}/projects/good`, `${w.poolPath}/projects/hard`);
    for (const operation of ['readText', 'readBytes', 'openBytes'] as const) {
      expect(
        await refusalOf(
          (async (): Promise<unknown> => await w.pool[operation]?.(resolved(w.pool, 'projects/alias')))(),
        ),
      ).toBe('root:link_escape');
      expect(
        await refusalOf((async (): Promise<unknown> => await w.pool[operation]?.(resolved(w.pool, 'projects/hard')))()),
      ).toBe('root:hard_link');
    }
    expect(await refusalOf(w.pool.writeText(resolved(w.pool, 'projects/alias'), 'bad'))).toBe('root:link_escape');
    expect(await readFile(`${w.poolPath}/projects/good`, 'utf8')).toBe('kept');
  });

  test('the pool has no history door and cannot be either end of any generic link door', async () => {
    const w = await poolWorld();
    await w.pool.makeDirectory(resolved(w.pool, 'projects'));
    await w.makeHome('f1');
    const downloads = w.claude.root('downloads');
    await downloads.makeDirectory(resolved(downloads, 'd'));
    expect(await refusalOf(w.pool.linkHistory(resolved(w.pool, 'projects'), 'projects'))).toBe('not_internal');
    expect(
      await refusalOf(w.pool.moveToHistoryPool(resolved(w.pool, 'projects'), w.pool, resolved(w.pool, 'projects/x'))),
    ).toBe('not_internal');
    for (const [place, source, from, to] of [
      [w.pool, downloads, 'd', 'alias'],
      [downloads, w.pool, 'projects', 'alias'],
    ] as const) {
      expect(await refusalOf(place.linkTo(resolved(place, to), { root: source, path: resolved(source, from) }))).toBe(
        'root:link_escape',
      );
      expect(await refusalOf(place.copyTree(source, resolved(source, from), resolved(place, to), { link: true }))).toBe(
        'root:link_escape',
      );
      expect(await exists(`${w.poolPath}/alias`)).toBe(false);
    }
    const logins = w.port('logins', ['credentials'], { shareCredentials: ['auth.json'] });
    const credential = await logins.shareCredential({ folder: 'work', file: 'auth.json', receiver: 'claude-code' });
    expect(await refusalOf(w.pool.linkCredential(credential, resolved(w.pool, 'auth.json')))).toBe('root:link_escape');
  });

  test('two homes merge into one slug; a conflict is preserved under the source ferret name', async () => {
    const w = await poolWorld();
    for (const ferret of ['f1', 'f2']) {
      await w.makeHome(ferret);
      await w.all.writeText(resolved(w.all, `${ferret}/projects/-work/${ferret}.jsonl`), ferret);
      const own = w.claude.root('agent-homes', { subfolder: ferret });
      await own.moveToHistoryPool(
        resolved(own, `projects/-work/${ferret}.jsonl`),
        w.pool,
        resolved(w.pool, `projects/-work/${ferret}.jsonl`),
      );
      expect(await exists(`${w.homePath(ferret)}/projects/-work/${ferret}.jsonl`)).toBe(false);
    }
    expect(await w.pool.list(resolved(w.pool, 'projects/-work'))).toEqual(['f1.jsonl', 'f2.jsonl']);
    await w.all.writeText(resolved(w.all, 'f1/projects/-work/f2.jsonl'), 'conflict');
    await w.all.moveToHistoryPool(
      resolved(w.all, 'f1/projects/-work/f2.jsonl'),
      w.pool,
      resolved(w.pool, '.conflicts/f1/projects/-work/f2.jsonl'),
    );
    expect(await w.pool.readText(resolved(w.pool, '.conflicts/f1/projects/-work/f2.jsonl'))).toBe('conflict');
    expect(await w.pool.readText(resolved(w.pool, 'projects/-work/f2.jsonl'))).toBe('f2');
    expect(await modeOf(`${w.poolPath}/.conflicts/f1`)).toBe(0o700);
  });

  test('a whole folder, an empty folder, and a leaf symlink move as themselves', async () => {
    const w = await poolWorld();
    await w.makeHome('f1');
    await w.all.writeText(resolved(w.all, 'f1/projects/-work/a'), 'a');
    await w.all.makeDirectory(resolved(w.all, 'f1/sessions'));
    await symlink(`${w.home}/state/logins/credentials/work/auth.json`, `${w.homePath('f1')}/history.jsonl`);
    for (const entry of ['projects', 'sessions', 'history.jsonl'])
      await w.all.moveToHistoryPool(resolved(w.all, `f1/${entry}`), w.pool, resolved(w.pool, entry));
    expect(await w.pool.readText(resolved(w.pool, 'projects/-work/a'))).toBe('a');
    expect((await lstat(`${w.poolPath}/sessions`)).isDirectory()).toBe(true);
    expect((await lstat(`${w.poolPath}/history.jsonl`)).isSymbolicLink()).toBe(true);
    expect(await refusalOf(w.pool.readText(resolved(w.pool, 'history.jsonl')))).toBe('root:link_escape');
  });

  test('every lexical refusal leaves the source and target untouched', async () => {
    const w = await poolWorld();
    await w.makeHome('f1');
    await w.all.writeText(resolved(w.all, 'f1/projects/a'), 'source');
    for (const entry of ['auth.json', 'settings.json', 'skills', '.hidden', 'unlisted']) {
      await w.all.writeText(resolved(w.all, `f1/${entry}`), 'kept');
      expect(
        await refusalOf(w.all.moveToHistoryPool(resolved(w.all, `f1/${entry}`), w.pool, resolved(w.pool, entry))),
      ).toBe(entry === 'unlisted' ? 'not_listed' : 'denied');
      expect(await readFile(`${w.homePath('f1')}/${entry}`, 'utf8')).toBe('kept');
      expect(await exists(`${w.poolPath}/${entry}`)).toBe(false);
    }
    for (const target of ['sessions/a', '.conflicts/f2/projects/a', '.conflicts/f1/sessions/a', 'projects/.hidden/a']) {
      expect(
        await refusalOf(w.all.moveToHistoryPool(resolved(w.all, 'f1/projects/a'), w.pool, resolved(w.pool, target))),
      ).toBe('denied');
      expect(await exists(`${w.poolPath}/${target}`)).toBe(false);
    }
    for (const source of ['', 'f1'])
      expect(
        await refusalOf(w.all.moveToHistoryPool(resolved(w.all, source), w.pool, resolved(w.pool, 'projects/a'))),
      ).toBe('not_home');
    for (const targetPool of [w.all, { ...w.pool }] as RootHandle[])
      expect(
        await refusalOf(
          w.all.moveToHistoryPool(resolved(w.all, 'f1/projects/a'), targetPool, resolved(w.pool, 'projects/a')),
        ),
      ).toBe('not_own');
    expect(await w.all.readText(resolved(w.all, 'f1/projects/a'))).toBe('source');
  });

  test('an existing file, folder or link at the target is never overwritten', async () => {
    const w = await poolWorld();
    await w.makeHome('f1');
    await w.all.writeText(resolved(w.all, 'f1/projects/a'), 'source');
    await w.pool.writeText(resolved(w.pool, 'projects/file'), 'target');
    await w.pool.makeDirectory(resolved(w.pool, 'projects/folder'));
    await symlink(`${w.poolPath}/projects/file`, `${w.poolPath}/projects/link`);
    for (const target of ['file', 'folder', 'link']) {
      expect(
        await refusalOf(
          w.all.moveToHistoryPool(resolved(w.all, 'f1/projects/a'), w.pool, resolved(w.pool, `projects/${target}`)),
        ),
      ).toBe('root:outside');
      expect(await w.all.readText(resolved(w.all, 'f1/projects/a'))).toBe('source');
    }
    expect(await w.pool.readText(resolved(w.pool, 'projects/file'))).toBe('target');
    expect((await lstat(`${w.poolPath}/projects/link`)).isSymbolicLink()).toBe(true);
  });

  test('a hard-linked source, a placed credential itself or inside a folder is never moved', async () => {
    const w = await poolWorld();
    await w.makeHome('f1');
    await w.all.writeText(resolved(w.all, 'f1/projects/a'), 'source');
    await hardLink(`${w.homePath('f1')}/projects/a`, `${w.parent}/other-name`);
    expect(
      await refusalOf(
        w.all.moveToHistoryPool(resolved(w.all, 'f1/projects/a'), w.pool, resolved(w.pool, 'projects/a')),
      ),
    ).toBe('root:hard_link');
    const logins = w.port('logins', ['credentials'], { shareCredentials: ['auth.json'] });
    const receiver = w.claude.root('agent-homes', { subfolder: 'f1/projects' });
    const credential = await logins.shareCredential({ folder: 'work', file: 'auth.json', receiver: 'claude-code' });
    await receiver.linkCredential(credential, resolved(receiver, 'auth.json'));
    for (const entry of ['projects/auth.json', 'projects'])
      expect(
        await refusalOf(w.all.moveToHistoryPool(resolved(w.all, `f1/${entry}`), w.pool, resolved(w.pool, entry))),
      ).toBe('root:link_escape');
    expect((await lstat(`${w.homePath('f1')}/projects/auth.json`)).isSymbolicLink()).toBe(true);
    expect(await exists(`${w.poolPath}/projects`)).toBe(false);
  });

  test('cross-device and no-descriptor refusals never fall back to copying', async () => {
    const w = await poolWorld();
    await w.makeHome('f1');
    await w.all.writeText(resolved(w.all, 'f1/projects/a'), 'source');
    hook.noReach = true;
    expect(
      await refusalOf(
        w.all.moveToHistoryPool(resolved(w.all, 'f1/projects/a'), w.pool, resolved(w.pool, 'projects/a')),
      ),
    ).toBe('root:no_descriptor_reach');
    hook.noReach = false;
    hook.beforeRename = async () => {
      throw Object.assign(new Error('cross device'), { code: 'EXDEV' });
    };
    expect(
      await refusalOf(
        w.all.moveToHistoryPool(resolved(w.all, 'f1/projects/a'), w.pool, resolved(w.pool, 'projects/a')),
      ),
    ).toBe('root:changed');
    expect(await readFile(`${w.homePath('f1')}/projects/a`, 'utf8')).toBe('source');
    expect(await exists(`${w.poolPath}/projects/a`)).toBe(false);
  });

  for (const swapped of ['home', 'parent'] as const)
    test(`a ${swapped} swapped for a link after the check never moves the outside file`, async () => {
      const w = await poolWorld();
      await w.makeHome('f1');
      await w.all.writeText(resolved(w.all, 'f1/projects/a'), 'inside');
      const outside = `${w.parent}/outside`;
      await mkdir(`${outside}/projects`, { recursive: true });
      await writeFile(`${outside}/a`, 'outside parent');
      await writeFile(`${outside}/projects/a`, 'outside home');
      const from = swapped === 'home' ? w.homePath('f1') : `${w.homePath('f1')}/projects`;
      hook.beforeRename = async () => {
        hook.beforeRename = undefined;
        await rename(from, `${from}-held`);
        await symlink(outside, from);
      };
      const result = await refusalOf(
        w.all.moveToHistoryPool(resolved(w.all, 'f1/projects/a'), w.pool, resolved(w.pool, 'projects/a')),
      );
      expect(['ok', 'root:changed', 'root:link_escape']).toContain(result);
      expect(await readFile(`${outside}/a`, 'utf8')).toBe('outside parent');
      expect(await readFile(`${outside}/projects/a`, 'utf8')).toBe('outside home');
      const landed = await readFile(`${w.poolPath}/projects/a`, 'utf8').catch(() => undefined);
      if (landed !== undefined) expect(landed).toBe('inside');
    });
});

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

describe('RootHandle.linkHistory: the pool is reached by descriptor, and the target is proved after it is published', () => {
  const homeNames = async (w: World, ferret: string): Promise<string[]> => (await readdir(w.homePath(ferret))).sort();

  test('45: a pool folder swapped for a link to an agent home creates nothing in that home (pool already there)', async () => {
    const w = await world();
    await w.makeHome('f1');
    await w.makeHome('f2');
    await mkdir(w.poolPath, { mode: 0o700 });
    hook.beforePool = async () => {
      await rename(w.poolPath, `${w.poolPath}.aside`);
      await symlink(w.homePath('f2'), w.poolPath);
    };
    expect(await link(w, 'f1', 'projects')).toBe('root:link_escape');
    expect(await homeNames(w, 'f2')).toEqual(['.claude.json']);
    expect(await exists(`${w.homePath('f1')}/projects`)).toBe(false);
  });

  test('46: a pool folder that appears as a link to an agent home creates nothing in that home (pool not there yet)', async () => {
    const w = await world();
    await w.makeHome('f1');
    await w.makeHome('f2');
    hook.beforePool = async () => {
      await symlink(w.homePath('f2'), w.poolPath);
    };
    expect(await link(w, 'f1', 'history.jsonl')).toBe('root:link_escape');
    expect(await homeNames(w, 'f2')).toEqual(['.claude.json']);
    expect(await exists(`${w.homePath('f1')}/history.jsonl`)).toBe(false);
  });

  test('47: a pool folder swapped for another real directory of the state folder is changed, and nothing is made in it', async () => {
    const w = await world();
    await w.makeHome('f1');
    await mkdir(w.poolPath, { mode: 0o700 });
    const decoy = `${w.home}/state/claude-code/decoy`;
    await mkdir(decoy, { mode: 0o700 });
    hook.beforePool = async () => {
      await rename(w.poolPath, `${w.poolPath}.aside`);
      await rename(decoy, w.poolPath);
    };
    expect(await link(w, 'f1', 'projects')).toBe('root:changed');
    expect(await readdir(w.poolPath)).toEqual([]);
    expect(await exists(`${w.homePath('f1')}/projects`)).toBe(false);
  });

  test('48: a pool folder that is a file is changed, nothing is made beside it', async () => {
    const w = await world();
    await w.makeHome('f1');
    await writeFile(w.poolPath, 'a file');
    expect(await link(w, 'f1', 'projects')).toBe('root:changed');
    expect((await lstat(w.poolPath)).isFile()).toBe(true);
    expect(await exists(`${w.homePath('f1')}/projects`)).toBe(false);
  });

  test('49: a pool folder entry replaced by another folder after the link is made is changed, and only that link is taken back', async () => {
    const w = await world();
    await w.makeHome('f1');
    await link(w, 'f1', 'sessions');
    hook.afterSymlink = async () => {
      await rename(`${w.poolPath}/projects`, `${w.poolPath}/projects.aside`);
      await mkdir(`${w.poolPath}/projects`, { mode: 0o700 });
    };
    expect(await link(w, 'f1', 'projects')).toBe('root:changed');
    expect(await exists(`${w.homePath('f1')}/projects`)).toBe(false);
    expect((await lstat(`${w.homePath('f1')}/sessions`)).isSymbolicLink()).toBe(true);
  });

  test('50: a pool file replaced by a different inode after the link is made is changed and the link is taken back', async () => {
    const w = await world();
    await w.makeHome('f1');
    hook.afterSymlink = async () => {
      // Made BESIDE the original first, so the two never share an inode, then renamed over it.
      await writeFile(`${w.poolPath}/history.jsonl.new`, 'swapped', { mode: 0o600 });
      await rename(`${w.poolPath}/history.jsonl.new`, `${w.poolPath}/history.jsonl`);
    };
    expect(await link(w, 'f1', 'history.jsonl')).toBe('root:changed');
    expect(await exists(`${w.homePath('f1')}/history.jsonl`)).toBe(false);
  });

  test('51: a pool file given a second name (a credential alias) after the link is made is hard_link, and the link is taken back', async () => {
    const w = await world();
    await w.makeHome('f1');
    hook.afterSymlink = async () => {
      await hardLink(`${w.poolPath}/history.jsonl`, `${w.parent}/alias.json`);
    };
    expect(await link(w, 'f1', 'history.jsonl')).toBe('root:hard_link');
    expect(await exists(`${w.homePath('f1')}/history.jsonl`)).toBe(false);
  });

  test('52: a pool entry made a link after the link is made is link_escape, and the link is taken back', async () => {
    const w = await world();
    await w.makeHome('f1');
    await mkdir(`${w.parent}/elsewhere`, { recursive: true });
    hook.afterSymlink = async () => {
      await rename(`${w.poolPath}/projects`, `${w.poolPath}/projects.aside`);
      await symlink(`${w.parent}/elsewhere`, `${w.poolPath}/projects`);
    };
    expect(await link(w, 'f1', 'projects')).toBe('root:link_escape');
    expect(await exists(`${w.homePath('f1')}/projects`)).toBe(false);
  });

  test('53: a pool whose state folder is a kernel-made root is named at build/boot, not only when a link is made', () => {
    for (const folder of ['agent-homes', 'credentials', 'sessions', 'downloads', 'Agent-Homes']) {
      const def = defineState({ name: 'pool', path: `${folder}/*`, store: 'opaque', format: 1 });
      expect(poolStateFolder(CLAUDE, [def])).toBeUndefined();
      expect(historyPoolFault(CLAUDE, [def])).toContain('root the kernel makes');
    }
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
