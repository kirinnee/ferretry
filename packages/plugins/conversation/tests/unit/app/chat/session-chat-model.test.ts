import { describe, expect, test } from 'bun:test';
import {
  fieldHash,
  hasOpenQuestion,
  type JournalEventIdentity,
  journalEventKey,
  PENDING_BADGE,
} from '../../../../app/chat/session-chat-model.ts';
import { ferretView } from '../../../support/app/ferret-view.ts';

const event = (overrides: Partial<JournalEventIdentity> & Record<string, unknown> = {}): JournalEventIdentity =>
  ({
    sequence: 0,
    time: '2026-08-01T10:00:00.000Z',
    sessionId: 's-1',
    turn: 1,
    type: 'chat.assistant.text',
    source: 'claude',
    data: { text: 'hello' },
    ...overrides,
  }) as JournalEventIdentity;

describe('hasOpenQuestion', () => {
  test('believes the daemon’s status', () => {
    expect(hasOpenQuestion(ferretView('s-1', { state: { status: 'awaiting_question' } }))).toBe(true);
  });

  test('believes a pending question the state carried, whatever the status says', () => {
    const view = ferretView('s-1', {
      state: { status: 'running', pendingQuestion: { toolUseId: 't-1', questions: [{ question: 'go?' }] } },
    });
    expect(hasOpenQuestion(view)).toBe(true);
  });

  test('a finished session is never awaiting anything', () => {
    const view = ferretView('s-1', {
      state: { status: 'completed', pendingQuestion: { toolUseId: 't-1', questions: [{ question: 'go?' }] } },
    });
    expect(hasOpenQuestion(view)).toBe(false);
  });

  test('is false for a session and for nothing at all', () => {
    expect(hasOpenQuestion(ferretView('s-1'))).toBe(false);
    expect(hasOpenQuestion(undefined)).toBe(false);
  });
});

describe('fieldHash', () => {
  test('never truncates: two long strings sharing an opening differ', () => {
    const opening = 'Let me check the '.repeat(30);
    expect(fieldHash(`${opening}first thing`)).not.toBe(fieldHash(`${opening}second thing`));
  });

  test('is stable and treats nullish as empty', () => {
    expect(fieldHash('abc')).toBe(fieldHash('abc'));
    expect(fieldHash(null)).toBe(fieldHash(''));
    expect(fieldHash(undefined)).toBe(fieldHash(''));
  });
});

describe('journalEventKey', () => {
  test('uses the daemon’s sequence when it has one, always session-qualified', () => {
    expect(journalEventKey(event({ sequence: 42 }))).toBe('s-1:42');
  });

  test('falls back to a content key for an unsequenced event', () => {
    const key = journalEventKey(event({ sequence: 0 }));
    expect(key.startsWith('s-1:chat.assistant.text:2026-08-01T10:00:00.000Z:')).toBe(true);
    expect(journalEventKey(event({ sequence: 0, data: { text: 'other' } }))).not.toBe(key);
  });

  test('two sessions cannot collide inside one seen-set', () => {
    expect(journalEventKey(event({ sequence: 1 }))).not.toBe(journalEventKey(event({ sequence: 1, sessionId: 's-2' })));
  });

  test('keys an event with no data at all', () => {
    expect(journalEventKey(event({ sequence: 0, data: null }))).toContain('s-1:chat.assistant.text:');
  });
});

describe('PENDING_BADGE', () => {
  test('never claims delivery the daemon cannot see', () => {
    expect(PENDING_BADGE.delivered.label).toBe('accepted — awaiting confirmation');
    expect(PENDING_BADGE.delivered.tone).not.toContain('ok');
    // `queued` keeps its wording: that disposition IS the harness's input queue.
    expect(PENDING_BADGE.queued.label).toBe('queued for next turn');
    expect(PENDING_BADGE.sending.label).toBe('sending');
    expect(PENDING_BADGE.error.label).toBe('failed to send');
  });
});
