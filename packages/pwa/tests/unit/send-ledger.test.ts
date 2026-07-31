import { describe, expect, it } from 'bun:test';
import {
  foldLedgerSendRecords,
  hasLedgerHardExpired,
  isLedgerUnconfirmed,
  isSendLedgerEvent,
  nextLedgerViewDeadline,
  parseLedgerSendRecord,
  parseLedgerSendsResponse,
  RECORD_CLOCK_SLACK_MS,
  type LedgerSendRecord,
} from '../../src/lib/send-ledger.ts';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();
const ATTACHMENT = `att_${'a'.repeat(64)}`;

const record = (over: Partial<LedgerSendRecord> = {}): LedgerSendRecord => ({
  sendId: 'send-1',
  acceptedAt: at(-60_000),
  message: 'continue',
  attachmentIds: [],
  fate: 'accepted',
  ...over,
});

describe('send ledger read model', () => {
  it('keeps a row visible when the daemon reports a fate this build has never heard of', () => {
    const parsed = parseLedgerSendRecord({ sendId: 's', acceptedAt: at(0), fate: 'teleported' });
    expect(parsed?.fate).toBe('accepted');
  });

  it('drops a row only when it has no usable identity', () => {
    expect(parseLedgerSendRecord({ acceptedAt: at(0) })).toBeNull();
    expect(parseLedgerSendRecord({ sendId: 's' })).toBeNull();
    expect(parseLedgerSendRecord(null)).toBeNull();
    expect(parseLedgerSendRecord(['s'])).toBeNull();
    expect(parseLedgerSendRecord('s')).toBeNull();
    expect(parseLedgerSendRecord({ sendId: 's', acceptedAt: at(0) })?.message).toBe('');
  });

  it('carries every known field through and omits the ones the daemon left out', () => {
    const parsed = parseLedgerSendRecord({
      sendId: 'send-9',
      acceptedAt: at(-1_000),
      message: 'ship it',
      attachmentIds: [ATTACHMENT, 'not-an-attachment', 7],
      fate: 'delivered',
      v: 1,
      acceptedTurn: 4,
      path: 'native-inline',
      matchText: 'ship it',
      turn: 5,
      from: 'sess-a',
      fromName: 'armani',
      replyExpected: true,
      held: true,
      withdrawn: true,
      fateAt: at(-500),
      unaccountedReason: 'timeout',
      opportunityAt: at(-800),
      unaccountedDeadline: at(600),
      hardDeadline: at(9_000),
      timeoutFrozenAt: at(-400),
    });
    expect(parsed).toEqual({
      sendId: 'send-9',
      acceptedAt: at(-1_000),
      message: 'ship it',
      attachmentIds: [ATTACHMENT],
      fate: 'delivered',
      v: 1,
      acceptedTurn: 4,
      path: 'native-inline',
      matchText: 'ship it',
      turn: 5,
      from: 'sess-a',
      fromName: 'armani',
      replyExpected: true,
      held: true,
      withdrawn: true,
      fateAt: at(-500),
      unaccountedReason: 'timeout',
      opportunityAt: at(-800),
      unaccountedDeadline: at(600),
      hardDeadline: at(9_000),
      timeoutFrozenAt: at(-400),
    });
    const sparse = parseLedgerSendRecord({ sendId: 's', acceptedAt: at(0), path: 'carrier-pigeon', turn: Number.NaN });
    expect(Object.hasOwn(sparse ?? {}, 'path')).toBe(false);
    expect(Object.hasOwn(sparse ?? {}, 'turn')).toBe(false);
    expect(sparse?.replyExpected).toBeUndefined();
  });

  it('drops a citation with no key but keeps the fate the daemon decided', () => {
    const parsed = parseLedgerSendRecord({
      sendId: 's',
      acceptedAt: at(0),
      fate: 'delivered',
      evidence: { harness: 'claude', tier: 'exact-text' },
    });
    expect(parsed?.evidence).toBeUndefined();
    expect(parsed?.fate).toBe('delivered');
    expect(parseLedgerSendRecord({ sendId: 's', acceptedAt: at(0), evidence: 'nope' })?.evidence).toBeUndefined();
    expect(parseLedgerSendRecord({ sendId: 's', acceptedAt: at(0), evidence: null })?.evidence).toBeUndefined();
  });

  it('keeps a usable citation while dropping only the enum values it cannot read', () => {
    const parsed = parseLedgerSendRecord({
      sendId: 's',
      acceptedAt: at(0),
      evidence: {
        key: 'record-1',
        kind: 'chat.user',
        tier: 'from-the-future',
        harness: 'codex',
        proof: 'native-queue-drain',
        observedAt: at(-10),
        originatedAt: at(-20),
        matchedTurn: 3,
        shapeVersion: 2,
      },
    });
    expect(parsed?.evidence).toEqual({
      key: 'record-1',
      kind: 'chat.user',
      harness: 'codex',
      proof: 'native-queue-drain',
      observedAt: at(-10),
      originatedAt: at(-20),
      matchedTurn: 3,
      shapeVersion: 2,
    });
  });

  it('reads both the envelope and a bare array, dropping unusable rows individually', () => {
    const rows = [{ sendId: 'a', acceptedAt: at(0) }, { acceptedAt: at(0) }, { sendId: 'b', acceptedAt: at(-1) }];
    expect(parseLedgerSendsResponse({ sends: rows }).map(row => row.sendId)).toEqual(['a', 'b']);
    expect(parseLedgerSendsResponse(rows).map(row => row.sendId)).toEqual(['a', 'b']);
    expect(parseLedgerSendsResponse({ sends: 'nope' })).toEqual([]);
    expect(parseLedgerSendsResponse(null)).toEqual([]);
  });

  it('expires an open row at its hard deadline and never a delivered, held or withdrawn one', () => {
    expect(hasLedgerHardExpired(record({ hardDeadline: at(-1) }), NOW)).toBe(true);
    expect(hasLedgerHardExpired(record({ hardDeadline: at(1) }), NOW)).toBe(false);
    expect(hasLedgerHardExpired(record({ hardDeadline: at(-1), fate: 'delivered' }), NOW)).toBe(false);
    expect(hasLedgerHardExpired(record({ hardDeadline: at(-1), held: true }), NOW)).toBe(false);
    expect(hasLedgerHardExpired(record({ hardDeadline: at(-1), withdrawn: true }), NOW)).toBe(false);
  });

  it('keeps a row with a missing or malformed deadline visible rather than hiding it', () => {
    expect(hasLedgerHardExpired(record(), NOW)).toBe(false);
    expect(hasLedgerHardExpired(record({ hardDeadline: 'soon' }), NOW)).toBe(false);
    expect(isLedgerUnconfirmed(record({ unaccountedDeadline: 'soon' }), NOW)).toBe(false);
  });

  it('treats an accepted row past its sweep deadline as unconfirmed', () => {
    expect(isLedgerUnconfirmed(record(), NOW)).toBe(false);
    expect(isLedgerUnconfirmed(record({ unaccountedDeadline: at(-1) }), NOW)).toBe(true);
    expect(isLedgerUnconfirmed(record({ unaccountedDeadline: at(1) }), NOW)).toBe(false);
    expect(isLedgerUnconfirmed(record({ fate: 'unaccounted' }), NOW)).toBe(true);
    expect(isLedgerUnconfirmed(record({ fate: 'delivered', unaccountedDeadline: at(-1) }), NOW)).toBe(false);
    expect(isLedgerUnconfirmed(record({ held: true, fate: 'unaccounted' }), NOW)).toBe(false);
    expect(isLedgerUnconfirmed(record({ withdrawn: true, fate: 'unaccounted' }), NOW)).toBe(false);
  });

  it('schedules the earliest future presentation change, ignoring past and settled rows', () => {
    const records = [
      record({ sendId: 'a', unaccountedDeadline: at(-5_000), hardDeadline: at(60_000) }),
      record({ sendId: 'b', unaccountedDeadline: at(20_000), hardDeadline: at(90_000) }),
      record({ sendId: 'c', fate: 'delivered', hardDeadline: at(1_000) }),
      record({ sendId: 'd', held: true, hardDeadline: at(2_000) }),
      record({ sendId: 'e', withdrawn: true, hardDeadline: at(3_000) }),
    ];
    expect(nextLedgerViewDeadline(records, NOW)).toBe(NOW + 20_000);
    // An unaccounted row can only still reach its hard cap.
    expect(
      nextLedgerViewDeadline([record({ fate: 'unaccounted', unaccountedDeadline: at(10), hardDeadline: at(50) })], NOW),
    ).toBe(NOW + 50);
    expect(nextLedgerViewDeadline([record()], NOW)).toBeUndefined();
    expect(nextLedgerViewDeadline([], NOW)).toBeUndefined();
  });

  it('refreshes on ledger events and ignores the legacy compat pair', () => {
    expect(isSendLedgerEvent({ type: 'control.send_accepted' })).toBe(true);
    expect(isSendLedgerEvent({ type: 'control.send_delivered' })).toBe(true);
    expect(isSendLedgerEvent({ type: 'control.send_unaccounted' })).toBe(true);
    expect(isSendLedgerEvent({ type: 'control.send_withdrawn' })).toBe(true);
    expect(isSendLedgerEvent({ type: 'control.send_queued' })).toBe(false);
    expect(isSendLedgerEvent({ type: 'control.send_consumed' })).toBe(false);
  });

  it('folds out-of-order snapshots without ever walking a fate back down', () => {
    const accepted = record({ fate: 'accepted' });
    const delivered = record({ fate: 'delivered' });
    expect(foldLedgerSendRecords([delivered], [accepted])[0]?.fate).toBe('delivered');
    expect(foldLedgerSendRecords([accepted], [delivered])[0]?.fate).toBe('delivered');
    const unaccounted = record({ fate: 'unaccounted' });
    expect(foldLedgerSendRecords([unaccounted], [accepted])[0]?.fate).toBe('unaccounted');
    // Equal rank still replaces, so refreshed deadlines land.
    const refreshed = record({ opportunityAt: at(-10) });
    expect(foldLedgerSendRecords([accepted], [refreshed])[0]?.opportunityAt).toBe(at(-10));
  });

  it('lets a genuine retry under the same id revive a tombstoned send', () => {
    const withdrawn = record({ withdrawn: true, acceptedAt: at(-60_000) });
    const retried = record({ acceptedAt: at(-1_000) });
    expect(foldLedgerSendRecords([withdrawn], [retried])).toHaveLength(1);
    expect(foldLedgerSendRecords([retried], [withdrawn])).toHaveLength(1);
    // A stale snapshot of the same attempt may not undo the tombstone.
    expect(foldLedgerSendRecords([withdrawn], [record({ acceptedAt: at(-60_000) })])).toHaveLength(0);
  });

  it('drops tombstones from the result only after they have superseded their row', () => {
    const open = record({ fate: 'accepted' });
    const tombstone = record({ withdrawn: true });
    expect(foldLedgerSendRecords([open], [tombstone])).toEqual([]);
    expect(foldLedgerSendRecords([tombstone], [open])).toEqual([]);
  });

  it('returns rows newest first and tolerates an unparseable accepted instant', () => {
    const rows = foldLedgerSendRecords([
      record({ sendId: 'old', acceptedAt: at(-90_000) }),
      record({ sendId: 'new', acceptedAt: at(-1_000) }),
      record({ sendId: 'broken', acceptedAt: 'whenever' }),
    ]);
    expect(rows.map(row => row.sendId)).toEqual(['new', 'old', 'broken']);
    expect(foldLedgerSendRecords()).toEqual([]);
  });

  it('publishes the clock slack the local join is allowed to use', () => {
    expect(RECORD_CLOCK_SLACK_MS).toBe(5_000);
  });
});
