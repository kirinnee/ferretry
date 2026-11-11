/**
 * The Codex rollout reader over a REAL folder: the kernel's own fenced roots over the real disk, its real state port,
 * and rollout files this test writes. Nothing here is a real harness home or a real sign-in document.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessTranscriptReplaced, type LaunchSpec } from '@ferretry/core-ferrets/contract';
import type { FencedPath, FerretId, KernelPorts } from '@ferretry/kernel/contract';
import { nodeFs, rootsPortFor, state } from '@ferretry/kernel/host';
import { instantFromEpochMs } from '@ferretry/std';
import { CODEX_ROLLOUTS } from '../../contract/index.ts';
import { CodexRollouts } from '../../daemon/adapters/rollouts.ts';

const parents: string[] = [];
/** Every byte handle a test opened: the single consumer closes them, and so does the test (a descriptor is never left to the GC). */
const heldHandles: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const held of heldHandles.splice(0)) await held.close();
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const line = (type: string, payload: unknown) =>
  `${JSON.stringify({ timestamp: '2026-10-20T09:00:00.000Z', type, payload })}\n`;
const header = (id: string, home: string, cwd = '/work/project') =>
  line('session_meta', { id, cwd, runtime_workspace_roots: [`${home}/codex-correlation/unreachable`] });
const said = (text: string) =>
  line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

/** A real home with two ferrets' agent homes, the kernel's roots over the disk, and a clock the test moves. */
async function world(secret?: string) {
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
    redaction: {
      read: async (fn: (scope: { text(s: string): string }) => unknown) =>
        await fn({ text: s => (secret === undefined ? s : s.split(secret).join('******')) }),
    },
    clock: {
      after: () => () => undefined,
      now: () => instantFromEpochMs(time.ms),
      sleep: async () => {
        time.sleeps += 1;
        if (time.failSleep) throw new Error('the clock stopped');
        await new Promise(resolve => setTimeout(resolve, 1));
      },
    },
  } as unknown as KernelPorts;
  const rollouts = new CodexRollouts(kernel, async () => undefined);
  const openBytes = rollouts.bytes;
  (rollouts as { bytes: typeof openBytes }).bytes = async ferret => {
    const handle = await openBytes(ferret);
    if (handle !== undefined) heldHandles.push(handle);
    return handle;
  };
  const specOf = (ferret: string): LaunchSpec =>
    ({ ferret: ferret as FerretId, home: agent(ferret) as FencedPath }) as LaunchSpec;
  const write = async (ferret: string, name: string, text: string) =>
    await writeFile(join(agent(ferret), 'sessions', name), text);
  return { rollouts, agent, specOf, write, time, parent, port };
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

