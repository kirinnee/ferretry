import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import { fixedClock, owner, testHost } from '@ferretry/kernel/testing';
import type { Instant } from '@ferretry/std';
import { CONVERSATION_STATE, ConversationPort, QUESTION_STATE } from '../../../../contract/index.ts';
import daemon from '../../../../daemon/index.ts';
import {
  clearAskedQuestion,
  readAskedQuestion,
  writeAskedQuestion,
} from '../../../../daemon/questions/adapters/state-asked-question.ts';
import { parseAskedQuestion } from '../../../../daemon/questions/lib/asked.ts';
import { KeyedSerialExecutor } from '../../../../daemon/seams/keyed-serial-executor.ts';
import { fixtureTexts } from '../../../support/fixtures.ts';
import { memoryStatePort } from '../../../support/state.ts';

/** The live `PreToolUse` payload of `asked.test.ts` (Claude Code 2.1.281, one `AskUserQuestion` call). */
const fixture = await fixtureTexts(join(import.meta.dir, '../../../fixtures/question-asked'));
const PAYLOAD = fixture('claude-2.1.281-pretooluse.json');
const TRANSCRIPT = '/home/user/.claude/projects/-work-repro/48fa096f-185c-42e1-b456-33dd3c77c5ce.jsonl';
const ASKED_AT = '2026-10-30T04:33:36.000Z' as Instant;
const F1 = ferretId('f1');
/** The lane the daemon keeps per ferret for its `question.json`. */
const lane = new KeyedSerialExecutor();

/** The real daemon half on the test host, its state the test's own memory port. */
async function conversation() {
  const state = memoryStatePort(CONVERSATION_STATE);
  const ferrets = new FakeFerrets();
  ferrets.add({ id: F1, state: 'working' });
  const built: { half?: ReturnType<NonNullable<typeof daemon.build>> } = {};
  const implementation = {
    ...daemon,
    build: (ctx: Parameters<NonNullable<typeof daemon.build>>[0]) => {
      const build = daemon.build;
      if (build === undefined) throw new Error('the conversation daemon half has no build');
      built.half = build({ ...ctx, kernel: { ...ctx.kernel, state } });
      return built.half;
    },
  } as typeof daemon;
  const host = await testHost({
    plugins: [implementation],
    fakes: { ferrets, asks: new FakeAsks() },
    clock: fixedClock('2026-10-30T04:40:00Z'),
  });
  const changed = (payload: Parameters<NonNullable<typeof built.half>['hooks']['ferret.changed']>[0]) =>
    built.half?.hooks['ferret.changed'](payload);
  return { host, state, changed };
}

/** The live payload asking another question, under another tool use. */
const LATER = (() => {
  const envelope = JSON.parse(PAYLOAD) as { tool_use_id: string; tool_input: { questions: { question: string }[] } };
  const [first] = envelope.tool_input.questions;
  return JSON.stringify({
    ...envelope,
    tool_use_id: 'toolu_later',
    tool_input: { questions: [{ ...first, question: 'Choice 2 of 5 — which colour?' }] },
  });
})();

