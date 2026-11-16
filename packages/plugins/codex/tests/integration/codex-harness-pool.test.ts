/**
 * The Codex harness on the shared history pool, over the REAL kernel roots: a launch links the history entries and runs
 * Codex with `CODEX_SQLITE_HOME` in the pool; a ferret that already holds a real `sessions` folder has it merged in; and a
 * pooling that cannot be made lets the launch go on unpooled, with no `CODEX_SQLITE_HOME` and one sentence.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchSpec, Runner, RunSpec } from '@ferretry/core-ferrets/contract';
import type { FencedPath, FerretId, KernelPorts } from '@ferretry/kernel/contract';
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

async function world(options: { pooled?: boolean } = {}) {
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
  const roots = rootsPortFor(
    fs,
    { home, plugin: 'codex', worktrees: join(parent, 'worktrees') },
    ['agent-homes', 'harness-history'],
    () => undefined,
    { hardLinkRoots: [], ...(options.pooled === false ? {} : pooling) },
  );
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
    start: async (spec: RunSpec) => (seen.push(spec), ok({ handle: '%1', startedAt: '2026-11-16T12:00:00.000Z' })),
    resume: async (spec: RunSpec) => (seen.push(spec), ok({ handle: '%1', startedAt: '2026-11-16T12:00:00.000Z' })),
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
  return { harness, runner, seen, said, agent, pool, specOf };
}

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
});
