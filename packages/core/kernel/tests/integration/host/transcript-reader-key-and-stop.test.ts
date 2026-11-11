import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, open, readlink, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { Harnesses, Runners } from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner, ferretId } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { ConversationPort, type ConversationApi } from '../../../../../plugins/conversation/contract/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { type TestHost, testHost } from '../../../testing/index.ts';

/**
 * Transcript reads through the real Ferrets + Conversation composition (fix round 4):
 *
 * - a secret used as an OBJECT KEY of a tool input (one with a quote, a backslash and a newline, so its JSON spelling
 *   differs from the secret) is masked on every surface: logs, log-page, log-search and both Warden ports, beside the
 *   same secret in a nested value and in an array;
 * - a read already opening a transcript when POST /stop arrives cannot leave a descriptor open after stop settles, and
 *   a read begun afterwards opens afresh.
 *
 * CI only (integration tier). Fixture values only; the descriptor test uses a newly created temp file.
 */

const SECRET = 'review-fixture\"\\\nend';

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

const harnessPlugin = (harness: FakeHarness) =>
  implementDaemon(
    definePlugin({
      id: 'claude-code',
      title: 'Claude Code (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Harnesses, key: 'claude-code' }] },
    }),
    { build: () => ({ hooks: { 'harnesses:claude-code': harness } }) },
  );
const runnerPlugin = (runner: FakeRunner) =>
  implementDaemon(
    definePlugin({
      id: 'terminals',
      title: 'Terminals (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Runners, key: 'tmux' }] },
    }),
    { build: () => ({ hooks: { 'runners:tmux': runner } }) },
  );

/** The Warden's stand-in: a consumer that `needs` Conversation, as the real one does for `transcriptEvents` and `transcriptLog`. */
const consumer = (taken: { api?: ConversationApi }) =>
  implementDaemon(
    definePlugin({
      id: 'warden',
      title: 'Warden (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      needs: { conversation: ConversationPort },
    }),
    {
      build: ctx => {
        taken.api = ctx.needs.conversation as ConversationApi;
        return {};
      },
    },
  );

const stamp = (n: number): string => new Date(Date.UTC(2026, 1, 1) + n * 1_000).toISOString();
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24, 0x2f),
]).toString('base64');

