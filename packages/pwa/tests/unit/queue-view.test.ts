import { describe, expect, test } from 'bun:test';
import type { QueuedMessage } from '@ferretry/protocol';
import {
  ferretRows,
  fromLabel,
  groupNextSend,
  isWaitingRow,
  nextRowId,
  orderedRows,
  outboxRowOf,
  queuedAgo,
  type QueueGroup,
  queueRowOf,
  rowSend,
  waitingCountLine,
  countRows,
  firstLine,
  limitRows,
  listingGroups,
  listingOf,
  matchesSearch,
  rowStatus,
  STATUS_LABEL,
} from '../../src/lib/queue-view.ts';
import type { OutboxEntry } from '../../src/lib/send-outbox.ts';

const message = (overrides: Partial<QueuedMessage> = {}): QueuedMessage =>
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
    const groups = listingGroups(
      [group('b', late), group('empty', row('read')), group('c', early), group('a', early)],
      'unsent',
      '',
    );
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
  const row = (id: string, state: QueuedMessage['state'], extra: Partial<QueuedMessage> = {}) =>
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

describe('unsent listing order', () => {
  test('the longest-waiting message decides, even when delivery order lists a newer one first', () => {
    const rowsOf = (sessionId: string, items: Partial<QueuedMessage>[]) =>
      ferretRows(
        'd',
        sessionId,
        sessionId,
        items.map(item => message(item)),
        [],
        Date.parse('2026-10-30T12:00:00.000Z'),
      );
    const group = (key: string, rows: ReturnType<typeof rowsOf>) => ({
      key,
      daemonId: 'd',
      machine: 'm',
      sessionId: key,
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
    expect(listingGroups([mid, old], 'unsent', '').map(item => item.key)).toEqual(['old', 'mid']);
  });
});
describe('when a queued message goes', () => {
  const NOW = Date.parse('2026-11-04T11:00:00.000Z');
  const row = (extra: Partial<QueuedMessage> = {}) => queueRowOf('d1', 's1', 'Casen', message(extra));

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
      sessionId: 's1',
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
      sessionId: 's1',
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
      sessionId: 's1',
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

describe('status, listing and search', () => {
  const row = (state: QueuedMessage['state'], extra: Partial<QueuedMessage> = {}) =>
    queueRowOf('d', 's', 'f', message({ state, ...extra }));
  const group = (key: string, ...rows: ReturnType<typeof row>[]) => ({
    key,
    daemonId: 'd',
    machine: 'm',
    sessionId: key,
    ferret: key,
    rows,
  });

  test('every state has one status word, and the two lists split them', () => {
    const states = ['queued', 'typing', 'unconfirmed', 'delivered', 'read', 'failed', 'cancelled'] as const;
    expect(states.map(state => STATUS_LABEL[rowStatus(row(state))])).toEqual([
      'Waiting',
      'Sending',
      'Sending',
      'Delivered',
      'Read',
      'Failed',
      'Cancelled',
    ]);
    expect(STATUS_LABEL[rowStatus(outboxRowOf('f', entry()))]).toBe('Waiting');
    expect(states.map(state => listingOf(row(state)))).toEqual([
      'unsent',
      'unsent',
      'unsent',
      'sent',
      'sent',
      'unsent',
      undefined,
    ]);
  });

  test('the sent list is newest first, ferrets with the newest message first; the unsent list is not reordered', () => {
    const at = (day: number) => `2026-10-${String(day).padStart(2, '0')}T10:00:00.000Z`;
    const a = group('a', row('read', { id: 'a1', enqueuedAt: at(2) }), row('read', { id: 'a2', enqueuedAt: at(9) }));
    const b = group(
      'b',
      row('delivered', { id: 'b1', enqueuedAt: at(20) }),
      row('queued', { id: 'b2', enqueuedAt: at(1) }),
    );
    const sent = listingGroups([a, b], 'sent', '');
    expect(sent.map(item => [item.key, item.rows.map(r => r.id)])).toEqual([
      ['b', ['b1']],
      ['a', ['a2', 'a1']],
    ]);
    expect(listingGroups([a, b], 'unsent', '').map(item => item.rows.map(r => r.id))).toEqual([['b2']]);
  });

  test('search matches the words and the sender, ignoring case and outer spaces', () => {
    const mira = row('queued', { text: 'Deploy blocked', sender: 'agent', by: { kind: 'ferret', name: 'Mira' } });
    const mine = row('queued', { text: 'Please rerun CI' });
    expect(
      ['', '  ', 'DEPLOY', 'mira', ' rerun ', 'you', 'zzz'].map(q => [matchesSearch(mira, q), matchesSearch(mine, q)]),
    ).toEqual([
      [true, true],
      [true, true],
      [true, false],
      [true, false],
      [false, true],
      [false, true],
      [false, false],
    ]);
    expect(listingGroups([group('g', mira, mine)], 'unsent', 'mira').flatMap(g => g.rows)).toEqual([mira]);
  });

  test('limitRows keeps the NEWEST rows across ferrets, each ferret in its own order', () => {
    const at = (hour: number) => `2026-10-30T${String(hour).padStart(2, '0')}:00:00.000Z`;
    // Ferret a is chatty and old-ish; ferret b has the single newest message and one old one.
    const g1 = group(
      'a',
      row('read', { id: 'a3', enqueuedAt: at(11) }),
      row('read', { id: 'a2', enqueuedAt: at(10) }),
      row('read', { id: 'a1', enqueuedAt: at(9) }),
    );
    const g2 = group('b', row('read', { id: 'b2', enqueuedAt: at(12) }), row('read', { id: 'b1', enqueuedAt: at(1) }));
    expect(limitRows([g1, g2], 3).map(g => g.rows.map(r => r.id))).toEqual([['a3', 'a2'], ['b2']]);
    expect(countRows(limitRows([g1, g2], 2))).toBe(2);
    expect(limitRows([g1, g2], 10)).toEqual([g1, g2]);
    expect(limitRows([g1], 0)).toEqual([]);
  });

  test('a message the machine refused is Failed, not Waiting, and stays in the unsent list', () => {
    const refused = outboxRowOf('f', { ...entry(), refused: true });
    expect(STATUS_LABEL[rowStatus(refused)]).toBe('Failed');
    expect(listingOf(refused)).toBe('unsent');
    expect(refused.editable).toBe(true);
    expect(STATUS_LABEL[rowStatus(outboxRowOf('f', entry()))]).toBe('Waiting');
  });

  test('firstLine is the first non-blank line without its markdown mark', () => {
    expect(['\n\n  hello \nworld', '## Title\nbody', '> quoted', '- item', '', 'x'.repeat(400)].map(firstLine)).toEqual(
      ['hello', 'Title', 'quoted', 'item', '', 'x'.repeat(300)],
    );
  });
});
