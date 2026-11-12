import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { StatePort } from '@ferretry/kernel/contract';
import { fixedClock } from '@ferretry/kernel/testing';
import { err } from '@ferretry/std';
import type { Instant } from '@ferretry/std';
import {
  ANSWERS_STATE,
  CONVERSATION_STATE,
  HYPERMEDIA_STATE,
  INBOX_STATE,
  OUTBOX_STATE,
  QUESTION_STATE,
  RENDER_META_STATE,
  SENDS_STATE,
  type StoredRenderMeta,
} from '../../../contract/index.ts';
import { ClockSendScheduler } from '../../../daemon/delivery/adapters/clock-send-scheduler.ts';
import { StateSendChannel } from '../../../daemon/delivery/adapters/state-send-channel.ts';
import { StateSendLedger } from '../../../daemon/delivery/adapters/state-send-ledger.ts';
import type { SendRecord } from '../../../daemon/delivery/lib/types.ts';
import { StateDraftRepository } from '../../../daemon/drafts/adapters/state-draft-repository.ts';
import { StateHypermediaSwitch } from '../../../daemon/hypermedia/adapters/state-hypermedia-switch.ts';
import { StateAnswerLedger } from '../../../daemon/questions/adapters/state-answer-ledger.ts';
import {
  clearAskedQuestion,
  readAskedQuestion,
  writeAskedQuestion,
} from '../../../daemon/questions/adapters/state-asked-question.ts';
import {
  MESSAGE_TOKEN_KEY_BYTES,
  MessageTokenKeyError,
  messageTokenCodec,
} from '../../../daemon/reader/adapters/message-token-key.ts';
import { StateRenderRepository } from '../../../daemon/renders/adapters/render-store.ts';
import { KeyedSerialExecutor } from '../../../daemon/seams/keyed-serial-executor.ts';
import type { SessionId } from '../../../daemon/seams/ferret-id.ts';
import type { SharedDraftSnapshot } from '../../../daemon/seams/protocol.ts';
import { fixtureTexts } from '../../support/fixtures.ts';
import { memoryStatePort } from '../../support/state.ts';

const fixture = await fixtureTexts(join(import.meta.dir, '../../fixtures/question-asked'));
const PAYLOAD = fixture('claude-2.1.281-pretooluse.json');
const F1 = 'f1' as SessionId;
const AT = '2026-11-07T09:00:00.000Z' as Instant;
const world = () => memoryStatePort(CONVERSATION_STATE);

async function lines(source: AsyncIterable<unknown>): Promise<Record<string, unknown>[]> {
  const found: Record<string, unknown>[] = [];
  for await (const line of source) found.push(line as Record<string, unknown>);
  return found;
}

describe('the send re-check scheduler on the kernel clock', () => {
  test('a re-check runs once after its delay, and scheduling again replaces the one waiting', async () => {
    const clock = fixedClock();
    const scheduler = new ClockSendScheduler(clock);
    const ran: string[] = [];

    scheduler.schedule(F1, 1_000, () => ran.push('first'));
    scheduler.schedule(F1, 2_000, () => ran.push('second'));
    await clock.advance(1_999);
    expect(ran).toEqual([]);
    await clock.advance(1);

    expect(ran).toEqual(['second']);
    expect(clock.pending()).toBe(0);
  });

  test('cancelling all drops every ferret’s pending re-check', async () => {
    const clock = fixedClock();
    const scheduler = new ClockSendScheduler(clock);
    const ran: string[] = [];
    scheduler.schedule(F1, 1_000, () => ran.push('a'));
    scheduler.schedule('f2' as SessionId, 1_000, () => ran.push('b'));

    scheduler.cancelAll();
    await clock.advance(5_000);

    expect(ran).toEqual([]);
  });
});