/** A Claude conversation with a tool call, thinking, a tool result and an image, the secret in every kind. */
const conversation = (): Uint8Array => {
  const lines = [
    {
      type: 'user',
      uuid: 'u-1',
      timestamp: stamp(1),
      sessionId: 's1',
      message: { role: 'user', content: `please deploy, the token is ${SECRET}` },
    },
    {
      type: 'assistant',
      uuid: 'a-2',
      timestamp: stamp(2),
      sessionId: 's1',
      message: {
        id: 'm-2',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: `the token ${SECRET} must not be echoed`, signature: 'sig' },
          { type: 'text', text: `deploying with ${SECRET}` },
          { type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: `deploy --token ${SECRET}` } },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'r-3',
      timestamp: stamp(3),
      sessionId: 's1',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: `deployed using ${SECRET}` }],
      },
    },
    {
      type: 'user',
      uuid: 'u-4',
      timestamp: stamp(4),
      sessionId: 's1',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
        ],
      },
    },
  ];
  return new TextEncoder().encode(`${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
};

interface World {
  readonly h: TestHost;
  readonly harness: FakeHarness;
  readonly id: string;
  readonly port: { api?: ConversationApi };
}

async function boot(): Promise<World> {
  const harness = new FakeHarness();
  const port: { api?: ConversationApi } = {};
  const h = await testHost({
    plugins: [
      real('ferrets'),
      real('conversation'),
      harnessPlugin(harness),
      runnerPlugin(new FakeRunner()),
      consumer(port),
    ],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
    secrets: [SECRET],
  });
  const started = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': randomUUID() },
    body: { folder: '/work/a', prompt: 'Deploy.' },
  });
  expect(started.status).toBe(201);
  await h.settle();
  return { h, harness, id: started.json<{ id: string }>().id, port };
}

const get = async (w: World, route: string, query: Record<string, string> = {}) =>
  await w.h.request('GET', `/v1/ferrets/${w.id}/${route}`, { query });

for (const shape of ['nested-object', 'array', 'object-key'] as const) {
  for (const surface of ['logs', 'log-page', 'log-search', 'warden-log', 'warden-events'] as const) {
    test(`MASK: ${shape} secret stays masked on ${surface}`, async () => {
      const w = await boot();
      try {
        const input =
          shape === 'nested-object'
            ? { command: 'deploy', nested: { deep: `use ${SECRET}` } }
            : shape === 'array'
              ? { command: 'deploy', items: [{ value: SECRET }, SECRET] }
              : { command: 'deploy', [SECRET]: 'fixture-key-marker' };
        const raw =
          JSON.stringify({
            type: 'assistant',
            uuid: 'nested',
            timestamp: stamp(1),
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-nested', name: 'Bash', input }] },
          }) + '\n';
        w.harness.bytes.set(ferretId(w.id), new TextEncoder().encode(raw));
        let shown: string;
        if (surface === 'warden-log') shown = JSON.stringify(await w.port.api!.transcriptLog?.(ferretId(w.id)));
        else if (surface === 'warden-events')
          shown = JSON.stringify(await w.port.api!.transcriptEvents(ferretId(w.id)));
        else {
          const response = await get(w, surface, surface === 'log-search' ? { q: 'deploy', tools: '1' } : {});
          expect(response.status).toBe(200);
          shown =
            surface === 'logs'
              ? response.body
              : surface === 'log-page'
                ? response.json<{ log: string }>().log
                : response
                    .json<{ matches: { snippet: string }[] }>()
                    .matches.map(m => m.snippet)
                    .join('\n');
        }
        expect(shown).toContain(shape === 'object-key' ? 'fixture-key-marker' : 'deploy');
        expect(shown).not.toContain('review-fixture');
        expect(shown).not.toContain(JSON.stringify(SECRET).slice(1, -1));
      } finally {
        await w.h.stop();
      }
    });
  }
}

test('FD: a read already opening during POST stop cannot retain a descriptor after stop and settle', async () => {
  const w = await boot();
  const parent = await mkdtemp(join(tmpdir(), 'tr-rv4-held-'));
  const file = join(parent, 'transcript.jsonl');
  await writeFile(file, conversation());
  const held: { fd: number; closed: boolean; close: () => Promise<void> }[] = [];
  let secondEntered!: () => void;
  const entered = new Promise<void>(resolve => {
    secondEntered = resolve;
  });
  let resumeSecond!: () => void;
  const suspended = new Promise<void>(resolve => {
    resumeSecond = resolve;
  });
  let calls = 0;
  w.harness.transcriptBytes = async () => {
    const opened = await open(file, 'r');
    const item = {
      fd: opened.fd,
      closed: false,
      close: async () => {
        if (item.closed) return;
        item.closed = true;
        await opened.close();
      },
    };
    held.push(item);
    const stat = await opened.stat();
    const handle = {
      format: 'claude' as const,
      file: 'opaque-fixture-token',
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      read: async (offset: number, length: number) => {
        const bytes = new Uint8Array(length);
        const { bytesRead } = await opened.read(bytes, 0, length, offset);
        return bytes.subarray(0, bytesRead);
      },
      stat: async () => (item.closed ? undefined : { size: stat.size, mtimeMs: stat.mtimeMs }),
      close: item.close,
    };
    if (++calls === 2) {
      secondEntered();
      await suspended;
    }
    return handle;
  };
  const activeFds = async () => {
    const names = await readdir('/proc/self/fd');
    const targets = await Promise.all(names.map(async name => await readlink(`/proc/self/fd/${name}`).catch(() => '')));
    return targets.filter(target => target === file).length;
  };
  let reading: ReturnType<typeof get> | undefined;
  try {
    expect((await get(w, 'logs')).status).toBe(200);
    expect(await activeFds()).toBe(1);
    reading = get(w, 'logs');
    await entered;
    expect(await activeFds()).toBe(2);
    const stopped = await w.h.request('POST', `/v1/ferrets/${w.id}/stop`, { query: { how: 'now' }, body: {} });
    expect(stopped.status).toBe(200);
    await w.h.settle();
    expect(held[0]!.closed).toBe(true);
    resumeSecond();
    // The late read itself is answered (never a server error), but nothing it opened outlives the stop.
    expect((await reading).status).toBeLessThan(500);
    await w.h.settle();
    expect(await activeFds()).toBe(0);
    expect(held.map(h => h.closed)).toEqual([true, true]);
    // Only the opener in flight at the stop is late: a read begun afterwards opens afresh.
    const fresh = await get(w, 'logs');
    expect(fresh.status).toBe(200);
    expect(held).toHaveLength(3);
    expect(await activeFds()).toBe(1);
  } finally {
    resumeSecond();
    await reading;
    await w.h.stop();
    await Promise.all(held.map(h => h.close()));
    await rm(parent, { recursive: true, force: true });
  }
});