describe('question.json holds the parsed question, never the raw hook payload', () => {
  test('F-0331 the hook payload is parsed when written, and both readers read it back', async () => {
    const { host, state } = await conversation();
    const written = await writeAskedQuestion(state, lane, F1, PAYLOAD, ASKED_AT, TRANSCRIPT);
    expect(written).toEqual({
      format: 1,
      toolUseId: 'toolu_01T4KnfY1in2GTL7P9wUmRtt',
      header: 'Web address',
      text: 'Choice 1 of 5 — what web address should the test-report viewer live at?',
      options: [
        {
          label: 'reports.example.dev (Recommended)',
          description: 'A clean address on a domain you already have in Cloudflare.',
        },
        { label: 'tests.example.dev', description: 'Same idea, different word.' },
        { label: '…example.workers.dev', description: "Cloudflare's free built-in address. No setup, but long." },
      ],
      multiple: false,
      askedAt: ASKED_AT,
      transcript: TRANSCRIPT,
    });
    // Stored as the schema, nothing of the envelope (no hook_event_name, tool_input, transcript_path).
    const stored = await state.read(QUESTION_STATE, F1);
    expect(stored.ok && stored.value).toEqual(written as never);
    expect(JSON.stringify(stored)).not.toContain('hook_event_name');

    // The transcript-proven evidence: what the raw payload would have given.
    const raw = parseAskedQuestion(PAYLOAD, Date.parse(ASKED_AT), TRANSCRIPT);
    const asked = await readAskedQuestion(state, F1, TRANSCRIPT);
    expect(asked?.toolUseId).toBe(raw?.toolUseId as string);
    expect(asked?.askedAtMs).toBe(raw?.askedAtMs as number);
    expect(asked?.questions).toEqual(raw?.questions as never);
    expect(asked?.input).toEqual(raw?.input as never);

    // The port (and so `GET /v1/ferrets/:ferretId/question`) answers the question without the transcript it was proved against.
    const { transcript: _proof, ...question } = written ?? {};
    expect(await host.provided(ConversationPort).question(F1)).toEqual(question as never);
    await host.stop();
  });

  test('a question proved against another transcript is not this reader’s question', async () => {
    const { host, state } = await conversation();
    await writeAskedQuestion(state, lane, F1, PAYLOAD, ASKED_AT, TRANSCRIPT);
    expect(await readAskedQuestion(state, F1, '/home/user/.claude/projects/-work-repro/other.jsonl')).toBeUndefined();
    expect(await readAskedQuestion(state, F1, undefined)).toBeUndefined();
    await host.stop();
  });

  test('what cannot be stored whole is not written: another transcript, another tool, several questions at once', async () => {
    const { host, state } = await conversation();
    // Each payload replaces the file whole: an earlier question stored first is cleared by every one of them.
    const envelope = JSON.parse(PAYLOAD) as { tool_input: { questions: unknown[] } };
    const twice = JSON.stringify({
      ...envelope,
      tool_input: { questions: [envelope.tool_input.questions[0], envelope.tool_input.questions[0]] },
    });
    for (const [payload, transcript] of [
      [PAYLOAD, '/home/user/.claude/projects/-work-repro/other.jsonl'],
      [PAYLOAD, undefined],
      [JSON.stringify({ ...envelope, tool_name: 'Bash' }), TRANSCRIPT],
      [twice, TRANSCRIPT],
      ['not json', TRANSCRIPT],
    ] as const) {
      expect(await writeAskedQuestion(state, lane, F1, PAYLOAD, ASKED_AT, TRANSCRIPT)).toBeDefined();
      expect(await writeAskedQuestion(state, lane, F1, payload, ASKED_AT, transcript)).toBeUndefined();
      const left = await state.read(QUESTION_STATE, F1);
      expect(left.ok && left.value).toBeUndefined();
    }
    const stored = await state.read(QUESTION_STATE, F1);
    expect(stored.ok && stored.value).toBeUndefined();
    expect(await host.provided(ConversationPort).question(F1)).toBeUndefined();
    await host.stop();
  });
});

describe('question.json is cleared when the question is answered or withdrawn', () => {
  test('an answered question goes: the route and the port then say none', async () => {
    const { host, state } = await conversation();
    const asked = await writeAskedQuestion(state, lane, F1, PAYLOAD, ASKED_AT, TRANSCRIPT);
    expect((await host.request('GET', '/v1/ferrets/f1/question', { as: owner() })).json()).toMatchObject({
      question: { toolUseId: asked?.toolUseId },
    });
    // The answer step's clear (the terminal seam answers, then this runs for the exact tool use it answered).
    await clearAskedQuestion(state, lane, F1, asked?.toolUseId);
    expect((await host.request('GET', '/v1/ferrets/f1/question', { as: owner() })).json()).toEqual({ question: null });
    expect(await host.provided(ConversationPort).question(F1)).toBeUndefined();
    await host.stop();
  });

  test('answering an earlier question leaves a later one alone', async () => {
    const { host, state } = await conversation();
    const first = await writeAskedQuestion(state, lane, F1, PAYLOAD, ASKED_AT, TRANSCRIPT);
    const later = await writeAskedQuestion(state, lane, F1, LATER, ASKED_AT, TRANSCRIPT);
    await clearAskedQuestion(state, lane, F1, first?.toolUseId);
    expect((await host.provided(ConversationPort).question(F1))?.toolUseId).toBe(later?.toolUseId as string);
    await host.stop();
  });

  test('an answer the terminal could not deliver keeps the question pending', async () => {
    const { host, state } = await conversation();
    const asked = await writeAskedQuestion(state, lane, F1, PAYLOAD, ASKED_AT, TRANSCRIPT);
    const answer = await host.provided(ConversationPort).answer(F1, {
      toolUseId: asked?.toolUseId ?? '',
      labels: ['tests.example.dev'],
    });
    expect(answer.ok).toBe(false);
    expect((await host.provided(ConversationPort).question(F1))?.toolUseId).toBe(asked?.toolUseId as string);
    await host.stop();
  });

  test('a ferret that stopped or went away withdraws its question', async () => {
    for (const [phase, change] of [
      ['stopped', 'stopped'],
      ['stopped', 'removed'],
      ['stopped', 'state'],
    ] as const) {
      const { host, state, changed } = await conversation();
      await writeAskedQuestion(state, lane, F1, PAYLOAD, ASKED_AT, TRANSCRIPT);
      changed({ ferret: F1, state: phase, change });
      await Bun.sleep(0);
      expect(await host.provided(ConversationPort).question(F1)).toBeUndefined();
      expect((await host.request('GET', '/v1/ferrets/f1/question', { as: owner() })).json()).toEqual({
        question: null,
      });
      await host.stop();
    }
  });

  test('a ferret still working keeps the question it is asking', async () => {
    const { host, state, changed } = await conversation();
    const asked = await writeAskedQuestion(state, lane, F1, PAYLOAD, ASKED_AT, TRANSCRIPT);
    changed({ ferret: F1, state: 'idle', change: 'state' });
    await Bun.sleep(0);
    expect((await host.provided(ConversationPort).question(F1))?.toolUseId).toBe(asked?.toolUseId as string);
    await host.stop();
  });
});

