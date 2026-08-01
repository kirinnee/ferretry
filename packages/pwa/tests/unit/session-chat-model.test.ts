import { describe, expect, test } from 'bun:test';
import type { FyEvent } from '@ferretry/protocol';
import {
  blockConfirmsPending,
  CHAT_PAGE_SIZE,
  type ChatRecord,
  eventToRecord,
  fieldHash,
  hasOpenQuestion,
  journalEventKey,
  PENDING_BADGE,
  questionSurfaceRecord,
  recordConfirmsPending,
  recordKey,
  requestIdForLedgerResend,
} from '../../src/components/session-chat-model.ts';
import { sessionView } from '../support/sessions.ts';

const SENT_AT = Date.parse('2026-08-01T10:00:00.000Z');

const userRecord = (text: string, timestamp: string): ChatRecord => ({
  source: 'claude',
  timestamp,
  type: 'chat.user',
  data: { text },
});

const event = (overrides: Partial<FyEvent> = {}): FyEvent =>
  ({
    sequence: 0,
    time: '2026-08-01T10:00:00.000Z',
    sessionId: 's-1',
    turn: 1,
    type: 'chat.assistant.text',
    source: 'claude',
    data: { text: 'hello' },
    ...overrides,
  }) as FyEvent;

describe('recordConfirmsPending', () => {
  test('reaps the optimistic bubble with the record it became', () => {
    expect(
      recordConfirmsPending(userRecord('ship it', '2026-08-01T10:00:01.000Z'), { text: 'ship it', at: SENT_AT }),
    ).toBe(true);
  });

  test('tolerates a harness clock that sits behind the browser’s', () => {
    expect(
      recordConfirmsPending(userRecord('ship it', '2026-08-01T09:59:57.000Z'), { text: 'ship it', at: SENT_AT }),
    ).toBe(true);
  });

  test('never reaps against an identical OLDER message', () => {
    expect(
      recordConfirmsPending(userRecord('ship it', '2026-08-01T09:30:00.000Z'), { text: 'ship it', at: SENT_AT }),
    ).toBe(false);
  });

  test('refuses a record another author demonstrably sent', () => {
    const peer = userRecord('[from ms-9] ship it', '2026-08-01T10:00:01.000Z');
    expect(recordConfirmsPending(peer, { text: 'ship it', at: SENT_AT })).toBe(false);
  });

  test('only ever matches a chat.user record', () => {
    const assistant: ChatRecord = {
      source: 'claude',
      timestamp: '2026-08-01T10:00:01.000Z',
      type: 'chat.assistant.text',
      data: { text: 'ship it' },
    };
    expect(recordConfirmsPending(assistant, { text: 'ship it', at: SENT_AT })).toBe(false);
  });

  test('treats an unparsable timestamp as the epoch rather than throwing', () => {
    expect(recordConfirmsPending(userRecord('ship it', 'not-a-date'), { text: 'ship it', at: SENT_AT })).toBe(false);
    expect(recordConfirmsPending({ source: 'claude', type: 'chat.user', data: {} }, { text: '', at: 0 })).toBe(true);
  });
});