describe('the inbox and outbox of a ferret', () => {
  test('what reached a ferret and what it sent are one line each, carrying only the facts that were given', async () => {
    const state = world();
    const channel = new StateSendChannel(state);

    await channel.recordInbound(F1, { at: AT, message: 'plain' });
    await channel.recordInbound(F1, {
      at: AT,
      message: 'full',
      turn: 3,
      queued: true,
      queueId: 'q1',
      queuedForRevive: false,
      reason: 'busy',
      from: 'f2',
      fromName: 'Two',
    });
    await channel.recordOutbound(F1, { at: AT, from: 'f1', to: 'f2', disposition: 'delivered', message: 'hello' });
    await channel.recordOutbound(F1, {
      at: AT,
      from: 'f1',
      fromName: 'One',
      to: 'f2',
      disposition: 'queued',
      message: 'again',
    });

    const inbox = await lines(state.lines<unknown>(INBOX_STATE, F1));
    const outbox = await lines(state.lines<unknown>(OUTBOX_STATE, F1));
    expect(inbox[0]).toEqual({ at: AT, type: 'message', message: 'plain' });
    expect(inbox[1]).toMatchObject({
      turn: 3,
      queued: true,
      queueId: 'q1',
      queuedForRevive: false,
      reason: 'busy',
      from: 'f2',
      fromName: 'Two',
    });
    expect(outbox[0]).not.toHaveProperty('fromName');
    expect(outbox[1]).toMatchObject({ fromName: 'One', disposition: 'queued', to: 'f2' });
  });
});

describe('the durable send ledger', () => {
  const record = (sendId: string, over: Partial<SendRecord> = {}): SendRecord =>
    ({
      sendId,
      acceptedAt: AT,
      acceptedTurn: 1,
      path: 'direct',
      message: 'hello',
      fate: 'accepted',
      ...over,
    }) as SendRecord;
  const ledger = (state: StatePort = world()) => new StateSendLedger(state, fixedClock(AT));

  test('accepting is idempotent by send id, and a withdrawn send may be accepted again', async () => {
    const sends = ledger();

    expect((await sends.accept(F1, record('s1'))).created).toBe(true);
    const again = await sends.accept(F1, record('s1', { message: 'changed' }));
    expect(again.created).toBe(false);
    expect(again.record.message).toBe('hello');
    await sends.withdraw(F1, 's1', 'changed my mind');
    expect((await sends.accept(F1, record('s1', { message: 'second try' }))).created).toBe(true);
    expect((await sends.list(F1)).map(each => each.message)).toEqual(['second try']);
  });

  test('only an accepted send is revised or withdrawn, and a withdrawal keeps its reason in the log', async () => {
    const state = world();
    const sends = ledger(state);
    await sends.accept(F1, record('s1'));

    expect((await sends.revise(F1, 's1', { path: 'turn-file', held: true } as never))?.path).toBe('turn-file');
    expect(await sends.revise(F1, 'nope', {})).toBeUndefined();
    expect((await sends.withdraw(F1, 's1', 'too late'))?.fate).toBe('withdrawn');
    expect(await sends.withdraw(F1, 's1', 'twice')).toBeUndefined();
    expect(await sends.revise(F1, 's1', {})).toBeUndefined();
    const written = await lines(state.lines<unknown>(SENDS_STATE, F1));
    expect(written.at(-1)).toMatchObject({ fate: 'withdrawn', reason: 'too late', at: AT });
  });

  test('settling merges what happened, drops a field set to nothing, and refuses a withdrawn or a cancelled-then-failed send', async () => {
    const sends = ledger();
    await sends.accept(F1, record('s1', { matchText: 'hello' }));
    await sends.accept(F1, record('s2'));
    await sends.accept(F1, record('s3'));

    const settled = await sends.settle(F1, 's1', { fate: 'queued', matchText: undefined } as never);
    expect(settled?.fate).toBe('queued');
    expect(settled).not.toHaveProperty('matchText');
    expect(await sends.settle(F1, 'nope', { fate: 'delivered' })).toBeUndefined();
    await sends.withdraw(F1, 's2', 'x');
    expect(await sends.settle(F1, 's2', { fate: 'delivered' })).toBeUndefined();
    await sends.settle(F1, 's3', { fate: 'cancelled' });
    expect(await sends.settle(F1, 's3', { fate: 'timed_out' })).toBeUndefined();
    expect((await sends.settle(F1, 's3', { fate: 'delivered' }))?.fate).toBe('delivered');
  });

  test('lines that are not sends this daemon wrote are skipped, and what is read is frozen', async () => {
    const state = world();
    state.folder.plant(
      SENDS_STATE,
      [
        JSON.stringify({ format: 1, note: 'no send id' }),
        JSON.stringify({ format: 1, sendId: 's9', path: 'direct', fate: 'accepted', message: 'kept' }),
        JSON.stringify({ format: 1, sendId: 7, path: 'direct', fate: 'accepted' }),
        'not json at all',
        '',
      ].join('\n'),
      F1,
    );

    const all = await ledger(state).all(F1);

    expect([...all.keys()]).toEqual(['s9']);
    expect(Object.isFrozen(all.get('s9'))).toBe(true);
  });

  test('writes to one ferret run one at a time, and a write that failed does not stop the next', async () => {
    const state = world();
    let failNext = true;
    const flaky = {
      ...state,
      append: async (...args: Parameters<StatePort['append']>) => {
        if (failNext) {
          failNext = false;
          throw new Error('the disk is full');
        }
        return await state.append(...args);
      },
    } as unknown as StatePort;
    const sends = ledger(flaky);

    const first = sends.accept(F1, record('s1'));
    const second = sends.accept(F1, record('s2'));

    await expect(first).rejects.toThrow('the disk is full');
    expect((await second).created).toBe(true);
    expect((await sends.list(F1)).map(each => each.sendId)).toEqual(['s2']);
  });
});

