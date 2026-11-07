import { describe, expect, test } from 'bun:test';
import { hideWaiting, isWaitingSend } from '../../../../app/chat/waiting-fold.ts';
import type { LedgerSendRecord } from '../../../../app/chat/send-ledger.ts';
import type { TranscriptEntry } from '../../../../app/chat/transcript-entries.ts';

type QueueView = NonNullable<LedgerSendRecord['queue']>;

const queue = (state: QueueView['state'], extra: Partial<QueueView> = {}): QueueView => ({
  state,
  stateAt: '2026-11-04T11:00:00.000Z',
  revision: 1,
  ...extra,
});

const send = (overrides: Partial<LedgerSendRecord> = {}): LedgerSendRecord => ({
  sendId: 's1',
  acceptedAt: '2026-11-04T11:00:00.000Z',
  message: 'hello',
  attachmentIds: [],
  fate: 'accepted',
  ...overrides,
});

const row = (id: string, ledger: LedgerSendRecord, extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  id,
  kind: 'ledger',
  text: ledger.message,
  ledger,
  placement: 'chronological',
  ...extra,
});

describe('isWaitingSend', () => {
  test('a message in the machine’s queue, on this device, or held waits', () => {
    expect(isWaitingSend(send({ queue: queue('queued') }))).toBe(true);
    expect(
      isWaitingSend(send({ queue: queue('queued'), outbox: { reason: 'waiting for connection', position: 1, of: 1 } })),
    ).toBe(true);
    expect(isWaitingSend(send({ held: true }))).toBe(true);
    expect(isWaitingSend(send({ fate: 'queued' }))).toBe(true);
  });

  test('a ferret’s held note waits too, whoever sent it', () => {
    expect(isWaitingSend(send({ from: 'tomi', fromName: 'tomi', queue: queue('queued') }))).toBe(true);
  });

  test('what needs the person is not waiting, so it stays in the chat', () => {
    expect(isWaitingSend(send({ queue: queue('failed', { failure: 'no' }), fate: 'timed_out' }))).toBe(false);
    expect(isWaitingSend(send({ fate: 'timed_out', retryable: true }))).toBe(false);
    expect(isWaitingSend(send({ fate: 'unaccounted', queue: queue('unconfirmed') }))).toBe(false);
    expect(
      isWaitingSend(send({ queue: queue('queued'), outbox: { reason: 'refused', refused: true, position: 1, of: 1 } })),
    ).toBe(false);
    expect(isWaitingSend(send({ typedNotSent: true }))).toBe(false);
  });

  test('a message being typed, a delivered one and a cancelled one are not waiting', () => {
    expect(isWaitingSend(send({ queue: queue('typing') }))).toBe(false);
    expect(isWaitingSend(send({ fate: 'delivered', queue: queue('queued') }))).toBe(false);
    expect(isWaitingSend(send({ fate: 'cancelled', queue: queue('queued') }))).toBe(false);
    expect(isWaitingSend(send())).toBe(false);
  });
});

describe('hideWaiting', () => {
  test('drops the waiting cards and keeps everything else in place', () => {
    const entries: TranscriptEntry[] = [
      { id: 'u1', kind: 'user', text: 'earlier' },
      row('send:q', send({ sendId: 'q', queue: queue('queued') })),
      row('send:f', send({ sendId: 'f', fate: 'timed_out', retryable: true })),
      row('send:n', send({ sendId: 'n', fate: 'cancelled' }), { settled: 'slim' }),
    ];
    expect(hideWaiting(entries).map(entry => entry.id)).toEqual(['u1', 'send:f', 'send:n']);
  });

  test('a delivered message wearing its transcript row is never hidden', () => {
    const worn: TranscriptEntry = {
      id: 'send:d',
      kind: 'user',
      text: 'hi',
      send: send({ sendId: 'd', queue: queue('queued') }),
    };
    expect(hideWaiting([worn])).toEqual([worn]);
  });

  test('returns the same array when nothing waits', () => {
    const entries: TranscriptEntry[] = [{ id: 'u1', kind: 'user', text: 'x' }];
    expect(hideWaiting(entries)).toBe(entries);
  });
});
