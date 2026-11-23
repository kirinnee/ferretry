import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { Harnesses, Runners } from '../../../../ferrets/contract/index.ts';
import {
  FakeHarness,
  FakeRunner,
  fakeThirdHarness,
  ferretId,
  THIRD_HARNESS_KEY,
} from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import type {
  ObservedTranscriptEvent as TranscriptEvent,
  TranscriptParseInput,
  TranscriptParseResult,
  TranscriptParser,
  TranscriptRawRecord,
  TranscriptRecordContext,
  TranscriptRecordResult,
} from '../../../../mailbox/contract/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { TranscriptParsers } from '../../../../../plugins/conversation/contract/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { type TestHost, testHost } from '../../../testing/index.ts';

/**
 * RUNTIMES PLAN U4a, COMPOSED. The harness seam is open only if a third harness works through the REAL daemon, not through
 * a hand-built service: the fake third harness is registered the way a plugin registers one (a `harnesses:<key>` provider,
 * and the transcript parser for the format it declares through Conversation's `transcript.parsers` hook), the daemon boots
 * from the generated registry, a ferret is started through `POST /v1/ferrets`, a message is delivered through the
 * production send route, and the transcript is read back through the logs route.
 *
 * Without the open seam it fails three ways: the refusal for a harness that is not installed is a 503 (not a 4xx), the
 * session document stamps the third harness as Claude, and the logs route cannot read a third harness's transcript.
 *
 * CI only (integration tier). Fixture values only.
 */

const THIRD_FORMAT = 'fake-jsonl';
/** The key as a literal, so the plugin's hook table is typed by it. */
const THIRD = 'fake-third' as const;

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

/**
 * The third harness's parser: a format of its own (one JSON object per line: `{ "at": …, "role": …, "text": … }`), read by
 * nothing but the parser this plugin declares. It shares no code with the Claude or Codex parsers.
 */
const thirdParser = (): TranscriptParser => {
  const event = (value: unknown, context: TranscriptRecordContext): TranscriptEvent | undefined => {
    if (typeof value !== 'object' || value === null) return undefined;
    const record = value as { at?: unknown; role?: unknown; text?: unknown };
    if (typeof record.text !== 'string') return undefined;
    return {
      kind: 'message',
      harness: THIRD_FORMAT,
      role: record.role === 'assistant' ? 'assistant' : 'user',
      text: record.text,
      ...(typeof record.at === 'string' ? { timestamp: record.at } : {}),
      ...(context.line === undefined ? {} : { line: context.line }),
      ...(context.byteOffset === undefined ? {} : { byteOffset: context.byteOffset }),
      ...(context.byteLength === undefined ? {} : { byteLength: context.byteLength }),
    };
  };
  const parseRecord = (value: unknown, context: TranscriptRecordContext = {}): TranscriptRecordResult => {
    const found = event(value, context);
    return { events: found === undefined ? [] : [found], issues: [], recognized: found !== undefined };
  };
  return {
    harness: THIRD_FORMAT,
    parseRecord,
    createInputObserver: () => ({ harness: THIRD_FORMAT, observe: () => [], reset: () => undefined }),
    parse: (input: TranscriptParseInput): TranscriptParseResult => {
      const bytes = input.bytes ?? new TextEncoder().encode(input.text);
      const start = input.startByteOffset ?? 0;
      const events: TranscriptEvent[] = [];
      const rawRecords: TranscriptRawRecord[] = [];
      let offset = 0;
      let line = input.startLine ?? 1;
      while (offset < bytes.length) {
        const end = bytes.indexOf(0x0a, offset);
        if (end === -1) break;
        const slice = bytes.subarray(offset, end + 1);
        rawRecords.push({ byteOffset: start + offset, bytes: slice });
        const parsed = parseRecord(JSON.parse(new TextDecoder().decode(slice)) as unknown, {
          line,
          byteOffset: start + offset,
          byteLength: slice.length,
        });
        events.push(...parsed.events);
        offset = end + 1;
        line += 1;
      }
      return {
        harness: THIRD_FORMAT,
        events,
        observedInputs: [],
        issues: [],
        remainder: new TextDecoder().decode(bytes.subarray(offset)),
        parsedRecords: rawRecords.length,
        ignoredRecords: 0,
        rawRecords,
      };
    },
  };
};

/** The third harness as a plugin declares it: its own provider, and the parser for its transcript format. */
const thirdPlugin = (harness: FakeHarness, parsers: readonly TranscriptParser[]) =>
  implementDaemon(
    definePlugin({
      // `harnesses` names its allowed takers (`claude-code`, `codex`), so the build refuses any other plugin id taking it:
      // a harness plugin of another id is refused there, which is the owner's call to open (reported with this fix).
      id: 'claude-code',
      title: 'Third harness (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: {
        takes: [{ hook: Harnesses, key: THIRD }, { hook: TranscriptParsers }],
      },
    }),
    {
      build: () => ({
        hooks: {
          'harnesses:fake-third': harness,
          'transcript.parsers': () => parsers.map((item, index) => ({ id: `fake-third-${index}`, item })),
        },
      }),
    },
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