describe('blockConfirmsPending', () => {
  const block = (overrides: Record<string, unknown> = {}) => ({
    kind: 'user',
    ts: '2026-08-01T10:00:01.000Z',
    text: 'ship it',
    ...overrides,
  });

  test('matches on text, time and the exact attachment set', () => {
    expect(blockConfirmsPending(block(), { text: 'ship it', at: SENT_AT })).toBe(true);
    expect(
      blockConfirmsPending(block({ attachments: [{ attachmentId: 'a-1' }] }), {
        text: 'ship it',
        at: SENT_AT,
        attachmentIds: ['a-1'],
      }),
    ).toBe(true);
  });

  test('a text-identical message with different files is a different message', () => {
    expect(
      blockConfirmsPending(block({ attachments: [{ attachmentId: 'a-2' }] }), {
        text: 'ship it',
        at: SENT_AT,
        attachmentIds: ['a-1'],
      }),
    ).toBe(false);
  });

  test('never matches a peer block or a non-user block', () => {
    expect(blockConfirmsPending(block({ from: 'ms-9' }), { text: 'ship it', at: SENT_AT })).toBe(false);
    expect(blockConfirmsPending(block({ kind: 'assistant' }), { text: 'ship it', at: SENT_AT })).toBe(false);
  });

  test('never matches a block older than the send', () => {
    expect(blockConfirmsPending(block({ ts: '2026-08-01T09:30:00.000Z' }), { text: 'ship it', at: SENT_AT })).toBe(
      false,
    );
  });

  test('an empty send with no attachments confirms nothing', () => {
    expect(blockConfirmsPending(block({ text: '' }), { text: '', at: SENT_AT })).toBe(false);
  });

  test('an attachment-only send confirms on the files alone', () => {
    expect(
      blockConfirmsPending(block({ text: '', attachments: [{ attachmentId: 'a-1' }] }), {
        text: '',
        at: SENT_AT,
        attachmentIds: ['a-1'],
      }),
    ).toBe(true);
  });
});

