/**
 * `kernel.processes` (`host/processes.ts`): today's Codex app-server stopper's rules, held by the kernel. A plugin asks
 * with pids and folders of its OWN roots and hears pids and booleans; nothing it hears carries a command line or an
 * environment, and the only signal is a SIGTERM to a process that still runs from beneath its folder.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { FencedPath } from '../../../contract/bound.ts';
import type { OwnFolder, ProcessesPort, RootHandle } from '../../../contract/ports.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import {
  matchableVariables,
  NO_PROCESS_TABLE,
  type OwnFolderSpellings,
  processesPortFor,
  runsBeneath,
} from '../../../host/processes.ts';
import { ensureInternalRootBases, ownFolderSpellings, rootsPortFor } from '../../../host/roots.ts';
import { type TestProcess, testProcessTable } from '../../../testing/index.ts';

const HOME_DIR = '/home/owner/.ferretry/fleet/homes/codex-a';
const SECRET = 'sk-live-planted-secret-value';

/** A stand-in root handle: only its identity matters to the fake own-root check. */
const ownRoot = { name: 'fleet' } as unknown as RootHandle;
const strangerRoot = { name: 'fleet' } as unknown as RootHandle;
const folder = (path: string, root: RootHandle = ownRoot): OwnFolder => ({ root, path: path as FencedPath });
const HOME = folder(HOME_DIR);
const PACKAGES = folder(`${HOME_DIR}/packages/app-server-daemon`);

/** The fake own-root check: `ownRoot` is runtimes', any other handle is nobody's. */
const fakeSpellings: OwnFolderSpellings = async (plugin, asked) =>
  plugin === 'runtimes' && asked.root === ownRoot ? [asked.path] : undefined;

const DAEMON: TestProcess = {
  pid: 4242,
  commandLine: `${HOME_DIR}/packages/app-server-daemon/bin/codex app-server`,
  environment: { CODEX_HOME: HOME_DIR, OPENAI_API_KEY: SECRET },
};
const TUI: TestProcess = { pid: 4300, commandLine: 'codex --tui', environment: { CODEX_HOME: HOME_DIR } };
const STRANGER: TestProcess = {
  pid: 4400,
  uid: 0,
  commandLine: `${HOME_DIR}/packages/app-server-daemon/bin/codex app-server`,
  environment: { CODEX_HOME: HOME_DIR },
};

const port = (
  processes: readonly TestProcess[],
  environment: readonly string[] = ['CODEX_HOME'],
  plugin = 'runtimes',
) => {
  const table = testProcessTable({ processes, self: 1000, ancestors: [999, 500] });
  return { table, port: processesPortFor(plugin, { environment }, fakeSpellings, table) };
};

describe('processes: the permission', () => {
  test('a plugin without permissions.processes is refused by name on every member', async () => {
    const undeclared = processesPortFor(
      'stranger',
      undefined,
      fakeSpellings,
      testProcessTable({ processes: [DAEMON] }),
    );
    for (const call of [
      () => undeclared.runsFrom(DAEMON.pid, PACKAGES),
      () => undeclared.usersOf('CODEX_HOME', HOME),
      () => undeclared.terminate(DAEMON.pid, PACKAGES),
    ])
      await expect(call()).rejects.toThrow('stranger did not declare permissions.processes');
  });

  test('an undeclared variable is refused, even one the process really carries', async () => {
    const { port: declared } = port([DAEMON]);
    await expect(declared.usersOf('OPENAI_API_KEY', HOME)).rejects.toThrow(
      'runtimes may match only the environment variables its permissions.processes lists',
    );
  });

  test("a '*' in environment grants no variable, and only plain names are ever matchable", async () => {
    expect([...matchableVariables({ environment: ['*', 'CODEX_HOME', 'A=B', '', 'X Y', '1ST'] })]).toEqual([
      'CODEX_HOME',
    ]);
    const { port: wildcard } = port([DAEMON], ['*']);
    await expect(wildcard.usersOf('CODEX_HOME', HOME)).rejects.toThrow('permissions.processes lists');
    await expect(wildcard.usersOf('*', HOME)).rejects.toThrow('permissions.processes lists');
  });
});

