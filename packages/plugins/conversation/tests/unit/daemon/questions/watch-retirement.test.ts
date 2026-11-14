import { describe, expect, it } from 'bun:test';
import type { Instant } from '@ferretry/std';
import type { Question } from '../../../../contract/index.ts';
import type { TranscriptEvent } from '../../../../daemon/seams/transcript-types.ts';
import {
  QUESTION_DEEP_EVENTS,
  QUESTION_TAIL_EVENTS,
  QuestionWatch,
  type QuestionWatchDeps,
} from '../../../../daemon/questions/lib/watch.ts';

/**
 * A stored Codex question must be released by ITS OWN tool-result however the bounded tail looks, and never by anything
 * less (review rv-retirement, round 1): the transcript read is the newest 200 events, so a call that left it, or an
 * earlier question behind a later one, projects to nothing even though the exact result is right there.
 */

const ASKED = '2026-11-14T01:00:00.000Z' as Instant;
const callEvent = (id: string): TranscriptEvent =>
  ({
    kind: 'tool-call',
    timestamp: ASKED,
    call: {
      id,
      name: 'request_user_input',
      input: {},
      questions: [{ question: 'Choose a fixture', multiple: false, options: [{ label: 'One' }, { label: 'Two' }] }],
    },
  }) as unknown as TranscriptEvent;
const resultEvent = (id: string): TranscriptEvent =>
  ({ kind: 'tool-result', result: { callId: id } }) as unknown as TranscriptEvent;
const filler = (count: number, label = 'fixture event'): TranscriptEvent[] =>
  Array.from(
    { length: count },
    (_, i) => ({ kind: 'message', role: 'assistant', text: `${label} ${i}` }) as unknown as TranscriptEvent,
  );

type Read = readonly TranscriptEvent[] | 'unreadable';

function world(first: TranscriptEvent[]) {
  const state = {
    events: first as Read,
    wide: undefined as Read | undefined,
    current: undefined as Question | undefined,
  };
  const cleared: string[] = [];
  const limits: (number | undefined)[] = [];
  const answered: string[] = [];
  const deps: QuestionWatchDeps = {
    roster: async () => [{ id: 'cody', harness: 'codex', state: 'working' }],
    harness: async () => undefined,
    current: async () => state.current,
    lastAnswered: async () => undefined,
    write: async () => undefined,
    clear: async (_ferret, id) => {
      cleared.push(id);
      state.current = undefined;
    },
    asked: async () => undefined,
    answered: async (_ferret, id) => void answered.push(id),
    transcriptEvents: async (_ferret, limit) => {
      limits.push(limit);
      return limit !== undefined && limit > QUESTION_TAIL_EVENTS && state.wide !== undefined
        ? state.wide
        : state.events;
    },
    writeProjected: async (_ferret, pending) =>
      (state.current = {
        format: 1,
        toolUseId: pending.toolUseId,
        text: 'Choose a fixture',
        options: [{ label: 'One' }, { label: 'Two' }],
        multiple: false,
        askedAt: ASKED,
      }),
  };
  return { state, cleared, limits, answered, watch: new QuestionWatch(deps) };
}