describe('requestIdForLedgerResend', () => {
  test('a resend never inherits the identity it is replacing', () => {
    expect(requestIdForLedgerResend('old-id', () => 'fresh-id')).toBe('fresh-id');
  });

  test('mints again through a single collision', () => {
    const minted = ['old-id', 'second-id'];
    expect(requestIdForLedgerResend('old-id', () => minted.shift()!)).toBe('second-id');
  });

  test('refuses rather than quietly mutating the audit trail', () => {
    expect(() => requestIdForLedgerResend('old-id', () => 'old-id')).toThrow('could not mint a new send identity');
  });

  test('mints a real identity by default', () => {
    expect(requestIdForLedgerResend('old-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('hasOpenQuestion', () => {
  test('believes the daemon’s status', () => {
    expect(hasOpenQuestion(sessionView('s-1', { state: { status: 'awaiting_question' } }))).toBe(true);
  });

  test('believes a pending question the state carried, whatever the status says', () => {
    const view = sessionView('s-1', {
      state: { status: 'running', pendingQuestion: { toolUseId: 't-1', questions: [{ question: 'go?' }] } },
    });
    expect(hasOpenQuestion(view)).toBe(true);
  });

  test('a finished session is never awaiting anything', () => {
    const view = sessionView('s-1', {
      state: { status: 'completed', pendingQuestion: { toolUseId: 't-1', questions: [{ question: 'go?' }] } },
    });
    expect(hasOpenQuestion(view)).toBe(false);
  });

  test('is false for a session and for nothing at all', () => {
    expect(hasOpenQuestion(sessionView('s-1'))).toBe(false);
    expect(hasOpenQuestion(undefined)).toBe(false);
  });
});

describe('questionSurfaceRecord', () => {
  test('prefers the real question whenever there is one', () => {
    const real: ChatRecord = { source: 'claude', type: 'interaction.question', data: { question: 'go?' } };
    expect(questionSurfaceRecord(sessionView('s-1'), real)).toBe(real);
  });

  test('mounts an escapable placeholder while the status leads the payload', () => {
    const view = sessionView('s-1', { config: { harness: 'codex' }, state: { status: 'awaiting_question', turn: 7 } });
    const surface = questionSurfaceRecord(view, null);
    expect(surface?.type).toBe('interaction.question');
    expect(surface?.source).toBe('codex');
    // Turn-bound, so it is stable across store refreshes.
    expect(surface?.timestamp).toBe('status-only:s-1:7');
    expect(surface?.data).toEqual({ question: 'Question details have not loaded yet.' });
  });

  test('falls back to claude when the config carries no harness', () => {
    const view = sessionView('s-1', { state: { status: 'awaiting_question' } });
    expect(questionSurfaceRecord(view, null)?.source).toBe('claude');
  });

  test('hides nothing when there is no open question at all', () => {
    expect(questionSurfaceRecord(sessionView('s-1'), null)).toBeUndefined();
    expect(questionSurfaceRecord(undefined, null)).toBeUndefined();
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

describe('eventToRecord', () => {
  test('projects a chat event and carries the harness identity through', () => {
    const record = eventToRecord(event({ recordUuid: 'r-1', blockIndex: 2 }));
    expect(record).toEqual({
      source: 'claude',
      timestamp: '2026-08-01T10:00:00.000Z',
      type: 'chat.assistant.text',
      data: { text: 'hello' },
      recordUuid: 'r-1',
      blockIndex: 2,
    });
  });

  test('prefers the payload’s own source and timestamp', () => {
    const record = eventToRecord(
      event({ data: { text: 'hi', source: 'codex', timestamp: '2026-01-01T00:00:00.000Z' } }),
    );
    expect(record?.source).toBe('codex');
    expect(record?.timestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  test('falls back to claude for an unrecognised source', () => {
    expect(eventToRecord(event({ source: 'gemini' }))?.source).toBe('claude');
  });

  test('refuses anything that is not part of the conversation', () => {
    expect(eventToRecord(event({ type: 'terminal.frame' }))).toBeNull();
    expect(eventToRecord(event({ data: null }))).toBeNull();
    expect(eventToRecord(event({ data: 'not an object' }))).toBeNull();
  });

  test('accepts every conversation event type', () => {
    for (const type of [
      'chat.user',
      'chat.assistant.text',
      'chat.assistant.thinking',
      'chat.assistant.reasoning',
      'tool.use',
      'tool.result',
      'interaction.question',
      'interaction.answer',
      'turn.started',
      'turn.completed',
      'turn.aborted',
    ])
      expect(eventToRecord(event({ type }))?.type).toBe(type);
  });
});

describe('recordKey', () => {
  test('uses the harness’s exact id when it has one', () => {
    const record: ChatRecord = { source: 'claude', type: 'chat.user', recordUuid: 'r-1', blockIndex: 3, data: {} };
    expect(recordKey(record)).toBe('claude|chat.user|r-1|3');
    expect(recordKey({ ...record, blockIndex: undefined })).toBe('claude|chat.user|r-1|');
  });

  test('one identity is shared by the live frame and its history twin', () => {
    const live = eventToRecord(event({ recordUuid: 'r-1', blockIndex: 0 }))!;
    const history: ChatRecord = {
      source: 'claude',
      timestamp: 'a-completely-different-time',
      type: 'chat.assistant.text',
      data: { text: 'hello' },
      recordUuid: 'r-1',
      blockIndex: 0,
    };
    expect(recordKey(live)).toBe(recordKey(history));
  });

  test('two long messages sharing an opening are NOT the same record', () => {
    const opening = 'Let me check the '.repeat(30);
    const at = '2026-08-01T10:00:00.000Z';
    const first: ChatRecord = {
      source: 'claude',
      timestamp: at,
      type: 'chat.assistant.text',
      data: { text: `${opening}A` },
    };
    const second: ChatRecord = {
      source: 'claude',
      timestamp: at,
      type: 'chat.assistant.text',
      data: { text: `${opening}B` },
    };
    expect(recordKey(first)).not.toBe(recordKey(second));
  });

  test('signs every field the transcript distinguishes records by', () => {
    const key = recordKey({
      source: 'codex',
      timestamp: '2026-08-01T10:00:00.000Z',
      type: 'tool.result',
      data: { text: 'out', thinking: 'th', reasoning: 're', toolUseId: 't-1', isError: true },
    });
    expect(key).toContain('t=');
    expect(key).toContain('th=');
    expect(key).toContain('r=');
    expect(key).toContain('id=t-1');
    expect(key).toContain('e=true');
  });

  test('keys a record with no data and no timestamp', () => {
    expect(recordKey({ source: 'claude', type: 'turn.started' })).toBe('claude|turn.started||');
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

describe('CHAT_PAGE_SIZE', () => {
  test('is the page the daemon is asked for', () => {
    expect(CHAT_PAGE_SIZE).toBe(200);
  });
});
