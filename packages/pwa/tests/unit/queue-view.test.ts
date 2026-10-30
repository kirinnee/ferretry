import { describe, expect, test } from 'bun:test';
import type { QueuedMessage } from '@ferretry/protocol';
import {
  ferretRows,
  isWaitingRow,
  orderedRows,
  outboxRowOf,
  queueRowOf,
  waitingCountLine,
  waitingGroups,
} from '../../src/lib/queue-view.ts';
import type { OutboxEntry } from '../../src/lib/send-outbox.ts';

const message = (overrides: Partial<QueuedMessage> = {}): QueuedMessage =>
  ({
    id: 'q1',
    text: 'hello',
    state: 'queued',
    enqueuedAt: '2026-10-30T10:00:00.000Z',
    revision: 1,
    ...overrides,
  }) as QueuedMessage;

const entry = (overrides: Partial<OutboxEntry> = {}): OutboxEntry => ({
  id: 'o1',
  daemonId: 'd1',
  sessionId: 's1',
  message: 'thank you',
  attachmentIds: [],
  files: [],
  now: false,
  createdAt: '2026-10-30T10:00:05.000Z',
  seq: 1,
  ...overrides,
});

describe('queueRowOf', () => {
  test('a queued message is editable and says why it waits', () => {
    expect(queueRowOf('d1', 's1', 'Casen', message()).why).toBe('waiting for its turn');
    const row = queueRowOf('d1', 's1', 'Casen', message({ waitReason: 'busy' as never }));
    expect(row.why.startsWith('waiting — ')).toBe(true);
    expect(row.editable).toBe(true);
    expect(row.sender).toBeUndefined();
  });

  test('every other state has a plain sentence, a failure its own, and is not editable', () => {
    for (const state of ['typing', 'delivered', 'read', 'unconfirmed', 'cancelled', 'failed'] as const) {
      const row = queueRowOf('d1', 's1', 'Casen', message({ state }));
      expect(row.editable).toBe(false);
      expect(row.why.length).toBeGreaterThan(0);
    }
    expect(queueRowOf('d1', 's1', 'Casen', message({ state: 'failed', failure: 'tmux is gone' })).why).toBe(
      'tmux is gone',
    );
  });

  test('names a sender that is not the owner, as a chip', () => {
    const by = (value: unknown) => queueRowOf('d', 's', 'f', message({ by: value as never })).sender;
    expect(by({ kind: 'owner' })).toBeUndefined();
    expect(by({ kind: 'ferret', name: 'Mira' })).toBe('Mira');
    expect(by({ kind: 'ferret' })).toBeUndefined();
    expect(by({ kind: 'feature', feature: 'Board' })).toBe('Ferretry · Board');
    expect(by({ kind: 'feature' })).toBe('Ferretry');
  });
});

describe('outboxRowOf', () => {
  test('is tick 1: saved, editable, with the waiting sentence or the refusal', () => {
    expect(outboxRowOf('Casen', entry())).toMatchObject({
      state: 'saved',
      editable: true,
      why: 'waiting for connection',
    });
    const refused = outboxRowOf('Casen', entry({ reason: 'Files must be 20 MiB or smaller', refused: true }));
    expect(refused.why).toBe('Files must be 20 MiB or smaller');
    expect(refused.refused).toBe(true);
  });
});

describe('ferretRows', () => {
  test('joins queue and outbox once each, oldest first, dropping cancelled and other ferrets', () => {
    const rows = ferretRows(
      'd1',
      's1',
      'Casen',
      [
        message({ id: 'q2', enqueuedAt: '2026-10-30T10:00:09.000Z' }),
        message({ state: 'cancelled', id: 'q3' }),
        message(),
      ],
      [entry(), entry({ id: 'q1' }), entry({ id: 'x', sessionId: 'other' }), entry({ id: 'y', daemonId: 'd2' })],
    );
    expect(rows.map(row => row.id)).toEqual(['q1', 'o1', 'q2']);
  });

  test('ties break on id', () => {
    const at = '2026-10-30T10:00:00.000Z';
    expect(
      orderedRows([
        queueRowOf('d', 's', 'f', message({ id: 'b', enqueuedAt: at })),
        queueRowOf('d', 's', 'f', message({ id: 'a', enqueuedAt: at })),
      ]).map(row => row.id),
    ).toEqual(['a', 'b']);
  });
});

describe('waiting', () => {
  test('which rows count, and which ferrets show longest-waiting first', () => {
    const row = (state: QueuedMessage['state']) => queueRowOf('d', 's', 'f', message({ state }));
    expect(
      ['queued', 'typing', 'unconfirmed', 'delivered', 'read', 'failed'].map(s => isWaitingRow(row(s as never))),
    ).toEqual([true, true, true, false, false, false]);
    expect(isWaitingRow(outboxRowOf('f', entry()))).toBe(true);

    const group = (key: string, ...rows: ReturnType<typeof row>[]) => ({
      key,
      daemonId: 'd',
      machine: 'm',
      sessionId: key,
      ferret: key,
      rows,
    });
    const early = queueRowOf('d', 's', 'f', message({ enqueuedAt: '2026-10-30T09:00:00.000Z' }));
    const late = queueRowOf('d', 's', 'f', message({ enqueuedAt: '2026-10-30T11:00:00.000Z' }));
    const groups = waitingGroups([group('b', late), group('empty', row('read')), group('c', early), group('a', early)]);
    expect(groups.map(item => item.key)).toEqual(['a', 'c', 'b']);
  });

  test('the count line', () => {
    expect([0, 1, 3].map(waitingCountLine)).toEqual([
      'nothing is waiting',
      '1 message is waiting',
      '3 messages are waiting',
    ]);
  });
});
