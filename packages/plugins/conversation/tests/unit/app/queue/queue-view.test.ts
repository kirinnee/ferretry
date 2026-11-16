import { describe, expect, test } from 'bun:test';
import type { QueuedMessage } from '../../../../contract/index.ts';
import {
  CLAMP_CHARS,
  CLAMP_LINES,
  ferretRows,
  fromLabel,
  groupNextSend,
  isWaitingRow,
  needsClamp,
  nextRowId,
  orderedRows,
  outboxRowOf,
  queuedAgo,
  type QueueGroup,
  queueRowOf,
  rowSend,
  waitingCountLine,
  waitingGroups,
} from '../../../../app/queue/queue-view.ts';
import type { OutboxEntry } from '../../../../app/composer/send-outbox.ts';
/** A message as a test spells it: plain strings for its instants (the helper casts). */
type LooseMessage = { readonly [K in keyof QueuedMessage]?: unknown };

const message = (overrides: LooseMessage = {}): QueuedMessage =>
  ({
    id: 'q1',
    sender: 'human',
    text: 'hello',
    state: 'queued',
    enqueuedAt: '2026-10-30T10:00:00.000Z',
    revision: 1,
    ...overrides,
  }) as QueuedMessage;

const entry = (overrides: Partial<OutboxEntry> = {}): OutboxEntry => ({
  id: 'o1',
  daemonId: 'd1',
  format: 1,
  ferretId: 's1',
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
    const named = (sender: QueuedMessage['sender'], by?: unknown) =>
      queueRowOf('d', 's', 'f', message({ sender, ...(by === undefined ? {} : { by: by as never }) })).sender;
    expect(named('human')).toBeUndefined();
    expect(named('human', { kind: 'owner' })).toBeUndefined();
    expect(named('agent', { kind: 'ferret', name: 'Mira' })).toBe('Mira');
    expect(named('agent', { kind: 'ferret' })).toBe('A ferret');
    expect(named('daemon', { kind: 'ferretry', feature: 'Board' })).toBe('Ferretry · Board');
    expect(named('daemon', { kind: 'ferretry' })).toBe('Ferretry');
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
      [entry(), entry({ id: 'q1' }), entry({ id: 'x', ferretId: 'other' }), entry({ id: 'y', daemonId: 'd2' })],
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
      ferretId: key,
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

describe('kind, sender and age', () => {
  test("the kind is the sender's label, or action when it set none", () => {
    expect(queueRowOf('d', 's', 'f', message()).kind).toBe('action');
    expect(queueRowOf('d', 's', 'f', message({ label: 'blocker' })).kind).toBe('blocker');
    expect(queueRowOf('d', 's', 'f', message({ label: 'fyi' })).kind).toBe('fyi');
    expect(outboxRowOf('f', entry()).kind).toBe('action');
  });

  test('"You" is the sender when nobody else is named', () => {
    expect(fromLabel(queueRowOf('d', 's', 'f', message()))).toBe('You');
    expect(
      fromLabel(queueRowOf('d', 's', 'f', message({ sender: 'agent', by: { kind: 'ferret', name: 'Mira' } }))),
    ).toBe('Mira');
  });

  test('says how long ago it was queued, and never invents an age', () => {
    const now = Date.parse('2026-10-30T10:30:00.000Z');
    expect(queuedAgo('2026-10-30T10:00:00.000Z', now)).toBe('30m ago');
    expect(queuedAgo('2026-10-30T07:30:00.000Z', now)).toBe('3h ago');
    expect(queuedAgo('2026-10-28T10:30:00.000Z', now)).toBe('2d ago');
    expect(queuedAgo('2026-10-30T10:29:50.000Z', now)).toBe('just now');
    expect(queuedAgo('not a time', now)).toBe('');
  });
});

describe('delivery order and the next message', () => {
  const row = (id: string, state: QueuedMessage['state'], extra: LooseMessage = {}) =>
    queueRowOf('d', 's', 'f', message({ id, state, ...extra }));
  const ferret = { sender: 'agent' as const, by: { kind: 'ferret' as const, name: 'Mira' } };

  test("typing first, then the owner's own, then ferrets in the order the queue accepted them, finished last", () => {
    const rows = orderedRows([
      row('read', 'read', { enqueuedAt: '2026-10-30T09:00:00.000Z' }),
      row('fyi', 'queued', { ...ferret, label: 'fyi', enqueuedAt: '2026-10-30T09:01:00.000Z' }),
      row('action', 'queued', { ...ferret, enqueuedAt: '2026-10-30T09:03:00.000Z' }),
      row('blocker', 'queued', { ...ferret, label: 'blocker', enqueuedAt: '2026-10-30T09:05:00.000Z' }),
      row('mine', 'queued', { enqueuedAt: '2026-10-30T09:09:00.000Z' }),
      row('unconfirmed', 'unconfirmed', { enqueuedAt: '2026-10-30T09:06:00.000Z' }),
      row('typing', 'typing', { enqueuedAt: '2026-10-30T09:07:00.000Z' }),
    ]);
    expect(rows.map(item => item.id)).toEqual(['typing', 'unconfirmed', 'mine', 'fyi', 'action', 'blocker', 'read']);
  });

  test('a due ferret message carries the held ones with it, in acceptance order, ahead of a daemon notice', () => {
    const now = Date.parse('2026-10-30T10:00:00.000Z');
    const daemon = { sender: 'daemon' as const, by: { kind: 'ferretry' as const, feature: 'Board' } };
    const rows = orderedRows(
      [
        row('held', 'queued', {
          ...ferret,
          label: 'fyi',
          holdUntil: '2026-10-30T10:05:00.000Z',
          enqueuedAt: '2026-10-30T08:00:00.000Z',
        }),
        row('board', 'queued', { ...daemon, enqueuedAt: '2026-10-30T08:30:00.000Z' }),
        row('due', 'queued', {
          ...ferret,
          holdUntil: '2026-10-30T09:59:00.000Z',
          enqueuedAt: '2026-10-30T09:00:00.000Z',
        }),
      ],
      now,
    );
    expect(rows.map(item => item.id)).toEqual(['held', 'due', 'board']);
    expect(nextRowId(rows, now)).toBe('held');
  });

  test('with every ferret message still held, a daemon notice may pass them', () => {
    const now = Date.parse('2026-10-30T10:00:00.000Z');
    const rows = orderedRows(
      [
        row('held', 'queued', {
          ...ferret,
          label: 'fyi',
          holdUntil: '2026-10-30T10:05:00.000Z',
          enqueuedAt: '2026-10-30T08:00:00.000Z',
        }),
        row('board', 'queued', {
          sender: 'daemon',
          by: { kind: 'ferretry', feature: 'Board' },
          enqueuedAt: '2026-10-30T09:30:00.000Z',
        }),
      ],
      now,
    );
    expect(rows.map(item => item.id)).toEqual(['board', 'held']);
  });

  test('a ferret author with no name is still a ferret, never "You" and never first', () => {
    const nameless = queueRowOf('d', 's', 'f', message({ sender: 'agent', from: 's9', by: { kind: 'ferret' } }));
    expect(nameless.origin).toBe('ferret');
    expect(fromLabel(nameless)).toBe('s9');
  });

  test('the next one is the first still to come — never one that is being typed or already read', () => {
    expect(nextRowId([row('a', 'typing'), row('b', 'queued', { ...ferret, label: 'fyi' }), row('c', 'queued')])).toBe(
      'c',
    );
    expect(nextRowId([row('a', 'read'), row('b', 'unconfirmed')])).toBeUndefined();
    expect(nextRowId([])).toBeUndefined();
    expect(nextRowId([outboxRowOf('f', entry())])).toBe('o1');
  });

  test('a message queued before `by` existed still names its sender', () => {
    const named = queueRowOf('d', 's', 'f', message({ sender: 'agent', fromName: 'Mira' }));
    expect(fromLabel(named)).toBe('Mira');
    expect(named.origin).toBe('ferret');
    expect(fromLabel(queueRowOf('d', 's', 'f', message({ sender: 'agent', from: 's9' })))).toBe('s9');
    expect(fromLabel(queueRowOf('d', 's', 'f', message({ sender: 'agent' })))).toBe('A ferret');
    expect(fromLabel(queueRowOf('d', 's', 'f', message({ sender: 'daemon' })))).toBe('Ferretry');
    const human = queueRowOf('d', 's', 'f', message({ sender: 'human' }));
    expect(fromLabel(human)).toBe('You');
    expect(human.origin).toBe('owner');
  });
});

describe('needsClamp', () => {
  test('a short message is shown whole; one past the line or character limit folds', () => {
    expect(needsClamp('hello')).toBe(false);
    expect(needsClamp(Array.from({ length: CLAMP_LINES }, () => 'x').join('\n'))).toBe(false);
    expect(needsClamp(Array.from({ length: CLAMP_LINES + 1 }, () => 'x').join('\n'))).toBe(true);
    expect(needsClamp('x'.repeat(CLAMP_CHARS))).toBe(false);
    expect(needsClamp('x'.repeat(CLAMP_CHARS + 1))).toBe(true);
  });

  test('blank edges do not count toward the length', () => {
    expect(needsClamp(`\n\n${'x'.repeat(CLAMP_CHARS)}\n\n`)).toBe(false);
  });
});

describe('waitingGroups order', () => {
  test('the longest-waiting message decides, even when delivery order lists a newer one first', () => {
    const rowsOf = (ferretId: string, items: LooseMessage[]) =>
      ferretRows(
        'd',
        ferretId,
        ferretId,
        items.map(item => message(item)),
        [],
        Date.parse('2026-10-30T12:00:00.000Z'),
      );
    const group = (key: string, rows: ReturnType<typeof rowsOf>) => ({
      key,
      daemonId: 'd',
      machine: 'm',
      ferretId: key,
      ferret: key,
      rows,
    });
    const old = group(
      'old',
      rowsOf('old', [
        { id: 'a', sender: 'agent', holdUntil: '2026-10-30T13:00:00.000Z', enqueuedAt: '2026-10-30T09:00:00.000Z' },
        { id: 'b', sender: 'human', enqueuedAt: '2026-10-30T11:00:00.000Z' },
      ]),
    );
    const mid = group('mid', rowsOf('mid', [{ id: 'c', sender: 'human', enqueuedAt: '2026-10-30T10:00:00.000Z' }]));
    expect(old.rows[0]?.id).toBe('b');
    expect(waitingGroups([mid, old]).map(item => item.key)).toEqual(['old', 'mid']);
  });
});
describe('when a queued message goes', () => {
  const NOW = Date.parse('2026-11-04T11:00:00.000Z');
  const row = (extra: LooseMessage = {}) => queueRowOf('d1', 's1', 'Casen', message(extra));

  test('a hold still running behind a blocker (question, draft, stopped…) promises no time', () => {
    const held = { holdUntil: '2026-11-04T11:20:00.000Z' };
    for (const waitReason of ['question', 'dialog', 'draft', 'unreadable', 'stopped', 'launching']) {
      expect(rowSend(row({ ...held, waitReason: waitReason as never }), NOW)).toBeUndefined();
    }
    expect(rowSend(row({ ...held, waitReason: 'busy' as never }), NOW)).toEqual({ at: held.holdUntil });
    const group = {
      key: 'd1/s1',
      daemonId: 'd1',
      machine: 'Laptop',
      ferretId: 's1',
      ferret: 'Casen',
      rows: [row({ ...held, waitReason: 'question' as never })],
    } as QueueGroup;
    expect(groupNextSend(group, NOW)).toBeUndefined();
  });

  test('a hold still running says when it ends', () => {
    expect(rowSend(row({ holdUntil: '2026-11-04T11:20:00.000Z' }), NOW)).toEqual({ at: '2026-11-04T11:20:00.000Z' });
  });

  test('no hold waits for the turn to end — unless something else is in the way', () => {
    expect(rowSend(row(), NOW)).toEqual({ turn: true });
    expect(rowSend(row({ waitReason: 'busy' as never }), NOW)).toEqual({ turn: true });
    expect(rowSend(row({ waitReason: 'stopped' as never }), NOW)).toBeUndefined();
  });

  test('a hold that is up reads as due now, not as waiting for the turn', () => {
    expect(rowSend(row({ holdUntil: '2026-11-04T10:59:00.000Z' }), NOW)).toEqual({ due: true });
    expect(rowSend(row({ holdUntil: '2026-11-04T11:00:00.000Z' }), NOW)).toEqual({ due: true });
    expect(rowSend(row({ holdUntil: '2026-11-04T11:00:00.001Z' }), NOW)).toEqual({ at: '2026-11-04T11:00:00.001Z' });
  });

  test('an expired hold with a reason in the way still defers to the reason', () => {
    const past = '2026-11-04T10:59:00.000Z';
    expect(rowSend(row({ holdUntil: past, waitReason: 'busy' as never }), NOW)).toEqual({ turn: true });
    expect(rowSend(row({ holdUntil: past, waitReason: 'stopped' as never }), NOW)).toBeUndefined();
  });

  test('only a queued message has a send time', () => {
    expect(rowSend(row({ state: 'read' }), NOW)).toBeUndefined();
    expect(rowSend(outboxRowOf('Casen', entry()), NOW)).toBeUndefined();
  });

  test('a ferret’s next send is its earliest hold, else its turn’s end', () => {
    const at = (hold: string) => row({ id: hold, holdUntil: hold });
    const group = (rows: ReturnType<typeof row>[]): QueueGroup => ({
      key: 'k',
      daemonId: 'd1',
      machine: 'M',
      ferretId: 's1',
      ferret: 'Casen',
      rows,
    });
    expect(
      groupNextSend(group([at('2026-11-04T11:30:00.000Z'), at('2026-11-04T11:20:00.000Z'), row({ id: 'plain' })]), NOW),
    ).toEqual({ at: '2026-11-04T11:20:00.000Z' });
    expect(groupNextSend(group([row({ id: 'plain' })]), NOW)).toEqual({ turn: true });
    expect(groupNextSend(group([row({ waitReason: 'stopped' as never })]), NOW)).toBeUndefined();
    expect(groupNextSend(group([]), NOW)).toBeUndefined();
  });

  test('a due row is the ferret’s next send, ahead of any later hold or turn', () => {
    const at = (id: string, hold: string) => row({ id, holdUntil: hold });
    const group = (rows: ReturnType<typeof row>[]): QueueGroup => ({
      key: 'k',
      daemonId: 'd1',
      machine: 'M',
      ferretId: 's1',
      ferret: 'Casen',
      rows,
    });
    const later = at('later', '2026-11-04T11:20:00.000Z');
    for (const hold of ['2026-11-04T10:59:00.000Z', '2026-11-04T11:00:00.000Z']) {
      expect(groupNextSend(group([later, at('due', hold)]), NOW)).toEqual({ due: true });
      expect(groupNextSend(group([at('due', hold), later, row({ id: 'plain' })]), NOW)).toEqual({ due: true });
    }
    expect(groupNextSend(group([later, at('soon', '2026-11-04T11:00:00.001Z')]), NOW)).toEqual({
      at: '2026-11-04T11:00:00.001Z',
    });
  });
});
