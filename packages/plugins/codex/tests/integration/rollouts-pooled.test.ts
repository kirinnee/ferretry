/**
 * Codex rollouts when `sessions` is the link to the shared history pool: the REAL kernel roots over a temp folder. What is
 * proved: a conversation any ferret wrote is found through the pool (`has`), a ferret never adopts another ferret's
 * rollout as its own (the proof is per home and reads only the days since the launch), a resume names its conversation
 * and reads it wherever it was written, a rollout filed on an old day is never read for a new launch, and copy-on-link
 * copies the owner's rollout into the pool and never touches the original.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
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
const heldHandles: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const held of heldHandles.splice(0)) await held.close();
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const line = (type: string, payload: unknown) =>
  `${JSON.stringify({ timestamp: '2026-11-16T09:00:00.000Z', type, payload })}\n`;
const header = (id: string, marker: string) =>
  line('session_meta', {
    id,
    cwd: '/work/project',
    runtime_workspace_roots: [`${marker}/codex-correlation/unreachable`],
  });
const said = (text: string) =>
  line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

const A = '019fab95-c49a-7843-b42f-40a6390eefc3';
const B = '019fab95-c4e0-7682-b561-a028fb700d1f';
const C = '019fab95-cbe4-7cd2-857a-3ab2d42c9a85';
const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const nameOf = (id: string, day = '2026/11/16') =>
  `sessions/${day}/rollout-${day.replaceAll('/', '-')}T09-00-00-${id}.jsonl`;

async function world(options: { historyHome?: () => Promise<string | undefined> } = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'ferretry-codex-pooled-'));
  parents.push(parent);
  const home = join(parent, 'fy');
  const owner = join(parent, 'owner/.codex');
  const agent = (ferret: string) => join(home, 'state', 'codex', 'agent-homes', ferret);
  const pool = (...parts: string[]) => join(home, 'state', 'codex', 'history-pool', ...parts);
  await mkdir(owner, { recursive: true });
  for (const folder of ['', 'state', 'state/codex'])
    await mkdir(join(home, folder), { recursive: true, mode: 0o700 }).then(() => chmod(join(home, folder), 0o700));
  await mkdir(join(home, 'state/codex/agent-homes'), { recursive: true, mode: 0o700 });
  await chmod(join(home, 'state/codex/agent-homes'), 0o700);
  await ensureInternalRootBases(
    nodeFs(() => crypto.randomUUID()),
    { home, plugin: 'codex' },
    ['agent-homes', 'harness-history'],
    {
      historyPool: { state: CODEX_HISTORY_POOL.name, entries: CODEX_HISTORY_ENTRIES },
      stateFiles: [CODEX_AGENT_HOMES, CODEX_HISTORY_POOL],
    },
  );
  for (const ferret of ['f1', 'f2']) await mkdir(agent(ferret), { recursive: true, mode: 0o700 });
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home, plugin: 'codex', worktrees: join(parent, 'worktrees') },
    ['agent-homes', 'harness-history'],
    () => undefined,
    {
      hardLinkRoots: [],
      historyPool: { state: CODEX_HISTORY_POOL.name, entries: CODEX_HISTORY_ENTRIES },
      stateFiles: [CODEX_AGENT_HOMES, CODEX_HISTORY_POOL],
    },
  );
  const port = state.createStatePort({
    home,
    pluginId: 'codex',
    files: [CODEX_ROLLOUTS],
    fs: state.createNodeHostFs(),
  });
  const time = { ms: NOW };
  const kernel = {
    roots,
    state: port,
    redaction: { read: async (fn: (scope: { text(s: string): string }) => unknown) => await fn({ text: s => s }) },
    clock: {
      after: () => () => undefined,
      now: () => instantFromEpochMs(time.ms),
      sleep: async () => undefined,
    },
  } as unknown as KernelPorts;
  const rollouts = new CodexRollouts(kernel, options.historyHome ?? (async () => owner));
  const specOf = (ferret: string): LaunchSpec =>
    ({ ferret: ferret as FerretId, home: agent(ferret) as FencedPath }) as LaunchSpec;
  /** Links every history entry of both homes to the pool, as a launch does. */
  const pooled = async () => {
    for (const ferret of ['f1', 'f2']) {
      const result = await poolHomeHistory({ roots, ferret: ferret as FerretId, entries: CODEX_HISTORY_ENTRIES });
      expect(result.sentence).toBeUndefined();
    }
  };
  /** A rollout written the way Codex does: through the ferret's own `sessions` link, into the pool. */
  const write = async (ferret: string, relative: string, text: string) => {
    await mkdir(join(agent(ferret), relative, '..'), { recursive: true });
    await writeFile(join(agent(ferret), relative), text);
  };
  return { rollouts, agent, pool, owner, specOf, pooled, write, time };
}