describe('processes: the value is a folder of the plugin’s own root', () => {
  test('a value outside own roots is refused: another handle, or a free-text value', async () => {
    const { port: declared } = port([DAEMON]);
    await expect(declared.usersOf('CODEX_HOME', folder(HOME_DIR, strangerRoot))).rejects.toThrow(
      'only with a folder of one of its own roots',
    );
    await expect(declared.usersOf('CODEX_HOME', SECRET as unknown as OwnFolder)).rejects.toThrow(
      'only with a folder of one of its own roots',
    );
    await expect(declared.runsFrom(DAEMON.pid, folder(HOME_DIR, strangerRoot))).rejects.toThrow('own roots');
    await expect(declared.terminate(DAEMON.pid, folder(HOME_DIR, strangerRoot))).rejects.toThrow('own roots');
  });

  test('the same handle asked by another plugin is not that plugin’s', async () => {
    const { port: other } = port([DAEMON], ['CODEX_HOME'], 'claude-code');
    await expect(other.usersOf('CODEX_HOME', HOME)).rejects.toThrow('own roots');
  });
});

describe('processes: what is answered', () => {
  test('usersOf answers the pids carrying exactly variable=<folder>, each once, in order', async () => {
    const near: TestProcess = { pid: 4500, commandLine: 'x', environment: { CODEX_HOME: `${HOME_DIR}-other` } };
    const { port: declared } = port([TUI, DAEMON, near]);
    expect(await declared.usersOf('CODEX_HOME', HOME)).toEqual([4242, 4300]);
  });

  test('another uid is never listed, never said to run from the folder, never signalled', async () => {
    const { port: declared, table } = port([STRANGER]);
    expect(await declared.usersOf('CODEX_HOME', HOME)).toEqual([]);
    expect(await declared.runsFrom(STRANGER.pid, PACKAGES)).toBe(false);
    expect(await declared.terminate(STRANGER.pid, PACKAGES)).toBe('gone');
    expect(table.signals).toEqual([]);
  });

  test('environ text never appears in any result (asserted on the JSON of every answer)', async () => {
    const { port: declared } = port([DAEMON, TUI]);
    const answers = [
      await declared.usersOf('CODEX_HOME', HOME),
      await declared.runsFrom(DAEMON.pid, PACKAGES),
      await declared.runsFrom(TUI.pid, PACKAGES),
      await declared.terminate(TUI.pid, PACKAGES),
      await declared.terminate(DAEMON.pid, PACKAGES),
    ];
    const json = JSON.stringify(answers);
    expect(json).toBe('[[4242,4300],true,false,"refused","signalled"]');
    for (const leaked of [SECRET, 'OPENAI_API_KEY', 'CODEX_HOME=', 'app-server', 'codex --tui'])
      expect(json).not.toContain(leaked);
  });

  test('a table that cannot be listed is undefined (somebody might), never an empty list', async () => {
    const table = testProcessTable({ processes: [DAEMON], listable: false });
    const declared = processesPortFor('runtimes', { environment: ['CODEX_HOME'] }, fakeSpellings, table);
    expect(await declared.usersOf('CODEX_HOME', HOME)).toBeUndefined();
    const none = processesPortFor('runtimes', { environment: ['CODEX_HOME'] }, fakeSpellings, NO_PROCESS_TABLE);
    expect(await none.usersOf('CODEX_HOME', HOME)).toBeUndefined();
    expect(await none.runsFrom(DAEMON.pid, PACKAGES)).toBe(false);
    expect(await none.terminate(DAEMON.pid, PACKAGES)).toBe('refused');
  });
});

