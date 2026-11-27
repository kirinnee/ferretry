/**
 * Forking a Codex conversation (`Harness.fork`) over the REAL kernel roots in a temp folder: a rollout this test writes
 * is cut at a turn into a NEW rollout in the shared pool. Synthetic rollouts only; no `~/.codex`, no sign-in, no network.
 * What is proved: the cut has exactly the turns asked for under a fresh id, a new ferret can resume it, the source is
 * byte-identical (and its own proof still holds), an unseen rollout format is refused with nothing written, and `discard`
 * takes back only the file the fork made.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LaunchSpec, poolHomeHistory } from '@ferretry/core-ferrets/contract';
import type { FencedPath, FerretId, KernelPorts } from '@ferretry/kernel/contract';
import { nodeFs, rootsPortFor, state } from '@ferretry/kernel/host';
import { ensureInternalRootBases } from '../../../../core/kernel/host/roots.ts';
import { instantFromEpochMs } from '@ferretry/std';
import { CODEX_AGENT_HOMES, CODEX_HISTORY_ENTRIES, CODEX_HISTORY_POOL, CODEX_ROLLOUTS } from '../../contract/index.ts';
import { CodexRollouts } from '../../daemon/adapters/rollouts.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const line = (type: string, payload: unknown) =>
  `${JSON.stringify({ timestamp: '2026-11-27T09:00:00.000Z', type, payload })}\n`;
const header = (id: string, marker: string, cli = '0.145.0') =>
  line('session_meta', {
    id,
    cwd: '/work/source',
    ...(cli === '' ? {} : { cli_version: cli }),
    runtime_workspace_roots: [`${marker}/codex-correlation/unreachable`],
  });
const asked = (text: string) => line('event_msg', { type: 'user_message', message: text });
const said = (text: string) =>
  line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
/** A synthetic conversation of `turns` turns: `asked 1`, `said 1`, `asked 2`, … */
const conversation = (id: string, marker: string, turns: number, cli?: string) =>
  header(id, marker, cli) +
  Array.from({ length: turns }, (_, index) => asked(`asked ${index + 1}`) + said(`said ${index + 1}`)).join('');

const A = '019fab95-c49a-7843-b42f-40a6390eefc3';
const NOW = Date.parse('2026-11-27T12:00:00.000Z');
const nameOf = (id: string, day = '2026/11/27') =>
  `sessions/${day}/rollout-${day.replaceAll('/', '-')}T09-00-00-${id}.jsonl`;
const INTO = { folder: '/work/forked-worktree' };

async function world() {
  const parent = await mkdtemp(join(tmpdir(), 'ferretry-codex-fork-'));
  parents.push(parent);
  const home = join(parent, 'fy');
  const agent = (ferret: string) => join(home, 'state', 'codex', 'agent-homes', ferret);
  const pool = (...parts: string[]) => join(home, 'state', 'codex', 'history-pool', ...parts);
  for (const folder of ['', 'state', 'state/codex'])
    await mkdir(join(home, folder), { recursive: true, mode: 0o700 }).then(() => chmod(join(home, folder), 0o700));
  await mkdir(join(home, 'state/codex/agent-homes'), { recursive: true, mode: 0o700 });
  await chmod(join(home, 'state/codex/agent-homes'), 0o700);
  const pooling = {
    historyPool: { state: CODEX_HISTORY_POOL.name, entries: CODEX_HISTORY_ENTRIES },
    stateFiles: [CODEX_AGENT_HOMES, CODEX_HISTORY_POOL],
  };
  await ensureInternalRootBases(
    nodeFs(() => crypto.randomUUID()),
    { home, plugin: 'codex' },
    ['agent-homes', 'harness-history'],
    pooling,
  );
  for (const ferret of ['f1', 'f2']) await mkdir(agent(ferret), { recursive: true, mode: 0o700 });
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home, plugin: 'codex', worktrees: join(parent, 'worktrees') },
    ['agent-homes', 'harness-history'],
    () => undefined,
    { hardLinkRoots: [], ...pooling },
  );
  const port = state.createStatePort({
    home,
    pluginId: 'codex',
    files: [CODEX_ROLLOUTS],
    fs: state.createNodeHostFs(),
  });
  const kernel = {
    roots,
    state: port,
    redaction: { read: async (fn: (scope: { text(s: string): string }) => unknown) => await fn({ text: s => s }) },
    clock: { after: () => () => undefined, now: () => instantFromEpochMs(NOW), sleep: async () => undefined },
  } as unknown as KernelPorts;
  const rollouts = new CodexRollouts(kernel, async () => undefined);
  const specOf = (ferret: string): LaunchSpec =>
    ({ ferret: ferret as FerretId, home: agent(ferret) as FencedPath }) as LaunchSpec;
  for (const ferret of ['f1', 'f2']) {
    const result = await poolHomeHistory({ roots, ferret: ferret as FerretId, entries: CODEX_HISTORY_ENTRIES });
    expect(result.sentence).toBeUndefined();
  }
  /** The source: f1 launched, and Codex wrote its rollout through its own `sessions` link into the pool. */
  const source = async (text: (marker: string) => string) => {
    await rollouts.launched(specOf('f1'));
    await mkdir(join(agent('f1'), nameOf(A), '..'), { recursive: true });
    await writeFile(join(agent('f1'), nameOf(A)), text(agent('f1')));
    return pool(nameOf(A));
  };
  /** Every file under the whole state folder, with its bytes: what a fork may and may not change. */
  const everything = async (): Promise<Record<string, string>> => {
    const found: Record<string, string> = {};
    const walk = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) found[path] = await readFile(path, 'utf8');
      }
    };
    await walk(join(home, 'state/codex/history-pool'));
    return found;
  };
  return { rollouts, agent, pool, specOf, source, everything };
}