describe('Codex rollouts through the shared pool', () => {
  test('has finds a conversation another ferret wrote, and proves an unknown one absent', async () => {
    const w = await world();
    await w.pooled();
    await w.write('f1', nameOf(A), `${header(A, w.agent('f1'))}${said('from f1')}`);
    await w.write('f1', nameOf(B, '2026/10/01'), `${header(B, w.agent('f1'))}${said('older')}`);

    expect(await w.rollouts.has('f2' as FerretId, A)).toBe(true);
    expect(await w.rollouts.has('f2' as FerretId, B)).toBe(true);
    expect(await w.rollouts.has('f2' as FerretId, C)).toBe(false);
  });

  test('a ferret never adopts another ferret’s rollout: each proves only the one carrying its own home’s marker', async () => {
    const w = await world();
    await w.pooled();
    await w.rollouts.launched(w.specOf('f1'));
    await w.rollouts.launched(w.specOf('f2'));
    // Only f2 has written anything yet, in the same pool and on the same day.
    await w.write('f2', nameOf(B), `${header(B, w.agent('f2'))}${said('from f2')}`);

    expect(await w.rollouts.provedConversation('f1' as FerretId)).toBeUndefined();
    expect(await w.rollouts.transcript.read('f1' as FerretId)).toEqual([]);
    expect(await w.rollouts.provedConversation('f2' as FerretId)).toMatchObject({ id: B });

    await w.write('f1', nameOf(A), `${header(A, w.agent('f1'))}${said('from f1')}`);
    expect(await w.rollouts.provedConversation('f1' as FerretId)).toMatchObject({ id: A });
    expect(await w.rollouts.provedConversation('f2' as FerretId)).toMatchObject({ id: B });
    expect((await w.rollouts.transcript.read('f1' as FerretId)).map(entry => entry.text)).toEqual(['from f1']);
    expect((await w.rollouts.transcript.read('f2' as FerretId)).map(entry => entry.text)).toEqual(['from f2']);
  });

  test('a rollout that existed before the launch, even one carrying the marker, is the baseline and not this launch’s', async () => {
    const w = await world();
    await w.pooled();
    await w.write('f1', nameOf(A), `${header(A, w.agent('f1'))}${said('an earlier launch')}`);
    await w.rollouts.launched(w.specOf('f1'));

    expect(await w.rollouts.provedConversation('f1' as FerretId)).toBeUndefined();
    await w.write('f1', nameOf(B), `${header(B, w.agent('f1'))}${said('this launch')}`);
    expect(await w.rollouts.provedConversation('f1' as FerretId)).toMatchObject({ id: B });
  });

  test('a launch of a new conversation reads only the days since it, never the pool’s older rollouts', async () => {
    const w = await world();
    await w.pooled();
    await w.rollouts.launched(w.specOf('f1'));
    // Filed on an old day: out of the window the launch reads, whatever it contains.
    await w.write('f1', nameOf(A, '2026/11/01'), `${header(A, w.agent('f1'))}${said('too old to be this launch’s')}`);

    expect(await w.rollouts.provedConversation('f1' as FerretId)).toBeUndefined();
  });

  test('a resume names its conversation and reads it wherever it was written', async () => {
    const w = await world();
    await w.pooled();
    await w.write('f2', nameOf(B, '2026/10/01'), `${header(B, w.agent('f2'))}${said('written long ago by f2')}`);
    await w.rollouts.launched(w.specOf('f1'), B);

    expect(await w.rollouts.provedConversation('f1' as FerretId)).toMatchObject({ id: B });
    expect((await w.rollouts.transcript.read('f1' as FerretId)).map(entry => entry.text)).toEqual([
      'written long ago by f2',
    ]);
  });

  test('copy-on-link puts the owner’s rollout in the pool at the same path and never touches the original', async () => {
    const w = await world();
    await w.pooled();
    const source = join(w.owner, nameOf(A));
    await mkdir(join(source, '..'), { recursive: true });
    await writeFile(source, `${header(A, '/somewhere/else')}${said('mine')}`);
    await utimes(source, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'));
    const before = { bytes: await readFile(source), stat: await stat(source), tree: await readdir(join(source, '..')) };

    const copied = await w.rollouts.import({ id: A, source: nameOf(A) });

    expect(copied.ok).toBe(true);
    expect(await readFile(w.pool(nameOf(A)))).toEqual(before.bytes);
    expect(await readFile(source)).toEqual(before.bytes);
    expect((await stat(source)).mtimeMs).toBe(before.stat.mtimeMs);
    expect((await stat(source)).ino).toBe(before.stat.ino);
    expect(await readdir(join(source, '..'))).toEqual(before.tree);
    expect(await readdir(w.owner)).toEqual(['sessions']);
    // A ferret resumes the copy: it is found in the pool, and a second import never overwrites it.
    expect(await w.rollouts.has('f1' as FerretId, A)).toBe(true);
    await writeFile(w.pool(nameOf(A)), 'continued by a ferret\n');
    expect((await w.rollouts.import({ id: A, source: nameOf(A) })).ok).toBe(true);
    expect(await readFile(w.pool(nameOf(A)), 'utf8')).toBe('continued by a ferret\n');
  });

  test('copy-on-link refuses a name that is not that id’s rollout, and a header that names another conversation', async () => {
    const w = await world();
    await w.pooled();
    await mkdir(join(w.owner, 'sessions/2026/11/16'), { recursive: true });
    await writeFile(join(w.owner, nameOf(A)), `${header(B, '/x')}${said('the header says B')}`);

    for (const source of [
      nameOf(B),
      `../${nameOf(A)}`,
      'auth.json',
      nameOf(A).replace('sessions', 'archived_sessions'),
    ])
      expect((await w.rollouts.import({ id: A, source })).ok).toBe(false);
    expect((await w.rollouts.import({ id: A, source: nameOf(A) })).ok).toBe(false);
    expect(await readdir(w.pool('sessions'))).toEqual([]);
  });
});

test('copy-on-link refuses an unknown history home without making a pool copy', async () => {
  const w = await world({ historyHome: async () => undefined });
  expect(await w.rollouts.import({ id: A, source: nameOf(A) })).toEqual({
    ok: false,
    error: { reason: "Codex's history folder is not known on this machine." },
  });
});

test('copy-on-link hides a history-home failure instead of leaking an exception', async () => {
  const w = await world({
    historyHome: async () => {
      throw new Error('private failure detail');
    },
  });
  expect(await w.rollouts.import({ id: A, source: nameOf(A) })).toEqual({
    ok: false,
    error: { reason: 'The rollout could not be copied.' },
  });
});
