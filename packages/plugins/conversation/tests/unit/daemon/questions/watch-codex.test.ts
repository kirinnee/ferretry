import { describe, expect, it } from 'bun:test';
import type { Instant } from '@ferretry/std';
import type { Question } from '../../../../contract/index.ts';
import type { TranscriptEvent } from '../../../../daemon/seams/transcript-types.ts';
import { QuestionWatch, type QuestionWatchDeps, type WatchedFerret } from '../../../../daemon/questions/lib/watch.ts';

const CALL_ID = 'call_codex_1';
const ASKED = '2026-11-14T01:00:00.000Z' as Instant;

/** A Codex `request_user_input` call as the Codex transcript parser produces it (one question, two options). */
const call = (id = CALL_ID, at: string = ASKED): TranscriptEvent =>
  ({
    kind: 'tool-call',
    timestamp: at,
    call: {
      id,
      name: 'request_user_input',
      input: {},
      questions: [
        {
          header: 'Mode',
          question: 'Which mode?',
          multiple: false,
          options: [{ label: 'Fast', description: 'quick' }, { label: 'Slow' }],
        },
      ],
    },
  }) as unknown as TranscriptEvent;
const result = (id = CALL_ID, at = '2026-11-14T01:00:05.000Z'): TranscriptEvent =>
  ({ kind: 'tool-result', timestamp: at, result: { callId: id } }) as unknown as TranscriptEvent;
const chatter = {
  kind: 'message',
  timestamp: '2026-11-14T01:00:02.000Z',
  role: 'assistant',
  text: 'waiting',
} as unknown as TranscriptEvent;

function world(options: { ferrets?: readonly WatchedFerret[] } = {}) {
  const state = {
    events: [] as readonly TranscriptEvent[] | 'unreadable',
    question: undefined as Question | undefined,
    stamp: undefined as string | undefined,
  };
  const events: string[] = [];
  const writes: string[] = [];
  const deps: QuestionWatchDeps = {
    roster: async () => options.ferrets ?? [{ id: 'cody', harness: 'codex', state: 'working' }],
    harness: async () => ({ transcript: { read: async () => [] } }),
    current: async () => state.question,
    lastAnswered: async () => state.stamp,
    write: async () => undefined,
    clear: async (_ferret, toolUseId) => {
      if (state.question?.toolUseId === toolUseId) state.question = undefined;
    },
    asked: async (ferret, toolUseId) => void events.push(`asked ${ferret} ${toolUseId}`),
    answered: async (ferret, toolUseId) => void events.push(`answered ${ferret} ${toolUseId}`),
    transcriptEvents: async () => state.events,
    writeProjected: async (_ferret, pending, askedAt) => {
      writes.push(pending.toolUseId);
      const [first, ...more] = pending.questions;
      if (first === undefined) return undefined;
      state.question = {
        format: 1,
        toolUseId: pending.toolUseId,
        ...(first.header === undefined ? {} : { header: first.header }),
        text: first.question,
        options: (first.options ?? []).map(({ label }) => ({ label })),
        multiple: first.multiSelect === true,
        ...(more.length === 0
          ? {}
          : { more: more.map(item => ({ text: item.question, options: [], multiple: false })) }),
        askedAt: (askedAt ?? '2026-11-14T01:00:01.000Z') as Instant,
      };
      return state.question;
    },
  };
  return { state, events, writes, watch: new QuestionWatch(deps) };
}

describe('the question watch: a Codex request_user_input becomes question.json (B05)', () => {
  it('stores the open call from the transcript, publishes QuestionAsked once and never stores it again', async () => {
    const w = world();
    w.state.events = [call()];
    await w.watch.sweep();
    expect(w.state.question?.toolUseId).toBe(CALL_ID);
    expect(w.state.question?.text).toBe('Which mode?');
    expect(w.state.question?.askedAt).toBe(ASKED);
    expect(w.events).toEqual([`asked cody ${CALL_ID}`]);
    await w.watch.sweep();
    await w.watch.sweep();
    expect(w.writes).toEqual([CALL_ID]);
    expect(w.events).toHaveLength(1);
  });

  it('retires it when the transcript carries the call’s result, and never stores the answered call again', async () => {
    const w = world();
    w.state.events = [call()];
    await w.watch.sweep();
    w.state.events = [call(), result()];
    await w.watch.sweep();
    expect(w.state.question).toBeUndefined();
    expect(w.events).toEqual([`asked cody ${CALL_ID}`, `answered cody ${CALL_ID}`]);
    await w.watch.sweep();
    expect(w.writes).toEqual([CALL_ID]);
  });

  it('shows nothing for a call that already has its result (a daemon restart over an old transcript)', async () => {
    const w = world();
    w.state.events = [call(), result()];
    await w.watch.sweep();
    expect(w.writes).toEqual([]);
    expect(w.events).toEqual([]);
  });

  it('keeps the question open while only other events follow it: a turn event is not release evidence', async () => {
    const w = world();
    w.state.events = [call(), chatter];
    await w.watch.sweep();
    expect(w.state.question?.toolUseId).toBe(CALL_ID);
    await w.watch.sweep();
    expect(w.state.question?.toolUseId).toBe(CALL_ID);
  });

  it('never stores a call an answer was stamped for, and clears a stored one (a crash between stamp and clear)', async () => {
    const stamped = world();
    stamped.state.stamp = CALL_ID;
    stamped.state.events = [call()];
    await stamped.watch.sweep();
    expect(stamped.writes).toEqual([]);

    const crashed = world();
    crashed.state.events = [call()];
    await crashed.watch.sweep();
    crashed.state.stamp = CALL_ID;
    await crashed.watch.sweep();
    expect(crashed.state.question).toBeUndefined();
    expect(crashed.events.at(-1)).toBe(`answered cody ${CALL_ID}`);
  });

  it('a later question replaces an earlier one', async () => {
    const w = world();
    w.state.events = [call()];
    await w.watch.sweep();
    w.state.events = [call(), result(), call('call_codex_2', '2026-11-14T01:01:00.000Z' as Instant)];
    await w.watch.sweep();
    expect(w.state.question?.toolUseId).toBe('call_codex_2');
    expect(w.events).toContain('asked cody call_codex_2');
  });

  it('decides nothing while the transcript cannot be read, and shows the question once it can', async () => {
    const w = world();
    w.state.events = 'unreadable';
    await w.watch.sweep();
    expect(w.writes).toEqual([]);
    w.state.events = [call()];
    await w.watch.sweep();
    expect(w.state.question?.toolUseId).toBe(CALL_ID);
  });

  it('looks only at a Codex ferret that is working or idle', async () => {
    const stopped = world({ ferrets: [{ id: 'cody', harness: 'codex', state: 'stopped' }] });
    stopped.state.events = [call()];
    await stopped.watch.sweep();
    const idle = world({ ferrets: [{ id: 'cody', harness: 'codex', state: 'idle' }] });
    idle.state.events = [call()];
    await idle.watch.sweep();
    expect(stopped.writes).toEqual([]);
    expect(idle.writes).toEqual([CALL_ID]);
  });
});
