import { describe, expect, test } from 'bun:test';
import {
  CANCELLED_ROW_LIFETIME_MS,
  isSettledUndelivered,
  nextSettledChange,
  placeLedgerRows,
  SETTLED_FRESH_MS,
  SETTLED_ROW_LIFETIME_MS,
  sendRowId,
  settledForm,
  visibleSettledSends,
} from '../../src/lib/ledger-placement.ts';
import type { SendViewState } from '../../src/lib/send-dismissals.ts';
import type { LedgerSendRecord } from '../../src/lib/send-ledger.ts';
import type { TranscriptEntry } from '../../src/lib/session-screens.ts';

const T0 = Date.parse('2026-10-21T09:00:00.000Z');
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

const send = (overrides: Partial<LedgerSendRecord> = {}): LedgerSendRecord => ({
  sendId: 'send-1',
  acceptedAt: iso(0),
  message: 'hi',
  attachmentIds: [],
  fate: 'cancelled',
  path: 'direct',
  ...overrides,
});

const row = (id: string, kind: TranscriptEntry['kind'], at?: number, text = id): TranscriptEntry => ({
  id,
  kind,
  text,
  ...(at === undefined ? {} : { at }),
});

const view = (dismissed: string[] = [], expanded: string[] = []): SendViewState => ({
  dismissed: new Set(dismissed),
  expanded: new Set(expanded),
});

const ids = (rows: readonly TranscriptEntry[]): string[] => rows.map(entry => entry.id);

describe('isSettledUndelivered', () => {
  test('is a cancelled or given-up send nothing is still trying to deliver', () => {
    expect(isSettledUndelivered(send())).toBe(true);
    expect(isSettledUndelivered(send({ fate: 'timed_out' }))).toBe(true);
    expect(isSettledUndelivered(send({ fate: 'unaccounted' }))).toBe(true);
    expect(isSettledUndelivered(send({ fate: 'timed_out', held: true }))).toBe(false);
    expect(isSettledUndelivered(send({ withdrawn: true }))).toBe(false);
    expect(isSettledUndelivered(send({ fate: 'queued' }))).toBe(false);
    expect(isSettledUndelivered(send({ fate: 'delivered' }))).toBe(false);
  });
});

describe('settledForm', () => {
  test('is the whole bubble while fresh, a note after, and the whole bubble again once opened', () => {
    const cancelled = send({ fateAt: iso(0) });
    expect(settledForm(cancelled, T0 + SETTLED_FRESH_MS - 1)).toBe('fresh');
    expect(settledForm(cancelled, T0 + SETTLED_FRESH_MS)).toBe('slim');
    expect(settledForm(cancelled, T0 + SETTLED_FRESH_MS, new Set(['send-1']))).toBe('expanded');
  });

  test('falls back to when it was sent, and is a note when no time can be read', () => {
    expect(settledForm(send({ acceptedAt: iso(0) }), T0 + 1)).toBe('fresh');
    expect(settledForm(send({ acceptedAt: 'not a date' }), T0)).toBe('slim');
  });
});

describe('visibleSettledSends', () => {
  test('lists terminal sends oldest first, without dismissed or retired ones', () => {
    const records = [
      send({ sendId: 'late', acceptedAt: iso(3_000) }),
      send({ sendId: 'dismissed', acceptedAt: iso(2_000) }),
      send({ sendId: 'failed', fate: 'timed_out', acceptedAt: iso(1_000) }),
      send({ sendId: 'old', fateAt: iso(-CANCELLED_ROW_LIFETIME_MS) }),
      send({ sendId: 'open', fate: 'queued' }),
    ];
    const actual = visibleSettledSends(records, T0 + 5_000, view(['dismissed']));
    expect(actual.map(record => record.sendId)).toEqual(['failed', 'late']);
  });

  test('keeps an old cancelled send the reader opened', () => {
    const records = [send({ sendId: 'old', fateAt: iso(-CANCELLED_ROW_LIFETIME_MS) })];
    expect(visibleSettledSends(records, T0, view())).toEqual([]);
    expect(visibleSettledSends(records, T0, view([], ['old'])).map(record => record.sendId)).toEqual(['old']);
  });

  test('defaults to a view with nothing dismissed or opened', () => {
    expect(visibleSettledSends([send()], T0 + 1_000)).toHaveLength(1);
  });
});

