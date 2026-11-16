/**
 * The Codex harness on the shared history pool, over the REAL kernel roots: a launch links the history entries and runs
 * Codex with `CODEX_SQLITE_HOME` in the pool; a ferret that already holds a real `sessions` folder has it merged in; and a
 * pooling that cannot be made lets the launch go on unpooled, with no `CODEX_SQLITE_HOME` and one sentence.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaunchRefusal, type LaunchSpec, type Runner, type RunSpec } from '@ferretry/core-ferrets/contract';
import type { FencedPath, FerretId, KernelPorts, RootsPort } from '@ferretry/kernel/contract';
import { nodeFs, rootsPortFor, state } from '@ferretry/kernel/host';
import { instantFromEpochMs, ok } from '@ferretry/std';
import { ensureInternalRootBases } from '../../../../core/kernel/host/roots.ts';
import {
  CODEX_AGENT_HOMES,
  CODEX_HISTORY_ENTRIES,
  CODEX_HISTORY_POOL,
  CODEX_LAUNCH_SETTINGS,
  CODEX_ROLLOUTS,
} from '../../contract/index.ts';
import { codexHarness } from '../../daemon/adapters/codex-harness.ts';
import { selectEverything } from '../support/selected.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const LOCATED = {
  outcome: 'located',
  path: '/opt/bin/codex',
  rule: 'inherited environment',
  declaredBy: 'PATH',
} as const;

async function world(
  options: {
    pooled?: boolean;
    beforeMove?: (from: FencedPath, to: FencedPath) => void | Promise<void>;
    afterMove?: () => void;
    refuseSqlite?: boolean;
  } = {},
) {
  const parent = await mkdtemp(join(tmpdir(), 'ferretry-codex-harness-pool-'));
  parents.push(parent);
  const home = join(parent, 'fy');
  const agent = (ferret: string) => join(home, 'state', 'codex', 'agent-homes', ferret);
  const pool = (...parts: string[]) => join(home, 'state', 'codex', 'history-pool', ...parts);
  await mkdir(join(home, 'state/codex/agent-homes'), { recursive: true });
  for (const folder of ['', 'state', 'state/codex', 'state/codex/agent-homes']) await chmod(join(home, folder), 0o700);
  const permission = { state: CODEX_HISTORY_POOL.name, entries: CODEX_HISTORY_ENTRIES };
  const pooling = {
    historyPool: permission,
    stateFiles: [CODEX_AGENT_HOMES, CODEX_HISTORY_POOL],
  };
  const fs = nodeFs(() => crypto.randomUUID());
  if (options.pooled !== false)
    await ensureInternalRootBases(fs, { home, plugin: 'codex' }, ['agent-homes', 'harness-history'], pooling);
  const realRoots = rootsPortFor(
    fs,
    { home, plugin: 'codex', worktrees: join(parent, 'worktrees') },
    ['agent-homes', 'harness-history'],
    () => undefined,
    { hardLinkRoots: [], ...(options.pooled === false ? {} : pooling) },
  );
  const moves: { from: FencedPath; to: FencedPath }[] = [];
  const roots: RootsPort = {
    ...realRoots,
    historyPool: () => {
      const root = realRoots.historyPool();
      if (!options.refuseSqlite) return root;
      return {
        ...root,
        async makeDirectory(path, options) {
          if (path === pool('sqlite')) throw new Error('synthetic shared SQLite folder refusal');
          await root.makeDirectory(path, options);
        },
      };
    },
    root: (name, scope) => {
      const home = realRoots.root(name, scope);
      if (name !== 'agent-homes') return home;
      return {
        ...home,
        async moveToHistoryPool(from, pool, to) {
          moves.push({ from, to });
          await options.beforeMove?.(from, to);
          await home.moveToHistoryPool(from, pool, to);
          options.afterMove?.();
        },
      };
    },
  };
  const said: string[] = [];
  const kernel = {
    roots,
    state: state.createStatePort({
      home,
      pluginId: 'codex',
      files: [CODEX_ROLLOUTS, CODEX_LAUNCH_SETTINGS],
      fs: state.createNodeHostFs(),
    }),
    log: { warn: (message: string) => void said.push(message) },
    clock: { now: () => instantFromEpochMs(Date.parse('2026-11-16T12:00:00Z')), sleep: async () => undefined },
    redaction: { read: async (fn: (scope: { text(s: string): string }) => unknown) => await fn({ text: s => s }) },
  } as unknown as KernelPorts;
  const harness = codexHarness({
    selected: selectEverything,
    kernel,
    locate: async () => LOCATED,
    probe: { version: async () => ({ state: 'ok', version: '0.166.0' }), startup: async () => ({ ok: true }) } as never,
    update: { view: async () => undefined, start: async () => undefined, settled: async () => undefined } as never,
  });
  const seen: RunSpec[] = [];
  const runner = {
    key: 'tmux',
    start: async (spec: RunSpec) => {
      seen.push(spec);
      return ok({ handle: '%1', startedAt: '2026-11-16T12:00:00.000Z' });
    },
    resume: async (spec: RunSpec) => {
      seen.push(spec);
      return ok({ handle: '%1', startedAt: '2026-11-16T12:00:00.000Z' });
    },
    stop: async () => undefined,
  } as unknown as Runner;
  const specOf = (ferret: string): LaunchSpec =>
    ({
      ferret: ferret as FerretId,
      name: ferret,
      role: 'worker',
      harness: 'codex',
      folder: '/work/project' as FencedPath,
      home: agent(ferret) as FencedPath,
      instructions: [],
      parts: [],
    }) as unknown as LaunchSpec;
  return { harness, runner, seen, said, agent, pool, specOf, moves, parent };
}

const exists = async (path: string) => (await lstat(path).catch(() => undefined)) !== undefined;

describe('the Codex harness and the shared history pool', () => {
  test('a launch links sessions, archived_sessions and history.jsonl to the pool and runs Codex on the pool’s SQLite folder', async () => {
    const w = await world();
    const started = await w.harness.start(w.specOf('f1'), w.runner, {} as never);
    expect(started.ok).toBe(true);
    for (const { name } of CODEX_HISTORY_ENTRIES)
      expect((await lstat(join(w.agent('f1'), name))).isSymbolicLink()).toBe(true);
    // Not a history entry: the ferret's own.
    expect((await lstat(join(w.agent('f1'), 'config.toml')).catch(() => undefined))?.isSymbolicLink()).not.toBe(true);
    const command = w.seen[0]?.command ?? [];
    expect(command.slice(0, 3)).toEqual([
      'env',
      `CODEX_HOME=${w.agent('f1')}`,
      `CODEX_SQLITE_HOME=${w.pool('sqlite')}`,
    ]);
    expect((await stat(w.pool('sqlite'))).isDirectory()).toBe(true);
    expect(w.said).toEqual([]);
  });

  test('a ferret that already holds a real sessions folder has it moved into the pool, and the other ferret reads it', async () => {
    const w = await world();
    await mkdir(join(w.agent('f1'), 'sessions/2026/11/16'), { recursive: true });
    await writeFile(join(w.agent('f1'), 'sessions/2026/11/16/rollout-a.jsonl'), 'from f1\n');
    await w.harness.prepareHome(w.specOf('f1'));
    await w.harness.prepareHome(w.specOf('f2'));
    expect(await readFile(w.pool('sessions/2026/11/16/rollout-a.jsonl'), 'utf8')).toBe('from f1\n');
    expect(await readFile(join(w.agent('f2'), 'sessions/2026/11/16/rollout-a.jsonl'), 'utf8')).toBe('from f1\n');
    expect(w.said.filter(message => message.includes('history'))).toEqual([]);
  });

  test('with no pool the launch goes on unpooled: no CODEX_SQLITE_HOME, nothing linked, one sentence', async () => {
    const w = await world({ pooled: false });
    const started = await w.harness.start(w.specOf('f1'), w.runner, {} as never);
    expect(started.ok).toBe(true);
    expect(w.seen[0]?.command.some(part => part.startsWith('CODEX_SQLITE_HOME='))).toBe(false);
    expect((await lstat(join(w.agent('f1'), 'sessions')).catch(() => undefined))?.isSymbolicLink()).not.toBe(true);
    expect(w.said.filter(message => message.includes('its own history'))).toHaveLength(1);
  });

  for (const unsafe of ['hardlink', 'stale symlink'] as const) {
    test(`preflight finds a nested ${unsafe} after a valid rollout before any move, then resumes with its own history`, async () => {
      const w = await world();
      const directory = join(w.agent('f1'), 'sessions/2026/11/16');
      await mkdir(join(directory, 'z-nested'), { recursive: true });
      await mkdir(w.pool('sessions/2026/11/16/z-nested'), { recursive: true });
      const id = '019fab95-c49a-7843-b42f-40a6390eefc3';
      const relative = `sessions/2026/11/16/rollout-2026-11-16T09-00-00-${id}.jsonl`;
      const rollout = join(w.agent('f1'), relative);
      await writeFile(rollout, 'the original conversation\n');
      const unsafePath = join(directory, 'z-nested/unsafe.jsonl');
      if (unsafe === 'hardlink') {
        const other = join(w.parent, 'synthetic-shared-file');
        await writeFile(other, 'synthetic linked bytes\n');
        await link(other, unsafePath);
      } else await symlink('missing-local.jsonl', unsafePath);
      await w.harness.prepareHome(w.specOf('f1'));
      expect(w.moves).toEqual([]);
      expect(await readFile(rollout, 'utf8')).toBe('the original conversation\n');
      expect(await exists(w.pool(relative))).toBe(false);
      expect((await lstat(join(w.agent('f1'), 'sessions'))).isDirectory()).toBe(true);
      expect(w.said.join('\n')).toContain(unsafe === 'hardlink' ? 'hard_link' : 'link_escape');
      const resumed = await w.harness.resume(w.specOf('f1'), w.runner, {} as never, id);
      expect(resumed.ok).toBe(true);
      expect(w.seen).toHaveLength(1);
      expect(w.seen[0]?.command).toContain(id);
      expect(w.seen[0]?.command.some(part => part.startsWith('CODEX_SQLITE_HOME='))).toBe(false);
      expect(w.moves).toEqual([]);
      expect(await readFile(rollout, 'utf8')).toBe('the original conversation\n');
      expect(await exists(join(w.agent('f1'), '.history-pool-pending-sessions'))).toBe(false);
    });
  }

  test('a rollout backup name containing @ is pooled intact', async () => {
    const w = await world();
    const relative = 'sessions/2026/11/16/rollout-a.jsonl@backup';
    await mkdir(join(w.agent('f1'), 'sessions/2026/11/16'), { recursive: true });
    await writeFile(join(w.agent('f1'), relative), 'backup conversation\n');
    await w.harness.prepareHome(w.specOf('f1'));
    expect(await readFile(w.pool(relative), 'utf8')).toBe('backup conversation\n');
    expect((await lstat(join(w.agent('f1'), 'sessions'))).isSymbolicLink()).toBe(true);
    expect(w.said.filter(message => message.includes('history'))).toEqual([]);
  });

  test('concurrent homes with the same date and filename preserve both rollouts using conflicts', async () => {
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let target: string | undefined;
    const w = await world({
      beforeMove: async (_from, to) => {
        if (to !== target) return;
        if (++arrived === 2) release();
        await gate;
      },
    });
    const relative = 'sessions/2026/11/16/rollout-same.jsonl';
    target = w.pool(relative);
    await mkdir(w.pool('sessions/2026/11/16'), { recursive: true });
    for (const ferret of ['f1', 'f2']) {
      await mkdir(join(w.agent(ferret), 'sessions/2026/11/16'), { recursive: true });
      await writeFile(join(w.agent(ferret), relative), `from ${ferret}\n`);
    }
    await Promise.all([w.harness.prepareHome(w.specOf('f1')), w.harness.prepareHome(w.specOf('f2'))]);
    expect(arrived).toBe(2);
    const kept = [await readFile(w.pool(relative), 'utf8')];
    for (const ferret of ['f1', 'f2']) {
      const conflict = await readFile(w.pool(`.conflicts/${ferret}/${relative}`), 'utf8').catch(() => undefined);
      if (conflict !== undefined) kept.push(conflict);
      expect((await lstat(join(w.agent(ferret), 'sessions'))).isSymbolicLink()).toBe(true);
    }
    expect(kept.sort()).toEqual(['from f1\n', 'from f2\n']);
    expect(w.said.join('\n')).toContain('kept in the pool');
  });

  for (const existingJournal of [false, true]) {
    test(`an own history.jsonl is kept whole in conflicts when the pooled journal ${existingJournal ? 'exists' : 'is absent'}`, async () => {
      const w = await world();
      await mkdir(w.agent('f1'), { recursive: true });
      await writeFile(join(w.agent('f1'), 'history.jsonl'), 'own journal\n');
      if (existingJournal) await writeFile(w.pool('history.jsonl'), 'pooled journal\n');
      await w.harness.prepareHome(w.specOf('f1'));
      expect(await readFile(w.pool('history.jsonl'), 'utf8')).toBe(existingJournal ? 'pooled journal\n' : '');
      expect(await readFile(w.pool('.conflicts/f1/history.jsonl'), 'utf8')).toBe('own journal\n');
      expect((await lstat(join(w.agent('f1'), 'history.jsonl'))).isSymbolicLink()).toBe(true);
    });
  }

  for (const blockedRetry of [false, true]) {
    test(`a second move fault refuses launch and ${blockedRetry ? 'a later zero-move preflight refusal keeps the pending marker until retry' : 'the next launch retries to completion'}`, async () => {
      let attempts = 0;
      const w = await world({
        beforeMove: () => {
          if (++attempts === 2) throw new Error('synthetic second-move fault');
        },
      });
      const directory = join(w.agent('f1'), 'sessions/2026/11/16');
      await mkdir(directory, { recursive: true });
      await mkdir(w.pool('sessions/2026/11/16'), { recursive: true });
      await writeFile(join(directory, 'a.jsonl'), 'first conversation\n');
      await writeFile(join(directory, 'b.jsonl'), 'second conversation\n');
      const start = () => w.harness.start(w.specOf('f1'), w.runner, {} as never);
      await expect(start()).rejects.toBeInstanceOf(LaunchRefusal);
      expect(w.seen).toEqual([]);
      expect(attempts).toBe(2);
      expect(await readFile(w.pool('sessions/2026/11/16/a.jsonl'), 'utf8')).toBe('first conversation\n');
      expect(await readFile(join(directory, 'b.jsonl'), 'utf8')).toBe('second conversation\n');
      const marker = join(w.agent('f1'), '.history-pool-pending-sessions');
      expect(await exists(marker)).toBe(true);
      if (blockedRetry) {
        const stale = join(directory, 'z-stale.jsonl');
        await symlink('missing-local.jsonl', stale);
        await expect(start()).rejects.toBeInstanceOf(LaunchRefusal);
        expect(w.seen).toEqual([]);
        expect(attempts).toBe(2);
        expect(await exists(marker)).toBe(true);
        expect(await readFile(join(directory, 'b.jsonl'), 'utf8')).toBe('second conversation\n');
        await rm(stale);
      }
      expect((await start()).ok).toBe(true);
      expect(w.seen).toHaveLength(1);
      expect(await readFile(w.pool('sessions/2026/11/16/a.jsonl'), 'utf8')).toBe('first conversation\n');
      expect(await readFile(w.pool('sessions/2026/11/16/b.jsonl'), 'utf8')).toBe('second conversation\n');
      expect((await lstat(join(w.agent('f1'), 'sessions'))).isSymbolicLink()).toBe(true);
      expect(w.seen[0]?.command).toContain(`CODEX_SQLITE_HOME=${w.pool('sqlite')}`);
      expect(await exists(marker)).toBe(false);
    });
  }

  test('a first move that lands then rejects refuses launch, and retry links the preserved rollout and resumes', async () => {
    let failOnce = true;
    const w = await world({
      afterMove: () => {
        if (!failOnce) return;
        failOnce = false;
        throw new Error('synthetic rejection after the real move landed');
      },
    });
    const id = '019fab95-c49a-7843-b42f-40a6390eefc3';
    const relative = `sessions/2026/11/16/rollout-2026-11-16T09-00-00-${id}.jsonl`;
    await mkdir(join(w.agent('f1'), 'sessions/2026/11/16'), { recursive: true });
    await writeFile(join(w.agent('f1'), relative), 'the original conversation\n');
    const resume = () => w.harness.resume(w.specOf('f1'), w.runner, {} as never, id);
    await expect(resume()).rejects.toBeInstanceOf(LaunchRefusal);
    expect(w.seen).toEqual([]);
    expect(w.moves).toHaveLength(1);
    expect(await exists(join(w.agent('f1'), relative))).toBe(false);
    expect(await readFile(w.pool(relative), 'utf8')).toBe('the original conversation\n');
    const marker = join(w.agent('f1'), '.history-pool-pending-sessions');
    expect(await exists(marker)).toBe(true);
    expect((await resume()).ok).toBe(true);
    expect(w.seen).toHaveLength(1);
    expect(w.seen[0]?.command).toContain(id);
    expect(w.seen[0]?.command).toContain(`CODEX_SQLITE_HOME=${w.pool('sqlite')}`);
    expect(w.moves).toHaveLength(1);
    expect((await lstat(join(w.agent('f1'), 'sessions'))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(w.agent('f1'), relative), 'utf8')).toBe('the original conversation\n');
    expect(await exists(marker)).toBe(false);
  });

  for (const operation of ['prepareHome', 'start'] as const) {
    test(`${operation} refuses when sessions are pooled but shared SQLite cannot be made, preserving the stale own database`, async () => {
      const w = await world({ refuseSqlite: true });
      const localSqlite = join(w.agent('f1'), 'sqlite/state_5.sqlite');
      await mkdir(join(w.agent('f1'), 'sqlite'), { recursive: true });
      await writeFile(localSqlite, 'synthetic stale local database\n');
      const launch =
        operation === 'prepareHome'
          ? w.harness.prepareHome(w.specOf('f1'))
          : w.harness.start(w.specOf('f1'), w.runner, {} as never);
      await expect(launch).rejects.toBeInstanceOf(LaunchRefusal);
      expect(w.seen).toEqual([]);
      expect((await lstat(join(w.agent('f1'), 'sessions'))).isSymbolicLink()).toBe(true);
      expect(await readFile(localSqlite, 'utf8')).toBe('synthetic stale local database\n');
      expect(w.said.join('\n')).not.toContain('goes on with its own Codex database');
    });
  }

  test('historySources exposes pooled rollouts once through read-only entries, stat and read', async () => {
    const w = await world();
    await w.harness.prepareHome(w.specOf('f1'));
    await w.harness.prepareHome(w.specOf('f2'));
    const relative = 'sessions/2026/11/16/rollout-pooled.jsonl';
    const text = 'pooled conversation\n';
    await mkdir(join(w.agent('f1'), 'sessions/2026/11/16'), { recursive: true });
    await writeFile(join(w.agent('f1'), relative), text);
    if (w.harness.historySources === undefined) throw new Error('the harness does not offer history sources');
    const sources = await w.harness.historySources();
    const pools = sources.filter(source => source.kind === 'pool');
    expect(pools).toHaveLength(1);
    const source = pools[0];
    if (source === undefined) throw new Error('the pool history source is missing');
    expect(source.label).toBe('pool');
    expect(Object.keys(source.files).sort()).toEqual(['entries', 'read', 'stat']);
    expect((await source.files.entries('sessions/2026/11/16')).map(entry => entry.name)).toEqual([
      'rollout-pooled.jsonl',
    ]);
    expect((await source.files.stat(relative))?.size).toBe(Buffer.byteLength(text));
    expect(new TextDecoder().decode(await source.files.read(relative, 0, Buffer.byteLength(text)))).toBe(text);
    const homes = sources.filter(source => source.kind === 'ferret-home');
    expect(homes).toHaveLength(2);
    for (const home of homes) {
      expect(await home.files.entries('sessions/2026/11/16')).toEqual([]);
      expect(await home.files.stat(relative)).toBeUndefined();
      expect(await home.files.read(relative, 0, Buffer.byteLength(text))).toBeUndefined();
    }
  });
});
