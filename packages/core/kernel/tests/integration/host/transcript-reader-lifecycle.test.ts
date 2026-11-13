import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
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
 * G162 through the daemon: the REAL Ferrets and the REAL Conversation halves, as the generated registry builds them, meet
 * on `FerretHarness.transcriptBytes`. The harness is a fake that proves a Claude transcript as RAW bytes (a tool call,
 * thinking, an image block and a secret in every kind). Conversation parses and masks those bytes itself, so the secret
 * (a word the kernel's redaction knows) is masked in every answer, on every route and on the port, and the bytes
 * themselves are never an answer. Without the bytes a ferret has no transcript (409 `no_transcript`). Each package pins
 * its own end in its unit tier; this file proves the two ends meet.
 *
 * CI only (integration tier). Fixture values only.
 */

const SECRET = 'fixture-secret"\\end';

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
    everyDirectory: true,
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

test('stopping a ferret closes the transcript handle held for it', async () => {
  const w = await boot();
  try {
    w.harness.bytes.set(ferretId(w.id), conversation());
    expect((await get(w, 'logs')).status).toBe(200);
    const stopped = await w.h.request('POST', `/v1/ferrets/${w.id}/stop`, { query: { how: 'now' }, body: {} });
    expect(stopped.status).toBe(200);
    await w.h.settle();
    expect(w.harness.bytesAsked.length - w.harness.bytesClosed.length).toBe(0);
  } finally {
    await w.h.stop();
  }
});

test('real composition masks an escaped tool input in log-page', async () => {
  const w = await boot();
  try {
    // SECRET is fixture text known to kernel redaction, including characters escaped by JSON.
    w.harness.bytes.set(ferretId(w.id), conversation());
    const response = await get(w, 'log-page');
    expect(response.status).toBe(200);
    expect(response.json<{ log: string }>().log).not.toContain(JSON.stringify(SECRET).slice(1, -1));
  } finally {
    await w.h.stop();
  }
});

test('messages cursor walks to the end without losing or repeating a row', async () => {
  const w = await boot();
  try {
    w.harness.bytes.set(ferretId(w.id), conversation());
    const all = (await get(w, 'messages', { limit: '100' })).json<{ messages: { point: string }[] }>().messages;
    const points: string[] = [];
    let cursor: string | undefined;
    for (let step = 0; step < 20; step++) {
      const response = await get(w, 'messages', { limit: '1', ...(cursor === undefined ? {} : { cursor }) });
      expect(response.status).toBe(200);
      const page = response.json<{ messages: { point: string }[]; nextCursor: string | null }>();
      points.push(...page.messages.map(m => m.point));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(points).toEqual(all.map(m => m.point));
  } finally {
    await w.h.stop();
  }
});

test('Warden data port masks escaped input, and the Warden log port must too', async () => {
  const w = await boot();
  try {
    w.harness.bytes.set(ferretId(w.id), conversation());
    const api = w.port.api as ConversationApi;
    const events = await api.transcriptEvents(ferretId(w.id));
    expect(events.ok).toBe(true);
    expect(JSON.stringify(events)).not.toContain('fixture-secret');
    const log = await api.transcriptLog?.(ferretId(w.id));
    expect(log?.ok).toBe(true);
    expect(JSON.stringify(log)).not.toContain('fixture-secret');
  } finally {
    await w.h.stop();
  }
});

test('a cached image is not served once the harness proves no transcript', async () => {
  const w = await boot();
  try {
    w.harness.bytes.set(ferretId(w.id), conversation());
    const logs = await get(w, 'logs');
    const handle = /\[fy-image ([0-9.]+) /u.exec(logs.body)?.[1];
    expect(handle).toBeDefined();
    expect((await get(w, `transcript-images/${handle}`)).status).toBe(200);
    w.harness.bytes.delete(ferretId(w.id));
    const missing = await get(w, `transcript-images/${handle}`);
    expect(missing.status).toBe(409);
    expect(missing.json<{ code: string }>().code).toBe('no_transcript');
  } finally {
    await w.h.stop();
  }
});