const turnsOf = (text: string): string[] =>
  text
    .split('\n')
    .filter(row => row.includes('"user_message"'))
    .map(row => JSON.parse(row).payload.message as string);

describe('forking a Codex conversation', () => {
  test('a cut at turn 3 of 5 holds turns 1..3 under a fresh id, keyed to the new folder, and a new ferret can resume it', async () => {
    const w = await world();
    const file = await w.source(marker => conversation(A, marker, 5));
    const plan = await w.rollouts.fork('f1' as FerretId, { turn: 3 }, INTO);

    expect(plan.harnessConversation).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    expect(plan.harnessConversation).not.toBe(A);
    expect(plan.at).toEqual({ turn: 3 });
    const made = (await w.everything())[
      w.pool('sessions/2026/11/27', `rollout-2026-11-27T12-00-00-${plan.harnessConversation}.jsonl`)
    ];
    expect(made).toBeDefined();
    expect(turnsOf(made as string)).toEqual(['asked 1', 'asked 2', 'asked 3']);
    expect(made).toContain('said 3');
    expect(made).not.toContain('asked 4');
    const head = JSON.parse((made as string).split('\n')[0] as string);
    expect(head.payload).toMatchObject({ id: plan.harnessConversation, cwd: INTO.folder, cli_version: '0.145.0' });
    // `codex resume <new id>` is gated on the conversation being in the ferret's history: f2 (a new ferret) finds it.
    expect(await w.rollouts.has('f2' as FerretId, plan.harnessConversation)).toBe(true);
    await w.rollouts.launched(w.specOf('f2'), plan.harnessConversation);
    expect((await w.rollouts.transcript.read('f2' as FerretId)).map(entry => entry.text)).toContain('said 3');
    expect(await readFile(file, 'utf8')).toBe(conversation(A, w.agent('f1'), 5));
  });

  test('the source is byte-identical, unmoved and still the ferret’s own proved conversation', async () => {
    const w = await world();
    const file = await w.source(marker => conversation(A, marker, 4));
    const before = { bytes: await readFile(file), stat: await stat(file), tree: await w.everything() };
    const plan = await w.rollouts.fork('f1' as FerretId, { turn: 2 }, INTO);

    expect(await readFile(file)).toEqual(before.bytes);
    const after = await stat(file);
    expect([after.mtimeMs, after.size, after.ino]).toEqual([before.stat.mtimeMs, before.stat.size, before.stat.ino]);
    expect(Object.keys(await w.everything()).sort()).toEqual(
      [...Object.keys(before.tree), expect.stringContaining(plan.harnessConversation)].sort(),
    );
    // The copy carries no marker of the source's home, so the source still proves exactly one rollout.
    expect(await w.rollouts.provedConversation('f1' as FerretId)).toMatchObject({ id: A });
    expect((await w.rollouts.transcript.read('f1' as FerretId)).map(entry => entry.text)).toContain('said 4');
  });

  test('no turn named forks the whole conversation', async () => {
    const w = await world();
    await w.source(marker => conversation(A, marker, 3));
    const plan = await w.rollouts.fork('f1' as FerretId, undefined, INTO);
    expect(plan.at).toBeUndefined();
    const made = Object.entries(await w.everything()).find(([path]) => path.includes(plan.harnessConversation));
    expect(turnsOf(made?.[1] ?? '')).toEqual(['asked 1', 'asked 2', 'asked 3']);
  });

  test('a turn the conversation does not have refuses and writes nothing', async () => {
    const w = await world();
    await w.source(marker => conversation(A, marker, 3));
    const before = await w.everything();
    for (const turn of [0, 4, 1.5])
      await expect(w.rollouts.fork('f1' as FerretId, { turn }, INTO)).rejects.toThrow(/is not in this conversation/u);
    expect(await w.everything()).toEqual(before);
  });

  test('a rollout written by a Codex Ferretry has not tested, or by none it can name, is refused and nothing is written', async () => {
    for (const cli of ['9.0.0', '0.200.1', '']) {
      const w = await world();
      await w.source(marker => conversation(A, marker, 3, cli));
      const before = await w.everything();
      await expect(w.rollouts.fork('f1' as FerretId, { turn: 2 }, INTO)).rejects.toThrow(/has not tested/u);
      expect(await w.everything()).toEqual(before);
    }
  });

  test('a ferret with no conversation of its own yet refuses', async () => {
    const w = await world();
    await w.rollouts.launched(w.specOf('f1'));
    await expect(w.rollouts.fork('f1' as FerretId, { turn: 1 }, INTO)).rejects.toThrow(/nothing to fork/u);
  });

  test('discard removes only the forked file, and again is harmless', async () => {
    const w = await world();
    const file = await w.source(marker => conversation(A, marker, 3));
    const first = await w.rollouts.fork('f1' as FerretId, { turn: 1 }, INTO);
    const second = await w.rollouts.fork('f1' as FerretId, { turn: 2 }, INTO);
    const before = await w.everything();
    const mine = (id: string) => Object.keys(before).find(path => path.includes(id)) as string;
    expect(mine(first.harnessConversation)).not.toBe(mine(second.harnessConversation));

    await first.discard?.();
    await first.discard?.();
    const after = await w.everything();
    expect(Object.keys(after).sort()).toEqual(
      Object.keys(before)
        .filter(path => path !== mine(first.harnessConversation))
        .sort(),
    );
    expect(await readFile(file, 'utf8')).toBe(conversation(A, w.agent('f1'), 3));
    expect(await w.rollouts.has('f2' as FerretId, first.harnessConversation)).toBe(false);
    expect(await w.rollouts.has('f2' as FerretId, second.harnessConversation)).toBe(true);
  });
});