describe('processes: terminate', () => {
  test('terminate refuses when the command line no longer has the prefix (a reused pid)', async () => {
    const reused: TestProcess = { pid: DAEMON.pid, commandLine: '/usr/bin/vim notes.txt' };
    const { port: declared, table } = port([reused]);
    expect(await declared.runsFrom(reused.pid, PACKAGES)).toBe(false);
    expect(await declared.terminate(reused.pid, PACKAGES)).toBe('refused');
    expect(table.signals).toEqual([]);
  });

  test('the prefix is the folder plus a slash: a sibling folder that shares the name is not beneath it', async () => {
    expect(runsBeneath(`${HOME_DIR}/packages/app-server-daemon/bin/codex`, [PACKAGES.path])).toBe(true);
    expect(runsBeneath(`  ${HOME_DIR}/packages/app-server-daemon/bin/codex`, [PACKAGES.path])).toBe(true);
    expect(runsBeneath(`${HOME_DIR}/packages/app-server-daemon-evil/bin/codex`, [PACKAGES.path])).toBe(false);
    expect(runsBeneath(`${HOME_DIR}/packages/app-server-daemon`, [PACKAGES.path])).toBe(false);
    expect(runsBeneath('/anything', ['/'])).toBe(false);
  });

  test('pid 1, self and parent (and every ancestor) are refused, even when they run from the folder', async () => {
    const command = DAEMON.commandLine;
    const { port: declared, table } = port([
      { pid: 1, commandLine: command },
      { pid: 1000, commandLine: command },
      { pid: 999, commandLine: command },
      { pid: 500, commandLine: command },
    ]);
    for (const pid of [0, 1, 1000, 999, 500, -5, 2.5, Number.NaN, 2 ** 40]) {
      expect({ pid, runs: await declared.runsFrom(pid, PACKAGES) }).toEqual({ pid, runs: false });
      expect({ pid, outcome: await declared.terminate(pid, PACKAGES) }).toEqual({ pid, outcome: 'refused' });
    }
    expect(table.signals).toEqual([]);
  });

  test('pid 0 and 1 are refused by the rule itself, even from a table that does not protect them', async () => {
    const table = {
      ...testProcessTable({ processes: [{ pid: 1, commandLine: DAEMON.commandLine }] }),
      protectedPids: async () => new Set<number>(),
    };
    const declared = processesPortFor('runtimes', { environment: ['CODEX_HOME'] }, fakeSpellings, table);
    for (const pid of [0, 1]) {
      expect(await declared.runsFrom(pid, PACKAGES)).toBe(false);
      expect(await declared.terminate(pid, PACKAGES)).toBe('refused');
    }
    expect(table.signals).toEqual([]);
  });

  test('a table that cannot name the daemon’s own line refuses every signal (fail closed)', async () => {
    const table = {
      ...testProcessTable({ processes: [DAEMON] }),
      protectedPids: async () => Promise.reject(new Error('no /proc')),
    };
    const declared = processesPortFor('runtimes', { environment: ['CODEX_HOME'] }, fakeSpellings, table);
    expect(await declared.terminate(DAEMON.pid, PACKAGES)).toBe('refused');
  });

  test('only SIGTERM is ever sent (spy), once, to a process that runs from the folder', async () => {
    const { port: declared, table } = port([DAEMON, TUI]);
    expect(await declared.terminate(DAEMON.pid, PACKAGES)).toBe('signalled');
    expect(await declared.terminate(DAEMON.pid, PACKAGES)).toBe('gone');
    expect(table.signals).toEqual([{ pid: DAEMON.pid, signal: 'SIGTERM' }]);
  });
});