describe('the shared drafts of a ferret', () => {
  const draft = (over: Partial<SharedDraftSnapshot> = {}): SharedDraftSnapshot =>
    ({
      v: 1,
      ferret: 'f1',
      generation: 'g1',
      epoch: 0,
      rev: 1,
      text: 'hi',
      items: [],
      updatedAt: AT,
      ...over,
    }) as never;
  const repository = (state = world()) => ({
    state,
    drafts: new StateDraftRepository(state, new KeyedSerialExecutor()),
  });

  test('the chat box and one reply per agenda item are saved, loaded back, listed and removed', async () => {
    const { drafts } = repository();
    await drafts.save(draft());
    await drafts.save(draft({ slot: 'A1' as never, text: 'reply' }));
    await drafts.save(draft({ slot: 'A2' as never }));

    expect((await drafts.load('f1'))?.text).toBe('hi');
    expect((await drafts.load('f1', 'A1' as never))?.text).toBe('reply');
    expect(await drafts.items('f1')).toEqual(['A1', 'A2']);
    await drafts.remove('f1', 'A1' as never);
    expect(await drafts.load('f1', 'A1' as never)).toBeUndefined();
    expect(await drafts.items('f1')).toEqual(['A2']);
    expect(await drafts.load('nobody')).toBeUndefined();
  });

  test('a document that does not read back as this ferret’s drafts is no draft, and nothing else breaks', async () => {
    const { state, drafts } = repository();
    const put = (text: string) => state.bytes.set('f1/drafts', new TextEncoder().encode(text));

    put('not json');
    expect(await drafts.load('f1')).toBeUndefined();
    put('null');
    expect(await drafts.items('f1')).toEqual([]);
    put(JSON.stringify({ chat: { nonsense: true }, items: 'nope' }));
    expect(await drafts.load('f1')).toBeUndefined();
    put(
      JSON.stringify({
        chat: draft({ ferret: 'f2' as never }),
        items: { A1: draft({ slot: 'A1' as never }), bad: 'x', 'not-an-id': draft({ slot: 'A3' as never }) },
      }),
    );
    expect(await drafts.load('f1')).toBeUndefined();
    expect(await drafts.items('f1')).toEqual(['A1']);
    expect(await drafts.load('f1', 'A1' as never)).toBeDefined();
    expect(await drafts.load('f1', 'A2' as never)).toBeUndefined();
  });
});