describe('G162 Codex rollouts: transcriptBytes is a windowed, unmasked byte handle over the proved rollout', () => {
  const F1 = 'f1' as FerretId;
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  /** A replacement made the way a real one is: the new file exists BESIDE the old one, then takes its name (another inode). */
  const replace = async (path: string, body: string) => {
    await writeFile(`${path}.new`, body);
    await rename(`${path}.new`, path);
  };
  const opened = async (rollout?: string) => {
    const w = await world();
    await w.rollouts.launched(w.specOf('f1'));
    const body = rollout ?? `${header('native-a', w.agent('f1'))}${said('hello')}`;
    await w.write('f1', 'rollout-a.jsonl', body);
    const handle = await w.rollouts.bytes(F1);
    if (handle === undefined) throw new Error('the rollout is proved');
    return { ...w, handle, body };
  };

  test('a ferret with no proved rollout has no bytes; so has one whose header does not name its home', async () => {
    const w = await world();
    expect(await w.rollouts.bytes(F1)).toBeUndefined();
    await w.rollouts.launched(w.specOf('f1'));
    expect(await w.rollouts.bytes(F1)).toBeUndefined();
    // A rollout correlated to ANOTHER ferret's home proves nothing for this one.
    await w.write('f1', 'rollout-b.jsonl', `${header('native-b', w.agent('f2'))}${said('not mine')}`);
    expect(await w.rollouts.bytes(F1)).toBeUndefined();
  });

  test('the handle reads the proved rollout UNMASKED with a stable token, the file’s size and the codex format', async () => {
    const { handle, rollouts, body } = await opened();
    expect(handle.format).toBe('codex');
    expect(handle.size).toBe(body.length);
    expect(handle.mtimeMs).toBeGreaterThan(0);
    expect(text(await handle.read(0, handle.size))).toBe(body);
    expect((await rollouts.bytes(F1))?.file).toBe(handle.file);
    expect(handle.file).toMatch(/^[0-9a-f]{22}$/);
  });

  test('the token changes when the rollout is replaced', async () => {
    const w = await opened();
    await replace(
      join(w.agent('f1'), 'sessions', 'rollout-a.jsonl'),
      `${header('native-a', w.agent('f1'))}${said('replacement')}`,
    );
    // Drop the remembered proof so the next ask proves afresh.
    w.rollouts.forget(F1);
    const again = await w.rollouts.bytes(F1);
    expect(again?.file).not.toBe(w.handle.file);
  });

  test('a read past the end is short, one wholly past it is empty, and a read is clamped to the 4 MiB window', async () => {
    const w = await opened();
    expect(text(await w.handle.read(w.body.length - 4, 100))).toBe(w.body.slice(-4));
    expect((await w.handle.read(w.body.length + 10, 100)).length).toBe(0);
    const large = await world();
    await large.rollouts.launched(large.specOf('f1'));
    await large.write(
      'f1',
      'rollout-a.jsonl',
      `${header('native-a', large.agent('f1'))}${'x'.repeat(5 * 1024 * 1024)}`,
    );
    const handle = await large.rollouts.bytes(F1);
    expect((await handle!.read(0, 5 * 1024 * 1024)).length).toBe(4 * 1024 * 1024);
  });

  test('a negative, fractional or huge offset or length is refused, naming no path', async () => {
    const { handle, parent } = await opened();
    for (const [offset, length] of [
      [-1, 10],
      [0, -1],
      [1.5, 10],
      [2 ** 60, 10],
      [0, 2 ** 60],
      [Number.NaN, 10],
    ] as const) {
      const failure = await handle.read(offset, length).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(RangeError);
      expect(String((failure as Error).message)).not.toContain(parent);
    }
  });

  test('the handle and every error it raises carry no path', async () => {
    const w = await opened();
    const shown = JSON.stringify(
      Object.fromEntries(Object.entries(w.handle).filter(([, v]) => typeof v !== 'function')),
    );
    for (const secret of [w.parent, 'rollout-a', 'agent-homes', 'sessions']) expect(shown).not.toContain(secret);
    await replace(join(w.agent('f1'), 'sessions', 'rollout-a.jsonl'), 'replaced\n');
    const failure = await w.handle.read(0, 10).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HarnessTranscriptReplaced);
    const said2 = `${(failure as Error).message} ${(failure as Error).stack ?? ''}`;
    for (const secret of [w.parent, 'rollout-a.jsonl', 'agent-homes']) expect(said2).not.toContain(secret);
  });

  test('a rollout replaced after the proof is refused: by a new file, by a symlink put in its place, and by removal', async () => {
    const w = await opened();
    const target = join(w.agent('f1'), 'sessions', 'rollout-a.jsonl');
    expect((await w.handle.stat())?.size).toBe(w.handle.size);
    // Another inode at the same name.
    await replace(target, 'NEW\n');
    await expect(w.handle.read(0, 10)).rejects.toBeInstanceOf(HarnessTranscriptReplaced);
    expect(await w.handle.stat()).toBeUndefined();

    // A symlink at the name to a file outside the home holding bytes of its own.
    const again = await opened();
    const outside = join(again.parent, 'outside.jsonl');
    await writeFile(outside, 'OUTSIDE-BYTES\n');
    const link = join(again.agent('f1'), 'sessions', 'rollout-a.jsonl');
    await rm(link);
    await symlink(outside, link);
    const failure = await again.handle.read(0, 100).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HarnessTranscriptReplaced);
    expect(await again.handle.stat()).toBeUndefined();
    again.rollouts.forget(F1);
    expect(await again.rollouts.bytes(F1)).toBeUndefined();

    // Gone.
    const gone = await opened();
    await rm(join(gone.agent('f1'), 'sessions', 'rollout-a.jsonl'));
    await expect(gone.handle.read(0, 10)).rejects.toBeInstanceOf(HarnessTranscriptReplaced);
    expect(await gone.handle.stat()).toBeUndefined();
  });

  test('P1-1: a NEW handle never trusts the remembered proof: a foreign rollout swapped in under the proved name is not handed over', async () => {
    const w = await world();
    await w.rollouts.launched(w.specOf('f1'));
    const target = join(w.agent('f1'), 'sessions', 'rollout-a.jsonl');
    await writeFile(target, `${header('native-a', w.agent('f1'))}${said('OWN')}`);
    const first = await w.rollouts.bytes(F1);
    expect(first).toBeDefined();
    // Another native session, correlated to ANOTHER ferret's home, takes the proved NAME inside the proof's 5 s window.
    await replace(target, `${header('native-b', w.agent('f2'))}${said('FOREIGN')}`);
    await expect(first!.read(0, 4096)).rejects.toBeInstanceOf(HarnessTranscriptReplaced);
    expect(await w.rollouts.bytes(F1)).toBeUndefined();
    // And after an explicit forget, as before.
    w.rollouts.forget(F1);
    expect(await w.rollouts.bytes(F1)).toBeUndefined();
  });

  test('P1-1: a binding rewritten to another ferret’s home during the proof window leaves no handle', async () => {
    const w = await world();
    await w.rollouts.launched(w.specOf('f1'));
    await w.write('f1', 'rollout-a.jsonl', `${header('native-a', w.agent('f1'))}${said('OWN')}`);
    expect(await w.rollouts.bytes(F1)).toBeDefined();
    await w.port.write(CODEX_ROLLOUTS, { format: 1, home: w.agent('f2'), baseline: [] }, 'f1');
    expect(await w.rollouts.bytes(F1)).toBeUndefined();
  });

  test('P1-1: a file with the proved session id but another ferret’s correlation is not owned, even under the proved name', async () => {
    const w = await world();
    await w.rollouts.launched(w.specOf('f1'));
    const target = join(w.agent('f1'), 'sessions', 'rollout-a.jsonl');
    await writeFile(target, `${header('native-a', w.agent('f1'))}${said('OWN')}`);
    expect(await w.rollouts.bytes(F1)).toBeDefined();
    // The same session id, now naming another ferret's home: the proof on the opened object fails.
    await replace(target, `${header('native-a', w.agent('f2'))}${said('FOREIGN')}`);
    expect(await w.rollouts.bytes(F1)).toBeUndefined();
  });

  test('P1-1: the handle closes its descriptor (close is idempotent)', async () => {
    const w = await opened();
    await w.handle.close();
    await w.handle.close();
    await expect(w.handle.read(0, 4)).rejects.toThrow();
  });
});