describe('processes: the real host’s own-root check', () => {
  const parents: string[] = [];
  afterEach(async () => {
    for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
  });

  async function fleet() {
    const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-processes-`));
    parents.push(parent);
    const home = `${parent}/home`;
    await mkdir(`${home}/state`, { recursive: true, mode: 0o700 });
    const fs = nodeFs(() => crypto.randomUUID());
    expect(await ensureInternalRootBases(fs, { home, plugin: 'runtimes' }, ['fleet'])).toEqual([]);
    const roots = (plugin: string) =>
      rootsPortFor(fs, { home, plugin, worktrees: `${home}-worktrees` }, ['fleet', 'agent-homes'], () => undefined);
    const root = roots('runtimes').root('fleet');
    const at = (path: string): FencedPath => {
      const answer = root.resolve(path);
      if (!answer.ok) throw new Error(answer.error);
      return answer.value;
    };
    await root.makeDirectory(at('homes/codex-a/packages/app-server-daemon'));
    return { parent, home, root, roots, at };
  }

  test('a folder of the plugin’s own handle answers its real path; a forged path or another plugin’s handle does not', async () => {
    const f = await fleet();
    const homeFolder = f.at('homes/codex-a');
    expect(await ownFolderSpellings('runtimes', { root: f.root, path: homeFolder })).toEqual([
      `${f.home}/fleet/homes/codex-a`,
    ]);
    // the same handle asked as another plugin, a look-alike object, and a handle of another plugin
    expect(await ownFolderSpellings('claude-code', { root: f.root, path: homeFolder })).toBeUndefined();
    expect(await ownFolderSpellings('runtimes', { root: { ...f.root }, path: homeFolder })).toBeUndefined();
    const otherHandle = f.roots('claude-code').root('agent-homes');
    expect(await ownFolderSpellings('runtimes', { root: otherHandle, path: homeFolder })).toBeUndefined();
    // a forged path outside the root, and a name that is not an existing folder
    await expect(ownFolderSpellings('runtimes', { root: f.root, path: `${f.parent}` as FencedPath })).rejects.toThrow();
    await expect(ownFolderSpellings('runtimes', { root: f.root, path: f.at('homes/missing') })).rejects.toThrow();
  });

  test('an owner-root (harness-home) folder is refused, even one the caller scoped to a folder it holds', async () => {
    const f = await fleet();
    const outside = `${f.parent}/outside`;
    await mkdir(`${outside}/bin`, { recursive: true });
    const owner = rootsPortFor(
      nodeFs(() => crypto.randomUUID()),
      { home: f.home, plugin: 'runtimes', worktrees: `${f.home}-worktrees` },
      ['harness-home'],
      () => undefined,
    ).root('harness-home', { subfolder: outside });
    const resolved = owner.resolve('bin');
    if (!resolved.ok) throw new Error(resolved.error);
    expect(await ownFolderSpellings('runtimes', { root: owner, path: resolved.value })).toBeUndefined();
  });

  test('a link inside the root to a folder outside it is refused, never followed out', async () => {
    const f = await fleet();
    await mkdir(`${f.parent}/outside`);
    await symlink(`${f.parent}/outside`, `${f.home}/fleet/homes/escape`);
    await expect(ownFolderSpellings('runtimes', { root: f.root, path: f.at('homes/escape') })).rejects.toThrow();
  });

  test('a link inside the root to its own folder answers both the real path and the path as named', async () => {
    const f = await fleet();
    await symlink(`${f.home}/fleet/homes/codex-a`, `${f.home}/fleet/homes/alias`);
    expect(await ownFolderSpellings('runtimes', { root: f.root, path: f.at('homes/alias') })).toEqual([
      `${f.home}/fleet/homes/codex-a`,
      `${f.home}/fleet/homes/alias`,
    ]);
  });

  test('over the real check, usersOf matches the folder’s real path and refuses another plugin’s handle', async () => {
    const f = await fleet();
    const real = `${f.home}/fleet/homes/codex-a`;
    const table = testProcessTable({ processes: [{ pid: 4242, commandLine: 'x', environment: { CODEX_HOME: real } }] });
    const declared: ProcessesPort = processesPortFor(
      'runtimes',
      { environment: ['CODEX_HOME'] },
      ownFolderSpellings,
      table,
    );
    expect(await declared.usersOf('CODEX_HOME', { root: f.root, path: f.at('homes/codex-a') })).toEqual([4242]);
    const otherHandle = f.roots('claude-code').root('agent-homes');
    await expect(declared.usersOf('CODEX_HOME', { root: otherHandle, path: f.at('homes/codex-a') })).rejects.toThrow(
      'own roots',
    );
  });
});