describe('placeLedgerRows with terminal sends', () => {
  const conversation = [
    row('u1', 'user', T0 - 60_000, 'earlier'),
    row('a1', 'assistant', T0 + 5_000, 'working'),
    row('a2', 'assistant', T0 + 9_000, 'done'),
  ];

  test('puts a cancelled note in the timeline at the time it was sent, never under the conversation', () => {
    const placed = placeLedgerRows(conversation, [send({ fateAt: iso(1_000) })], T0 + 20_000);
    expect(ids(placed)).toEqual(['u1', sendRowId('send-1'), 'a1', 'a2']);
    expect(placed[1]).toMatchObject({ kind: 'ledger', placement: 'chronological', settled: 'slim' });
  });

  test('keeps notes in the order they were sent and leaves the live send under the conversation', () => {
    const placed = placeLedgerRows(
      conversation,
      [
        send({ sendId: 'live', fate: 'queued', acceptedAt: iso(8_000) }),
        send({ sendId: 'second', fate: 'timed_out', acceptedAt: iso(2_000) }),
        send({ sendId: 'first', acceptedAt: iso(1_000) }),
      ],
      T0 + 20_000,
    );
    expect(ids(placed)).toEqual(['u1', 'send:first', 'send:second', 'a1', 'a2', 'send:live']);
  });

  test('says when a note is older than everything loaded, and when it has no time at all', () => {
    const placed = placeLedgerRows(
      conversation,
      [
        send({ sendId: 'ancient', fate: 'timed_out', acceptedAt: iso(-3_600_000) }),
        send({ sendId: 'undated', acceptedAt: 'nope' }),
      ],
      T0 + 20_000,
    );
    expect(ids(placed)).toEqual(['send:ancient', 'u1', 'a1', 'a2', 'send:undated']);
    expect(placed[0]).toMatchObject({ placement: 'before-loaded' });
    expect(placed[4]).toMatchObject({ placement: 'unknown-time' });
  });

  test('a note in an empty conversation is simply there, and rows without a time never move it', () => {
    const only = placeLedgerRows([], [send()], T0 + 20_000);
    expect(only[0]).toMatchObject({ placement: 'chronological' });
    const placed = placeLedgerRows([row('x', 'system'), row('y', 'user', T0 + 5_000)], [send()], T0 + 20_000);
    expect(ids(placed)).toEqual(['x', 'send:send-1', 'y']);
  });

  test('draws it as a note, the whole bubble, or nothing as the reader acts and time passes', () => {
    const cancelled = send({ fateAt: iso(0) });
    expect(placeLedgerRows(conversation, [cancelled], T0 + 1_000)[1]?.settled).toBe('fresh');
    expect(placeLedgerRows(conversation, [cancelled], T0 + 60_000)[1]?.settled).toBe('slim');
    expect(placeLedgerRows(conversation, [cancelled], T0 + 60_000, view([], ['send-1']))[1]?.settled).toBe('expanded');
    expect(ids(placeLedgerRows(conversation, [cancelled], T0 + 60_000, view(['send-1'])))).toEqual(ids(conversation));
    expect(ids(placeLedgerRows(conversation, [cancelled], T0 + CANCELLED_ROW_LIFETIME_MS))).toEqual(ids(conversation));
  });

  test('a failed send retires after a day, a cancelled one after ten minutes', () => {
    const failed = send({ fate: 'timed_out' });
    expect(ids(placeLedgerRows([], [failed], T0 + SETTLED_ROW_LIFETIME_MS - 1))).toEqual(['send:send-1']);
    expect(ids(placeLedgerRows([], [failed], T0 + SETTLED_ROW_LIFETIME_MS))).toEqual([]);
  });

  test('a dismissed undelivered send is not drawn, but the same send delivered is still the message', () => {
    const dismissed = view(['send-1']);
    expect(ids(placeLedgerRows([], [send({ fate: 'queued' })], T0, dismissed))).toEqual([]);
    const delivered = send({ fate: 'delivered', message: 'hi', evidence: { key: 'k', observedAt: iso(500) } });
    const placed = placeLedgerRows([row('u', 'user', T0 + 500, 'hi')], [delivered], T0 + 20_000, dismissed);
    expect(placed[0]).toMatchObject({ id: sendRowId('send-1'), send: { sendId: 'send-1' } });
  });

  test('a cancelled send repair finds in the transcript turns into the delivered message in place', () => {
    const asNote = placeLedgerRows([row('u', 'user', T0 + 500, 'hi')], [send()], T0 + 60_000);
    expect(ids(asNote)).toEqual(['send:send-1', 'u']);
    expect(asNote[0]?.kind).toBe('ledger');
    const repaired = send({ fate: 'delivered', evidence: { key: 'k', observedAt: iso(500) } });
    const asMessage = placeLedgerRows([row('u', 'user', T0 + 500, 'hi')], [repaired], T0 + 60_000);
    expect(asMessage).toHaveLength(1);
    expect(asMessage[0]).toMatchObject({ id: sendRowId('send-1'), kind: 'user', send: { fate: 'delivered' } });
    expect(asMessage[0]?.settled).toBeUndefined();
  });
});

describe('nextSettledChange', () => {
  test('is the moment the nearest fresh bubble folds or note retires, and nothing when none will', () => {
    expect(nextSettledChange([], T0)).toBeUndefined();
    expect(nextSettledChange([send({ fateAt: iso(0) })], T0 + 1_000)).toBe(T0 + SETTLED_FRESH_MS);
    expect(nextSettledChange([send({ fateAt: iso(0) })], T0 + SETTLED_FRESH_MS)).toBe(T0 + CANCELLED_ROW_LIFETIME_MS);
    expect(nextSettledChange([send({ fateAt: iso(0) })], T0 + CANCELLED_ROW_LIFETIME_MS)).toBeUndefined();
  });

  test('takes the earliest of several, ignores opened notes, and retires a failed send a day after it was sent', () => {
    const failed = send({ sendId: 'failed', fate: 'timed_out', acceptedAt: iso(0) });
    const fresh = send({ sendId: 'fresh', fateAt: iso(20_000) });
    const opened = send({ sendId: 'opened', fateAt: iso(15_000) });
    expect(nextSettledChange([failed, fresh, opened], T0 + 21_000, view([], ['opened']))).toBe(
      T0 + 20_000 + SETTLED_FRESH_MS,
    );
    expect(nextSettledChange([failed], T0 + SETTLED_FRESH_MS)).toBe(T0 + SETTLED_ROW_LIFETIME_MS);
  });

  test('has nothing to schedule for a send whose time cannot be read', () => {
    expect(nextSettledChange([send({ acceptedAt: 'nope' })], T0)).toBeUndefined();
    expect(nextSettledChange([send({ fate: 'timed_out', acceptedAt: 'nope' })], T0)).toBeUndefined();
  });
});
