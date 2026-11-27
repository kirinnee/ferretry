/**
 * The Codex harness over the REAL kernel roots in a temp folder, for the relocation tests: two ferrets (`f1` the source,
 * `f2` the target) on one shared history pool, and a builder of SYNTHETIC rollouts in the shape the tested Codex
 * writers emit. Nothing here is a person's: every word, id and folder is made up.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { selectEverything } from './selected.ts';

export const SOURCE_ID = '019fab95-c49a-7843-b42f-40a6390eefc3';
export const SOURCE_FOLDER = '/work/source-tree';
export const TARGET_FOLDER = '/work/target-tree';
const DAY = '2026/11/16';
export const rolloutPath = (id: string): string => `sessions/${DAY}/rollout-2026-11-16T09-00-00-${id}.jsonl`;

/** One line; `self` is the conversation id the writer also puts on the record itself (newer writers do). */
const line = (type: string, payload: unknown, self?: string): string =>
  JSON.stringify({
    timestamp: '2026-11-16T09:00:00.000Z',
    ...(self === undefined ? {} : { session_id: self }),
    type,
    payload,
  });

/**
 * A rollout the way the tested writers emit one: the header, the world state, a turn context, then `turns` turns of one
 * user message and one answer each. `marker` is the source home's correlation path (the `--add-dir` every launch passes).
 */
export function syntheticRollout(options: {
  id: string;
  folder: string;
  home: string;
  version?: string;
  turns?: number;
  /** Extra records, each already a JSON line, placed before the first turn. */
  extra?: readonly string[];
}): string {
  const { id, folder, home } = options;
  const marker = `${home}/codex-correlation/unreachable`;
  const lines = [
    line('session_meta', {
      id,
      session_id: id,
      cwd: folder,
      cli_version: options.version ?? '0.166.0',
      runtime_workspace_roots: [marker],
    }),
    line('world_state', {
      state: {
        environments: {
          environments: { local: { cwd: folder } },
          filesystem: `<environment><cwd>${folder}</cwd><root>${folder}/src</root></environment>`,
        },
      },
    }),
    ...(options.extra ?? []),
  ];
  for (let turn = 1; turn <= (options.turns ?? 2); turn++) {
    lines.push(
      line(
        'turn_context',
        {
          cwd: folder,
          workspace_roots: [folder, marker],
          sandbox_policy: { cwd: folder, writable_roots: [folder] },
        },
        id,
      ),
      line('event_msg', { type: 'task_started', turn_id: `turn-${turn}` }, id),
      line('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `<environment_context><cwd>${folder}</cwd></environment_context>` }],
      }),
      line('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `SYNTHETIC_QUESTION_${turn}` }],
      }),
      line('event_msg', { type: 'user_message', message: `SYNTHETIC_QUESTION_${turn}` }, id),
      line('response_item', {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `SYNTHETIC_ANSWER_${turn}` }],
      }),
      line('event_msg', { type: 'agent_message', message: `SYNTHETIC_ANSWER_${turn}` }, id),
      line(
        'event_msg',
        { type: 'task_complete', turn_id: `turn-${turn}`, last_agent_message: `SYNTHETIC_ANSWER_${turn}` },
        id,
      ),
    );
  }
  return `${lines.join('\n')}\n`;
}

const LOCATED = {
  outcome: 'located',
  path: '/opt/bin/codex',
  rule: 'inherited environment',
  declaredBy: 'PATH',
} as const;

export async function relocationWorld(options: { pooled?: boolean } = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'ferretry-codex-relocate-'));
  const home = join(parent, 'fy');
  const agent = (ferret: string) => join(home, 'state', 'codex', 'agent-homes', ferret);
  const pool = (...parts: string[]) => join(home, 'state', 'codex', 'history-pool', ...parts);
  await mkdir(join(home, 'state/codex/agent-homes'), { recursive: true });
  for (const folder of ['', 'state', 'state/codex', 'state/codex/agent-homes']) await chmod(join(home, folder), 0o700);
  const pooling = {
    historyPool: { state: CODEX_HISTORY_POOL.name, entries: CODEX_HISTORY_ENTRIES },
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
  const kernel = {
    roots,
    state: state.createStatePort({
      home,
      pluginId: 'codex',
      files: [CODEX_ROLLOUTS, CODEX_LAUNCH_SETTINGS],
      fs: state.createNodeHostFs(),
    }),
    log: { warn: () => undefined },
    clock: {
      after: () => () => undefined,
      now: () => instantFromEpochMs(Date.parse('2026-11-16T12:00:00Z')),
      sleep: async () => undefined,
    },
    redaction: { read: async (fn: (scope: { text(s: string): string }) => unknown) => await fn({ text: s => s }) },
  } as unknown as KernelPorts;
  const harness = codexHarness({
    selected: selectEverything,
    kernel,
    locate: async () => LOCATED,
    probe: { version: async () => ({ state: 'ok', version: '0.166.0' }), startup: async () => ({ ok: true }) } as never,
    update: { view: async () => undefined, start: async () => undefined, settled: async () => undefined } as never,
  });
  const runner = {
    key: 'tmux',
    start: async (_spec: RunSpec) => ok({ handle: '%1', startedAt: '2026-11-16T12:00:00.000Z' }),
    resume: async (_spec: RunSpec) => ok({ handle: '%1', startedAt: '2026-11-16T12:00:00.000Z' }),
    stop: async () => undefined,
  } as unknown as Runner;
  const specOf = (ferret: string, folder: string): LaunchSpec =>
    ({
      ferret: ferret as FerretId,
      name: ferret,
      role: 'worker',
      harness: 'codex',
      folder: folder as FencedPath,
      home: agent(ferret) as FencedPath,
      instructions: [],
      parts: [],
    }) as unknown as LaunchSpec;
  /** The source ferret, launched (so its sessions are pooled and the launch is bound), with one rollout written the way Codex writes it. */
  const source = async (
    text: (id: string, home: string) => string = (id, h) => syntheticRollout({ id, folder: SOURCE_FOLDER, home: h }),
  ) => {
    const spec = specOf('f1', SOURCE_FOLDER);
    const started = await harness.start(spec, runner, {} as never);
    if (!started.ok) throw new Error('the source ferret did not start');
    const file = join(agent('f1'), rolloutPath(SOURCE_ID));
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, text(SOURCE_ID, agent('f1')));
    return { spec, file };
  };
  return {
    harness,
    runner,
    agent,
    pool,
    specOf,
    source,
    home,
    parent,
    cleanup: async () => await rm(parent, { recursive: true, force: true }),
  };
}
