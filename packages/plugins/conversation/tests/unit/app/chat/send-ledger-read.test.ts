import { describe, expect, it } from 'bun:test';
import { SendListResponseSchema } from '../../../../contract/index.ts';
import { fakeClient } from '../../../support/app/fake-client.ts';
import {
  LEDGER_UNREAD_GRACE_MS,
  type LedgerSendRecord,
  ledgerFeed,
  markLedgerUnread,
  parseLedgerSendsResponse,
  readLedgerSends,
} from '../../../../app/chat/send-ledger.ts';

/**
 * Where a phone's message went, when the ledger read is the part that broke.
 *
 * The owner's phone showed a message as "Sending" for as long as anyone looked. Two reads of the
 * ledger could each leave it there: a page the typed client refused whole, and a read that failed and
 * was dropped. These cases are the read and the row it leaves.
 */

const NOW = Date.parse('2026-10-20T03:30:00.000Z');
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

const record = (over: Partial<LedgerSendRecord> = {}): LedgerSendRecord => ({
  sendId: 'send-1',
  acceptedAt: at(-60_000),
  message: 'hi',
  attachmentIds: [],
  fate: 'accepted',
  ...over,
});

/** A daemon a release ahead of this bundle: a delivered row citing an evidence tier nobody here knows. */
const NEWER_DAEMON_PAGE = {
  sends: [
    {
      v: 1,
      sendId: 'send-1',
      acceptedAt: at(-60_000),
      acceptedTurn: 3,
      path: 'direct',
      message: 'hi',
      attachmentIds: [],
      fate: 'delivered',
      fateAt: at(-58_000),
      evidence: {
        key: 'codex:c-1',
        harness: 'codex',
        kind: 'response_item',
        proof: 'normal-user-record',
        observedAt: at(-58_000),
        shapeVersion: 1,
        matchedTurn: 4,
        tier: 'composer-echo',
      },
    },
    {
      v: 1,
      sendId: 'send-2',
      acceptedAt: at(-30_000),
      acceptedTurn: 4,
      path: 'direct',
      message: 'hello',
      attachmentIds: [],
      fate: 'queued',
    },
  ],
};

const SENDS = 'GET /v1/ferrets/:ferretId/sends';

describe('reading a ferret ledger', () => {
  it('should keep every row of a page the strict schema rejects whole', async () => {
    // Arrange
    const client = fakeClient({ [SENDS]: () => NEWER_DAEMON_PAGE });

    // Act
    const strict = SendListResponseSchema.safeParse(NEWER_DAEMON_PAGE).success;
    const rows = parseLedgerSendsResponse(await readLedgerSends(client, 'fy_s_one'));

    // Assert
    expect(strict).toBe(false);
    expect(rows.map(row => [row.sendId, row.fate])).toEqual([
      ['send-1', 'delivered'],
      ['send-2', 'queued'],
    ]);
    expect(rows[0]?.evidence).toEqual({
      key: 'codex:c-1',
      kind: 'response_item',
      harness: 'codex',
      proof: 'normal-user-record',
      observedAt: at(-58_000),
      matchedTurn: 4,
      shapeVersion: 1,
    });
    expect(client.calls).toEqual([{ route: SENDS, init: { params: { ferretId: 'fy_s_one' } } }]);
  });

  it('should hand the rows back unparsed, so what the daemon sent is what the chat reads', async () => {
    // Arrange
    const client = fakeClient({ [SENDS]: () => [{ sendId: 'a', acceptedAt: at(0) }] });

    // Act
    const rows = await readLedgerSends(client, 'fy s/1');

    // Assert
    expect(rows).toEqual([{ sendId: 'a', acceptedAt: at(0) }]);
    expect(client.calls[0]?.init.params).toEqual({ ferretId: 'fy s/1' });
  });
});

describe('a ledger this browser can no longer read', () => {
  it('should say so on every open row once the grace has passed, and leave settled rows alone', () => {
    // Arrange
    const rows = [
      record({ sendId: 'open' }),
      record({ sendId: 'queued', fate: 'queued' }),
      record({ sendId: 'done', fate: 'delivered' }),
      record({ sendId: 'lost', fate: 'timed_out' }),
    ];

    // Act
    const marked = markLedgerUnread(rows, {
      reason: 'fyd did not answer within 20s',
      lastReadAt: NOW - LEDGER_UNREAD_GRACE_MS,
      nowMs: NOW,
    });

    // Assert
    const unread = { since: at(-LEDGER_UNREAD_GRACE_MS), reason: 'fyd did not answer within 20s' };
    expect(marked.map(row => [row.sendId, row.unread])).toEqual([
      ['open', unread],
      ['queued', unread],
      ['done', undefined],
      ['lost', undefined],
    ]);
  });

  it('should not flicker a row for one read that failed inside the grace', () => {
    // Arrange
    const rows = [record()];

    // Act
    const marked = markLedgerUnread(rows, { reason: 'dropped', lastReadAt: NOW - 1_000, nowMs: NOW });

    // Assert
    expect(marked).toEqual(rows);
    expect(marked).not.toBe(rows);
  });

  it('should feed each read through, and mark rows from the last read that worked', () => {
    // Arrange
    let clock = NOW;
    let rows: readonly LedgerSendRecord[] = [];
    const feed = ledgerFeed(
      next => {
        rows = typeof next === 'function' ? next(rows) : next;
      },
      () => clock,
    );

    // Act
    clock = NOW + 3_000;
    feed.onSends([record()]);
    clock = NOW + 6_000;
    feed.onSendsFailed('blip');
    const afterBlip = rows;
    clock = NOW + 3_000 + LEDGER_UNREAD_GRACE_MS;
    feed.onSendsFailed('could not reach fyd');

    // Assert
    expect(afterBlip[0]?.unread).toBeUndefined();
    expect(rows[0]?.unread).toEqual({ since: at(3_000), reason: 'could not reach fyd' });
  });

  it('should count a workspace that never read its ledger from when it opened', () => {
    // Arrange
    let rows: readonly LedgerSendRecord[] = [record()];
    const feed = ledgerFeed(next => {
      rows = typeof next === 'function' ? next(rows) : next;
    });

    // Act
    feed.onSendsFailed('never answered');

    // Assert
    expect(rows[0]?.unread).toBeUndefined();
  });
});