describe('a stored Codex question is retired by its exact result, wherever the tail cut falls', () => {
  it('retires when only the exact result survives in the newest 200 events, without its call (rv-retirement fixture)', async () => {
    const callId = 'call_review_fixture';
    const w = world([callEvent(callId)]);
    await w.watch.sweep();
    expect(w.state.current?.toolUseId).toBe(callId);
    // Answered in the native terminal; only the result remains in the newest 200 events.
    w.state.events = [resultEvent(callId), ...filler(QUESTION_TAIL_EVENTS - 1)];
    await w.watch.sweep();
    await w.watch.sweep();
    expect(w.cleared).toEqual([callId]);
    expect(w.state.current).toBeUndefined();
    expect(w.answered).toEqual([callId]);
  });

  it('retires a stored Q1 whose result is in the tail behind a later Q2 and its result (Q1/R1/Q2/R2)', async () => {
    const w = world([callEvent('q1')]);
    await w.watch.sweep();
    expect(w.state.current?.toolUseId).toBe('q1');
    w.state.events = [callEvent('q1'), resultEvent('q1'), callEvent('q2'), resultEvent('q2')];
    await w.watch.sweep();
    expect(w.cleared).toEqual(['q1']);
    expect(w.state.current).toBeUndefined();
  });

  it('releases only the stored question: another question’s result in the tail is not its release', async () => {
    const w = world([callEvent('q1')]);
    await w.watch.sweep();
    w.state.events = [resultEvent('someone-else'), ...filler(10)];
    await w.watch.sweep();
    expect(w.cleared).toEqual([]);
    expect(w.state.current?.toolUseId).toBe('q1');
  });

  it('keeps it while its call is in the tail with no result, however many other events follow (a turn is not release)', async () => {
    const w = world([callEvent('q1')]);
    await w.watch.sweep();
    w.state.events = [callEvent('q1'), ...filler(QUESTION_TAIL_EVENTS - 1)];
    await w.watch.sweep();
    expect(w.cleared).toEqual([]);
    // The call is in the tail, so the wider read is never made.
    expect(w.limits.every(limit => limit === undefined)).toBe(true);
  });

  it('decides nothing from a short tail that names neither call nor result (the transcript simply does not say)', async () => {
    const w = world([callEvent('q1')]);
    await w.watch.sweep();
    w.state.events = filler(5);
    await w.watch.sweep();
    await w.watch.sweep();
    expect(w.cleared).toEqual([]);
    expect(w.state.current?.toolUseId).toBe('q1');
    expect(w.limits.every(limit => limit === undefined)).toBe(true);
  });
});

describe('positive release recovery when both the call and the result left the newest tail', () => {
  const full = (): TranscriptEvent[] => filler(QUESTION_TAIL_EVENTS);

  it('finds the exact result in the wider read and releases', async () => {
    const w = world([callEvent('q1')]);
    await w.watch.sweep();
    w.state.events = full();
    w.state.wide = [resultEvent('q1'), ...filler(QUESTION_DEEP_EVENTS - 1)];
    await w.watch.sweep();
    expect(w.limits).toContain(QUESTION_DEEP_EVENTS);
    expect(w.cleared).toEqual(['q1']);
  });

  it('keeps it when the wider read still holds its call with no result', async () => {
    const w = world([callEvent('q1')]);
    await w.watch.sweep();
    w.state.events = full();
    w.state.wide = [callEvent('q1'), ...filler(QUESTION_DEEP_EVENTS - 1)];
    await w.watch.sweep();
    expect(w.cleared).toEqual([]);
    expect(w.state.current?.toolUseId).toBe('q1');
  });

  it('releases when a FULL wider read holds neither: the call is older than a form can stay open under', async () => {
    const w = world([callEvent('q1')]);
    await w.watch.sweep();
    w.state.events = full();
    w.state.wide = filler(QUESTION_DEEP_EVENTS);
    await w.watch.sweep();
    expect(w.cleared).toEqual(['q1']);
    expect(w.answered).toEqual(['q1']);
  });

  it('does not release on a wider read that is not full and names neither (not positive evidence)', async () => {
    const w = world([callEvent('q1')]);
    await w.watch.sweep();
    w.state.events = full();
    w.state.wide = filler(QUESTION_TAIL_EVENTS + 50);
    await w.watch.sweep();
    expect(w.cleared).toEqual([]);
    expect(w.state.current?.toolUseId).toBe('q1');
  });

  it('never releases on an unreadable wider read, and releases once it can be read', async () => {
    const w = world([callEvent('q1')]);
    await w.watch.sweep();
    w.state.events = full();
    w.state.wide = 'unreadable';
    await w.watch.sweep();
    expect(w.cleared).toEqual([]);
    w.state.wide = [resultEvent('q1'), ...filler(10)];
    await w.watch.sweep();
    expect(w.cleared).toEqual(['q1']);
  });

  it('never releases while the tail itself cannot be read', async () => {
    const w = world([callEvent('q1')]);
    await w.watch.sweep();
    w.state.events = 'unreadable';
    await w.watch.sweep();
    expect(w.cleared).toEqual([]);
    expect(w.limits.at(-1)).toBeUndefined();
  });
});
