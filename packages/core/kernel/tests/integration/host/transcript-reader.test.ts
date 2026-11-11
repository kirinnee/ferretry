import { describe, expect, test } from 'bun:test';
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

const SECRET = 'hunter2-fixture';

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

describe('G162 a ferret’s transcript through the real Ferrets and the real Conversation', () => {
  test('G162 every route renders the tool call, the thinking and the image from the harness bytes, and masks the secret in all of them', async () => {
    // Arrange
    const w = await boot();
    w.harness.bytes.set(ferretId(w.id), conversation());

    // Act
    const logs = await get(w, 'logs');
    const page = await get(w, 'log-page');
    const search = await get(w, 'log-search', { q: 'deploy' });
    const messages = await get(w, 'messages', { limit: '10' });

    // Assert: everything is served, the rows of every kind are there, and the secret is nowhere.
    for (const answer of [logs, page, search, messages]) {
      expect(answer.status).toBe(200);
      expect(answer.body).not.toContain(SECRET);
    }
    expect(logs.body).toContain('Bash');
    expect(logs.body).toContain('assistant/reasoning');
    expect(logs.body).toContain('tool-result');
    expect(logs.body).toContain('fy-image');
    expect(logs.body).toContain('*'.repeat(SECRET.length));
    const log = page.json<{ log: string; file: string }>();
    expect(log.log).toContain('tool-call');
    expect(log.log).toContain('assistant/reasoning');
    expect(log.log).toContain('fy-image');
    expect(search.body).toContain('deploy');
    expect(messages.json<{ messages: { text: string }[] }>().messages.map(m => m.text)).toContain(
      `please deploy, the token is ${'*'.repeat(SECRET.length)}`,
    );
    await w.h.stop();
  });

  test('G162 an image handle the logs print is served by transcript-images', async () => {
    // Arrange
    const w = await boot();
    w.harness.bytes.set(ferretId(w.id), conversation());
    const logs = await get(w, 'logs');
    const handle = /\[fy-image ([0-9.]+) /u.exec(logs.body)?.[1];
    expect(handle).toBeDefined();

    // Act
    const served = await get(w, `transcript-images/${handle as string}`);

    // Assert
    expect(served.status).toBe(200);
    expect(served.body).toContain('image/png');
    await w.h.stop();
  });

  test('G162 an older page is served for its file and refused 409 log_cursor_stale once the harness proves another file', async () => {
    // Arrange
    const w = await boot();
    w.harness.bytes.set(ferretId(w.id), conversation());
    const first = (await get(w, 'log-page', { limit: '2' })).json<{ file: string; start: number }>();

    // Act
    const older = await get(w, 'log-page', { before: String(first.start), file: first.file, limit: '2' });
    w.harness.bytes.set(ferretId(w.id), conversation().slice(0, 100));
    const stale = await get(w, 'log-page', { before: String(first.start), file: first.file, limit: '2' });

    // Assert
    expect(older.status).toBe(200);
    expect(stale.status).toBe(409);
    expect(stale.json<{ code: string }>().code).toBe('log_cursor_stale');
    await w.h.stop();
  });

  test('G162 with no bytes proved, every reader route is 409 no_transcript and none serves an empty page', async () => {
    // Arrange: the harness proves a transcript, then no longer does.
    const w = await boot();
    w.harness.bytes.set(ferretId(w.id), conversation());
    expect((await get(w, 'logs')).status).toBe(200);
    w.harness.bytes.delete(ferretId(w.id));

    // Act
    const answers = [await get(w, 'logs'), await get(w, 'log-page'), await get(w, 'messages')];

    // Assert
    for (const answer of answers) {
      expect(answer.status).toBe(409);
      expect(answer.json<{ code: string }>().code).toBe('no_transcript');
    }
    await w.h.stop();
  });

  test('G162 a port consumer (the Warden’s stand-in) reads events, the log and a page through ConversationApi, masked', async () => {
    // Arrange
    const w = await boot();
    w.harness.bytes.set(ferretId(w.id), conversation());
    const api = w.port.api as ConversationApi;
    const ferret = ferretId(w.id);

    // Act
    const events = await api.transcriptEvents(ferret, { limit: 20 });
    const log = await api.transcriptLog?.(ferret, { limit: 20 });
    const page = await api.logPage(ferret);

    // Assert
    for (const answer of [events, log, page]) {
      expect(answer?.ok).toBe(true);
      expect(JSON.stringify(answer)).not.toContain(SECRET);
    }
    expect(JSON.stringify(events)).toContain('Bash');
    expect(JSON.stringify(log)).toContain('assistant/reasoning');
    await w.h.stop();

    // And a ferret whose harness proves nothing is `not_found` on the port, never an empty answer.
    const bare = await boot();
    const missing = await (bare.port.api as ConversationApi).transcriptEvents(ferretId(bare.id));
    expect(missing.ok).toBe(false);
    await bare.h.stop();
  });
});
