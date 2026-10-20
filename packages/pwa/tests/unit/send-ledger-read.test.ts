import { describe, expect, it } from 'bun:test';
import type { IFyHttpTransport } from '@ferretry/protocol';
import { FyApiClient } from '@ferretry/protocol/client';
import {
  LEDGER_READ_TIMEOUT_MS,
  LEDGER_UNREAD_GRACE_MS,
  type LedgerSendRecord,
  ledgerFeed,
  markLedgerUnread,
  parseLedgerSendsResponse,
  readLedgerSends,
} from '../../src/lib/send-ledger.ts';

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

/** The real typed client over a transport that serves one fixed answer, recording what it was asked. */
const clientServing = (body: unknown) => {
  const asked: { readonly url: string; readonly signal: AbortSignal | null | undefined }[] = [];
  const transport: IFyHttpTransport = {
    send: async (url, init) => {
      asked.push({ url, signal: init.signal });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
  const connecting = FyApiClient.connect({
    baseUrl: 'http://127.0.0.1:7431',
    token: 'fy_dev_x',
    version: '4.53.1',
    transport,
  });
  return { connecting, asked };
};

describe('reading a session ledger', () => {
  it('should keep every row of a page from a newer daemon, which the typed client rejects whole', async () => {
    // Arrange
    const { connecting, asked } = clientServing(NEWER_DAEMON_PAGE);
    const client = await connecting;

    // Act
    const strict = await client.sends('fy_s_one').then(
      () => 'parsed',
      () => 'rejected',
    );
    const rows = parseLedgerSendsResponse(await readLedgerSends(client, 'fy_s_one'));

    // Assert
    expect(strict).toBe('rejected');
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
    expect(asked.at(-1)?.url).toBe('http://127.0.0.1:7431/v1/sessions/fy_s_one/sends');
  });

  it('should ask for the ledger under its own short deadline and encode the session id', async () => {
    // Arrange
    const calls: unknown[][] = [];
    const api = {
      request: async (...args: unknown[]) => {
        calls.push(args);
        return [{ sendId: 'a', acceptedAt: at(0) }];
      },
    } as unknown as Parameters<typeof readLedgerSends>[0];

    // Act
    const rows = await readLedgerSends(api, 'fy s/1');

    // Assert — unparsed, so the session cache keeps exactly what the daemon sent.
    expect(rows).toEqual([{ sendId: 'a', acceptedAt: at(0) }]);
    expect(calls[0]?.[0]).toBe('/v1/sessions/fy%20s%2F1/sends');
    expect(calls[0]?.[3]).toBe(LEDGER_READ_TIMEOUT_MS);
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
