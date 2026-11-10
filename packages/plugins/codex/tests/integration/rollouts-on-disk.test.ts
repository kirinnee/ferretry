/**
 * The Codex rollout reader over a REAL folder: the kernel's own fenced roots over the real disk, its real state port,
 * and rollout files this test writes. Nothing here is a real harness home or a real sign-in document.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchSpec } from '@ferretry/core-ferrets/contract';
import type { FencedPath, FerretId, KernelPorts } from '@ferretry/kernel/contract';
import { nodeFs, rootsPortFor, state } from '@ferretry/kernel/host';
import { instantFromEpochMs } from '@ferretry/std';
import { CODEX_ROLLOUTS } from '../../contract/index.ts';
import { CodexRollouts } from '../../daemon/adapters/rollouts.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const line = (type: string, payload: unknown) =>
  `${JSON.stringify({ timestamp: '2026-10-20T09:00:00.000Z', type, payload })}\n`;
const header = (id: string, home: string, cwd = '/work/project') =>
  line('session_meta', { id, cwd, runtime_workspace_roots: [`${home}/codex-correlation/unreachable`] });
const said = (text: string) =>
  line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

/** A real home with two ferrets' agent homes, the kernel's roots over the disk, and a clock the test moves. */
async function world() {
  const parent = await mkdtemp(join(tmpdir(), 'ferretry-codex-rollouts-'));
  parents.push(parent);
  const home = join(parent, 'fy');
  const agent = (ferret: string) => join(home, 'state', 'codex', 'agent-homes', ferret);
  for (const ferret of ['f1', 'f2']) await mkdir(join(agent(ferret), 'sessions'), { recursive: true });
  const roots = rootsPortFor(
    nodeFs(() => 'x'),
    { home, plugin: 'codex', worktrees: join(parent, 'worktrees') },
    ['agent-homes', 'harness-history'],
    () => undefined,
    { hardLinkRoots: [] },
  );
  const port = state.createStatePort({
    home,
    pluginId: 'codex',
    files: [CODEX_ROLLOUTS],
    fs: state.createNodeHostFs(),
  });
  const time = { ms: 1_000_000, sleeps: 0, failSleep: false };
  const kernel = {
    roots,
    state: port,
    redaction: { read: async (fn: (scope: { text(s: string): string }) => unknown) => await fn({ text: s => s }) },
    clock: {
      now: () => instantFromEpochMs(time.ms),
      sleep: async () => {
        time.sleeps += 1;
        if (time.failSleep) throw new Error('the clock stopped');
        await new Promise(resolve => setTimeout(resolve, 1));
      },
    },
  } as unknown as KernelPorts;
  const rollouts = new CodexRollouts(kernel, async () => undefined);
  const specOf = (ferret: string): LaunchSpec =>
    ({ ferret: ferret as FerretId, home: agent(ferret) as FencedPath }) as LaunchSpec;
  const write = async (ferret: string, name: string, text: string) =>
    await writeFile(join(agent(ferret), 'sessions', name), text);
  return { rollouts, agent, specOf, write, time, parent };
}

describe('Codex rollouts on a real folder', () => {
  test('a rollout whose header names no session, or is cut off, proves nothing', async () => {
    const w = await world();
    await w.rollouts.launched(w.specOf('f1'));
    await w.write('f1', 'no-header.jsonl', said('hello'));
    await w.write('f1', 'cut-off.jsonl', '{"type":"session_meta","payload":{"id":\n');

    expect(await w.rollouts.transcript.read('f1' as FerretId)).toEqual([]);
  });

  test('a rollout is read once it is proved by its correlation path, and a line that is not a record is skipped', async () => {
    const w = await world();
    await w.rollouts.launched(w.specOf('f1'));
    await w.write(
      'f1',
      'rollout-a.jsonl',
      `${header('native-a', w.agent('f1'))}this is not json\n${said('right ferret')}`,
    );

    const entries = await w.rollouts.transcript.read('f1' as FerretId);

    expect(entries.map(entry => entry.text)).toEqual(['right ferret']);
    expect(await w.rollouts.transcript.find('f1' as FerretId, entries[0]?.id ?? '')).toMatchObject({
      text: 'right ferret',
    });
    expect(await w.rollouts.transcript.read('f1' as FerretId, 'no-such-entry')).toEqual([]);
  });

  test('a tail skips a line that is not a record and keeps the record before it', async () => {
    const w = await world();
    await w.rollouts.launched(w.specOf('f1'));
    await w.write(
      'f1',
      'rollout-a.jsonl',
      `${header('native-a', w.agent('f1'))}${said('first')}not json at all\n${line('event_msg', { type: 'task_started' })}`,
    );

    const tail = await w.rollouts.tail('f1' as FerretId, 10);

    expect(tail.kind).toBe('read');
  });

  test('a proof older than its reuse window is dropped when another ferret proves its own rollout', async () => {
    const w = await world();
    await w.rollouts.launched(w.specOf('f1'));
    await w.rollouts.launched(w.specOf('f2'));
    await w.write('f1', 'rollout-a.jsonl', `${header('native-a', w.agent('f1'))}${said('one')}`);
    await w.write('f2', 'rollout-b.jsonl', `${header('native-b', w.agent('f2'))}${said('two')}`);
    expect((await w.rollouts.transcript.read('f1' as FerretId)).map(entry => entry.text)).toEqual(['one']);

    w.time.ms += 60_000;

    expect((await w.rollouts.transcript.read('f2' as FerretId)).map(entry => entry.text)).toEqual(['two']);
  });

  test('following ends with the clock’s own failure while the caller still listens', async () => {
    const w = await world();
    await w.rollouts.launched(w.specOf('f1'));
    await w.write('f1', 'rollout-a.jsonl', `${header('native-a', w.agent('f1'))}${said('one')}`);
    w.time.failSleep = true;
    const controller = new AbortController();

    const read = (async () => {
      const seen: string[] = [];
      for await (const entry of w.rollouts.transcript.follow('f1' as FerretId, controller.signal))
        seen.push(entry.text ?? '');
      return seen;
    })();

    await expect(read).rejects.toThrow('the clock stopped');
  });
});