describe('the hypermedia switch of a ferret', () => {
  test('is none until set, then what the owner set, and goes with the ferret', async () => {
    const state = world();
    const hypermedia = new StateHypermediaSwitch(state);
    expect(await hypermedia.recorded('f1')).toBeUndefined();

    await hypermedia.write('f1', true, AT);
    expect(await hypermedia.recorded('f1')).toBe(true);
    await hypermedia.write('f1', false, AT);
    expect(await hypermedia.recorded('f1')).toBe(false);
    await hypermedia.forget('f1');

    expect(await hypermedia.recorded('f1')).toBeUndefined();
  });

  test('an unreadable file is none', async () => {
    const state = world();
    state.folder.plant(HYPERMEDIA_STATE, '{ not json', 'f1');

    expect(await new StateHypermediaSwitch(state).recorded('f1')).toBeUndefined();
  });
});

describe('the answer ledger', () => {
  const receipt = (requestId: string, outcome: string, over: Record<string, unknown> = {}) =>
    ({ requestId, toolUseId: 'toolu_1', fingerprint: 'fp', acceptedAt: AT, outcome, ...over }) as never;

  test('a receipt is read back; a resolution is stored as the same accepted receipt and read back as how it resolved', async () => {
    const state = world();
    const heard: string[] = [];
    const ledger = new StateAnswerLedger(state, fixedClock(AT), id => heard.push(id));

    await ledger.append(F1, receipt('r1', 'accepted'));
    await ledger.append(F1, receipt('r2', 'accepted'));
    for (const outcome of ['failed', 'quarantined', 'acknowledged'] as const) {
      await ledger.append(F1, receipt(`r-${outcome}`, outcome, { reason: 'why' }));
    }
    await ledger.append(F1, receipt('r3', 'confirmed'));
    await ledger.append(F1, receipt('r2', 'withdrawn', { reason: 'safe to retry' }));

    expect((await ledger.read(F1, 'r1'))?.outcome).toBe('accepted');
    expect(await ledger.read(F1, 'r2')).toMatchObject({ outcome: 'withdrawn', reason: 'safe to retry' });
    expect((await ledger.read(F1, 'r-failed'))?.outcome).toBe('failed');
    expect((await ledger.read(F1, 'r-quarantined'))?.outcome).toBe('quarantined');
    expect((await ledger.read(F1, 'r-acknowledged'))?.outcome).toBe('acknowledged');
    expect((await ledger.read(F1, 'r3'))?.outcome).toBe('confirmed');
    expect(await ledger.read(F1, 'nope')).toBeUndefined();
    expect(heard).toHaveLength(7);
    const raw = await lines(state.lines<unknown>(ANSWERS_STATE, F1));
    expect(raw.find(line => line.requestId === 'r-failed')).toMatchObject({
      outcome: 'accepted',
      resolution: 'failed',
    });
  });

  test('a line that is not a receipt is skipped and an outcome nobody knows is quarantined, never taken as permission to drive', async () => {
    const state = world();
    state.folder.plant(
      ANSWERS_STATE,
      [
        JSON.stringify({ format: 1, requestId: 1 }),
        JSON.stringify({
          format: 1,
          requestId: 'r1',
          toolUseId: 't',
          fingerprint: 'f',
          acceptedAt: AT,
          outcome: 'weird',
        }),
        JSON.stringify({
          format: 1,
          requestId: 'r2',
          toolUseId: 't',
          fingerprint: 'f',
          acceptedAt: AT,
          outcome: 'weird',
          reason: 'mine',
        }),
        JSON.stringify([1, 2]),
      ].join('\n'),
      F1,
    );

    const all = await new StateAnswerLedger(state, fixedClock(AT)).all(F1);

    expect([...all.keys()].sort()).toEqual(['r1', 'r2']);
    expect(all.get('r1')).toMatchObject({ outcome: 'accepted' });
    expect(all.get('r1')?.reason).toContain('unrecognized outcome "weird"');
    expect(all.get('r2')?.reason).toBe('mine');
  });
});