describe('ports-pending: a secret the JSON would escape is masked in each entry, not in the page’s JSON', () => {
  // A double quote, a backslash, a newline and a control character: every one is ESCAPED by JSON.stringify.
  const SECRET = 'pa"ss\\word\nline2\u0007end';

  test('the entry text and every string of its data are masked, and nothing else about the entry changes', async () => {
    const w = await world(SECRET);
    await w.rollouts.launched(w.specOf('f1'));
    await w.write(
      'f1',
      'rollout-a.jsonl',
      `${header('native-a', w.agent('f1'))}${said(`my ${SECRET} here`)}${said('plain words')}`,
    );

    const entries = await w.rollouts.transcript.read('f1' as FerretId);

    expect(entries.map(entry => entry.text)).toEqual(['my ****** here', 'plain words']);
    // The same words are in `data` (the event itself): masked there too, in every string, with the shape unchanged.
    const shown = JSON.stringify(entries);
    expect(shown).not.toContain('ss\\\\word');
    expect(shown).not.toContain(SECRET);
    expect(shown).not.toContain(JSON.stringify(SECRET).slice(1, -1));
    expect((entries[0]?.data as { text?: string } | undefined)?.text).toBe('my ****** here');
    expect(entries[1]?.data).toMatchObject({ text: 'plain words', kind: 'message' });
    // Ids, roles and instants are untouched, and paging still works over the masked entries.
    expect(entries.map(entry => entry.role)).toEqual(['assistant', 'assistant']);
    expect(await w.rollouts.transcript.read('f1' as FerretId, entries[0]?.id, 1)).toEqual(entries.slice(1, 2));
    expect(await w.rollouts.transcript.find('f1' as FerretId, entries[1]?.id ?? '')).toEqual(entries[1]);
  });
});