/** A state port whose first read of `question.json` answers, then waits for `release`: the instant between a clear's check and its remove. */
function pausedAfterFirstRead(inner: StatePort) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let enter: () => void = () => undefined;
  const entered = new Promise<void>(resolve => {
    enter = resolve;
  });
  let paused = false;
  const state: StatePort = {
    ...inner,
    read: (async (file: StateFileDef, name?: string) => {
      const read = await inner.read(file, name);
      if (file === QUESTION_STATE && !paused) {
        paused = true;
        enter();
        await gate;
      }
      return read;
    }) as StatePort['read'],
  };
  return { state, entered, release };
}

describe('r4 #2: the writer, the exact-id clear and the withdrawal share one lane per ferret', () => {
  test('Q1 is answered while Q2 is written: Q2 is kept', async () => {
    const { host, state: memory } = await conversation();
    const serial = new KeyedSerialExecutor();
    const first = await writeAskedQuestion(memory, serial, F1, PAYLOAD, ASKED_AT, TRANSCRIPT);
    const { state, entered, release } = pausedAfterFirstRead(memory);

    // The answer's clear has read Q1 and is about to remove; the ferret asks Q2 at that instant.
    const clearing = clearAskedQuestion(state, serial, F1, first?.toolUseId);
    await entered;
    const writing = writeAskedQuestion(state, serial, F1, LATER, ASKED_AT, TRANSCRIPT);
    await Bun.sleep(0);
    release();
    await Promise.all([clearing, writing]);

    expect((await host.provided(ConversationPort).question(F1))?.toolUseId).toBe('toolu_later');
    await host.stop();
  });

  test('the same interleaving without the lane loses Q2, which is the race the lane closes', async () => {
    const { host, state: memory } = await conversation();
    const unserialized = { run: async <T>(_ferret: string, work: () => Promise<T>) => await work() };
    const first = await writeAskedQuestion(memory, unserialized, F1, PAYLOAD, ASKED_AT, TRANSCRIPT);
    const { state, entered, release } = pausedAfterFirstRead(memory);

    const clearing = clearAskedQuestion(state, unserialized, F1, first?.toolUseId);
    await entered;
    await writeAskedQuestion(state, unserialized, F1, LATER, ASKED_AT, TRANSCRIPT);
    release();
    await clearing;

    expect(await host.provided(ConversationPort).question(F1)).toBeUndefined();
    await host.stop();
  });

  test('a withdrawal waits behind a write already in flight, so the ferret ends with no question', async () => {
    const { host, state } = await conversation();
    const serial = new KeyedSerialExecutor();
    const writing = writeAskedQuestion(state, serial, F1, PAYLOAD, ASKED_AT, TRANSCRIPT);
    const withdrawing = clearAskedQuestion(state, serial, F1);
    await Promise.all([writing, withdrawing]);
    expect(await host.provided(ConversationPort).question(F1)).toBeUndefined();
    await host.stop();
  });

  test("one ferret's lane does not hold another's", async () => {
    const serial = new KeyedSerialExecutor();
    let release: () => void = () => undefined;
    const held = serial.run('f1', async () => await new Promise<void>(resolve => (release = resolve)));
    let ran = false;
    await serial.run('f2', async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    release();
    await held;
  });
});