describe('question.json, the one writer and its readers', () => {
  const TRANSCRIPT = '/home/user/.claude/projects/-work-repro/48fa096f-185c-42e1-b456-33dd3c77c5ce.jsonl';
  const lane = new KeyedSerialExecutor();
  const envelope = JSON.parse(PAYLOAD) as {
    tool_use_id: string;
    tool_input: {
      questions: {
        question: string;
        header?: string;
        options: { label: string; description?: string }[];
        multiSelect?: boolean;
      }[];
    };
  };
  const bare = JSON.stringify({
    ...envelope,
    tool_use_id: 'toolu_bare',
    tool_input: {
      questions: [
        { ...envelope.tool_input.questions[0], header: undefined, options: [{ label: 'Yes' }, { label: 'No' }] },
      ],
    },
  });

  test('a whole question is stored and read back as the evidence, proved against the same transcript only', async () => {
    const state = world();
    const written = await writeAskedQuestion(state, lane, 'f1', PAYLOAD, AT, TRANSCRIPT);
    expect(written?.toolUseId).toBe(envelope.tool_use_id);

    const asked = await readAskedQuestion(state, 'f1', TRANSCRIPT);

    expect(asked?.toolUseId).toBe(envelope.tool_use_id);
    expect(asked?.askedAtMs).toBe(Date.parse(AT));
    expect(await readAskedQuestion(state, 'f1', '/elsewhere.jsonl')).toBeUndefined();
    expect(await readAskedQuestion(state, 'f1', undefined)).toBeUndefined();
    expect(await readAskedQuestion(state, 'f2', TRANSCRIPT)).toBeUndefined();
  });

  test('a question with no header and options with no description is stored without them', async () => {
    const state = world();
    const written = await writeAskedQuestion(state, lane, 'f1', bare, AT, TRANSCRIPT);

    expect(written).not.toHaveProperty('header');
    expect(written?.options).toEqual([{ label: 'Yes' }, { label: 'No' }]);
    const asked = await readAskedQuestion(state, 'f1', TRANSCRIPT);
    expect(asked?.questions[0]).not.toHaveProperty('header');
    expect(asked?.input).toMatchObject({ questions: [{ options: [{ label: 'Yes' }, { label: 'No' }] }] });
  });

  test('what cannot be stored whole clears the earlier question instead of leaving it up', async () => {
    const state = world();
    for (const [payload, transcript] of [
      [PAYLOAD, undefined],
      ['not json', TRANSCRIPT],
    ] as const) {
      await writeAskedQuestion(state, lane, 'f1', PAYLOAD, AT, TRANSCRIPT);
      expect(await writeAskedQuestion(state, lane, 'f1', payload, AT, transcript)).toBeUndefined();
      expect(await readAskedQuestion(state, 'f1', TRANSCRIPT)).toBeUndefined();
    }
  });

  test('answering a question clears it, answering an earlier one leaves a later one, and no id clears whatever is there', async () => {
    const state = world();
    const first = await writeAskedQuestion(state, lane, 'f1', PAYLOAD, AT, TRANSCRIPT);
    await clearAskedQuestion(state, lane, 'f1', 'toolu_other');
    expect(await readAskedQuestion(state, 'f1', TRANSCRIPT)).toBeDefined();
    await clearAskedQuestion(state, lane, 'f1', first?.toolUseId);
    expect(await readAskedQuestion(state, 'f1', TRANSCRIPT)).toBeUndefined();
    await writeAskedQuestion(state, lane, 'f1', PAYLOAD, AT, TRANSCRIPT);
    await clearAskedQuestion(state, lane, 'f1');
    expect(await readAskedQuestion(state, 'f1', TRANSCRIPT)).toBeUndefined();
    await clearAskedQuestion(state, lane, 'f1', 'toolu_none');
  });

  test('a damaged question file, a question with an unreadable time or a state that throws is no question', async () => {
    const state = world();
    state.folder.plant(QUESTION_STATE, '{ not json', 'f1');
    expect(await readAskedQuestion(state, 'f1', TRANSCRIPT)).toBeUndefined();

    state.folder.plant(
      QUESTION_STATE,
      JSON.stringify({
        format: 1,
        toolUseId: 't',
        text: 'q',
        options: [],
        multiple: false,
        askedAt: 'never',
        transcript: TRANSCRIPT,
      }),
      'f1',
    );
    expect(await readAskedQuestion(state, 'f1', TRANSCRIPT)).toBeUndefined();

    const throwing = {
      read: async () => {
        throw new Error('io');
      },
    } as unknown as StatePort;
    expect(await readAskedQuestion(throwing, 'f1', TRANSCRIPT)).toBeUndefined();
  });
});