const line = (text: string) => JSON.stringify({ at: '2026-02-01T09:00:01.000Z', role: 'user', text });

interface World {
  readonly h: TestHost;
  readonly harness: FakeHarness;
  readonly runner: FakeRunner;
}

async function boot(parsers: readonly TranscriptParser[] = [thirdParser()]): Promise<World> {
  const harness = fakeThirdHarness();
  const runner = new FakeRunner();
  const h = await testHost({
    plugins: [
      real('ferrets'),
      real('mailbox'),
      real('conversation'),
      thirdPlugin(harness, parsers),
      runnerPlugin(runner),
    ],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
    everyDirectory: true,
  });
  return { h, harness, runner };
}

const start = async (h: TestHost, body: Record<string, unknown>) =>
  await h.request('POST', '/v1/ferrets', { headers: { 'x-fy-request-id': randomUUID() }, body });

describe('a third harness through the real daemon', () => {
  test('a well-shaped key no installed plugin declares is a 4xx that names it, and starts nothing', async () => {
    const w = await boot();

    const refused = await start(w.h, { folder: '/work/a', harness: 'gemini', prompt: 'Go.' });

    expect(refused.status).toBe(422);
    expect(refused.body).toContain('no harness gemini is installed on this machine');
    expect(w.runner.starts).toBe(0);
    await w.h.stop();
  });

  test('starts through POST /v1/ferrets and stamps its own key in the session document, never Claude', async () => {
    const w = await boot();

    const started = await start(w.h, { folder: '/work/a', harness: THIRD_HARNESS_KEY, prompt: 'Go.' });
    await w.h.settle();

    expect(started.status).toBe(201);
    const { id } = started.json<{ id: string }>();
    const raw = w.h.state('ferrets').files.get(`${id}/config.json`);
    expect(raw).toBeDefined();
    expect((JSON.parse(raw as string) as { harness: string }).harness).toBe(THIRD_HARNESS_KEY);
    expect(w.harness.launched.map(spec => spec.ferret)).toContain(ferretId(id));
    await w.h.stop();
  });

  test('delivers a message through the production send route', async () => {
    const w = await boot();
    const { id } = (await start(w.h, { folder: '/work/a', harness: THIRD_HARNESS_KEY, prompt: 'Go.' })).json<{
      id: string;
    }>();
    await w.h.settle();
    const typed = w.runner.deliveries.length;

    const sent = await w.h.request('POST', `/v1/ferrets/${id}/send`, {
      headers: { 'x-fy-request-id': randomUUID() },
      body: { message: 'hello third' },
    });
    await w.h.settle();
    for (let i = 0; i < 100 && w.runner.deliveries.length === typed; i += 1) {
      await w.h.clock.advance(1_000);
      await w.h.settle();
      await Bun.sleep(10);
    }

    expect(sent.status).toBeLessThan(300);
    expect(w.runner.deliveries.slice(typed).map(entry => entry.delivery.text)).toContain('hello third');
    await w.h.stop();
  });

  test('is read through the logs route by the parser its plugin declares', async () => {
    const w = await boot();
    const { id } = (await start(w.h, { folder: '/work/a', harness: THIRD_HARNESS_KEY, prompt: 'Go.' })).json<{
      id: string;
    }>();
    await w.h.settle();
    w.harness.bytes.set(ferretId(id), new TextEncoder().encode(`${line('hello from the third harness')}\n`));

    const logs = await w.h.request('GET', `/v1/ferrets/${id}/logs`);

    expect(logs.status).toBe(200);
    expect(logs.body).toContain('hello from the third harness');
    await w.h.stop();
  });

  test('with no parser declared for its format, is read from its masked entries, never as Claude', async () => {
    const w = await boot([]);
    const { id } = (await start(w.h, { folder: '/work/a', harness: THIRD_HARNESS_KEY, prompt: 'Go.' })).json<{
      id: string;
    }>();
    await w.h.settle();
    w.harness.bytes.set(ferretId(id), new TextEncoder().encode(`${line('bytes only hello')}\n`));
    w.harness.entries = [
      { id: 'e-1', at: '2026-02-01T09:00:02.000Z' as never, role: 'assistant', text: 'entries only hello' },
    ];

    const logs = await w.h.request('GET', `/v1/ferrets/${id}/logs`);

    expect(logs.status).toBe(200);
    expect(logs.body).toContain('entries only hello');
    expect(logs.body).not.toContain('bytes only hello');
    await w.h.stop();
  });
});