describe('the renders a ferret saved', () => {
  const meta = (id: string, over: Partial<StoredRenderMeta> = {}): StoredRenderMeta => ({
    v: 1,
    id,
    kind: 'svg',
    alt: 'a picture',
    bytes: 3,
    sha256: 'a'.repeat(64),
    createdAt: AT,
    author: {},
    ...over,
  });

  test('a render is written payload then meta, listed, and its payload read back', async () => {
    const renders = new StateRenderRepository(world());

    await renders.write(meta('abcd23'), '<svg/>');

    expect((await renders.listMetas()).map(each => each.id)).toEqual(['abcd23']);
    expect(await renders.readPayload('abcd23')).toBe('<svg/>');
    expect(await renders.readPayload('zzzz23')).toBeUndefined();
  });

  test('an id that is not an id never becomes a name, and a meta that is not a render is skipped', async () => {
    const state = world();
    const renders = new StateRenderRepository(state);
    await renders.write(meta('abcd23'), 'one');
    state.folder.plant(RENDER_META_STATE, JSON.stringify(meta('abcd24')), 'abcd25');
    state.folder.plant(RENDER_META_STATE, '{ not json', 'abcd26');
    state.folder.plant(RENDER_META_STATE, JSON.stringify(meta('abcd23')), 'illegal');

    expect((await renders.listMetas()).map(each => each.id)).toEqual(['abcd23']);
    await expect(renders.readPayload('../etc')).rejects.toThrow('not a render id');
    await expect(renders.write(meta('ILL'), 'x')).rejects.toThrow('not a render id');
  });
});

describe('the message-token key', () => {
  const input = new TextEncoder().encode('a cursor');
  const KEY = 'message-token.key';

  test('is minted at 32 bytes only when absent, written once, and verifies after a restart', async () => {
    const state = world();
    const tag = await messageTokenCodec(state).tag(input);
    const written = state.bytes.get(KEY);

    expect(written?.byteLength).toBe(MESSAGE_TOKEN_KEY_BYTES);
    expect(await messageTokenCodec(state).matches(input, tag)).toBe(true);
    expect(state.bytes.get(KEY)).toEqual(written as Uint8Array);
  });

  test('a key that cannot be read, is the wrong width, or was minted short is refused and never replaced', async () => {
    const unreadable = {
      read: async () => err({ file: KEY, reason: 'io', sentence: 'the disk would not answer' }),
      write: async () => undefined,
    } as unknown as Pick<StatePort, 'read' | 'write'>;
    await expect(messageTokenCodec(unreadable).tag(input)).rejects.toBeInstanceOf(MessageTokenKeyError);

    const state = world();
    state.bytes.set(KEY, new Uint8Array(16).fill(3));
    await expect(messageTokenCodec(state).tag(input)).rejects.toThrow('is not exactly 32 bytes');
    expect(state.bytes.get(KEY)).toEqual(new Uint8Array(16).fill(3));

    const empty = world();
    await expect(messageTokenCodec(empty, bytes => bytes.subarray(0, 8) as never).tag(input)).rejects.toThrow(
      'wrong width',
    );
    expect(empty.bytes.has(KEY)).toBe(false);
  });

  test('a refused load is not kept: once the file is right again the next read signs', async () => {
    const state = world();
    state.bytes.set(KEY, new Uint8Array(5));
    const codec = messageTokenCodec(state);
    await expect(codec.tag(input)).rejects.toBeInstanceOf(MessageTokenKeyError);

    state.bytes.set(KEY, new Uint8Array(MESSAGE_TOKEN_KEY_BYTES).fill(9));

    expect((await codec.tag(input)).byteLength).toBe(32);
  });
});
