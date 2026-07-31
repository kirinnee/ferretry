import { describe, expect, it } from 'bun:test';
import { sameAttachmentIds } from '../../src/lib/attachment-ids.ts';
import {
  reconcileLocalSends,
  selectLedgerChips,
  visibleUserRows,
  type LocalSend,
  type VisibleUserRow,
} from '../../src/lib/send-ledger-join.ts';
import type { LedgerSendRecord } from '../../src/lib/send-ledger.ts';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');
const at = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();
const IMAGE = `att_${'a'.repeat(64)}`;
const OTHER_IMAGE = `att_${'b'.repeat(64)}`;
/** Just inside RECORD_CLOCK_SLACK_MS, so a daemon clock slightly behind still joins. */
const WITHIN_SLACK_MS = 4_000;

const record = (over: Partial<LedgerSendRecord> = {}): LedgerSendRecord => ({
  sendId: 'send-1',
  acceptedAt: at(0),
  message: 'continue',
  attachmentIds: [],
  fate: 'accepted',
  ...over,
});

const local = (over: Partial<LocalSend> = {}): LocalSend => ({
  key: 'local-1',
  requestId: 'req-1',
  text: 'continue',
  attachmentIds: [],
  at: NOW,
  ...over,
});

const row = (over: Partial<VisibleUserRow> = {}): VisibleUserRow => ({
  text: 'continue',
  attachmentIds: [],
  at: NOW,
  ...over,
});

describe('attachment identity', () => {
  it('compares attachments as a set, not a sequence', () => {
    expect(sameAttachmentIds([IMAGE, OTHER_IMAGE], [OTHER_IMAGE, IMAGE])).toBe(true);
    expect(sameAttachmentIds([], [])).toBe(true);
    expect(sameAttachmentIds([IMAGE], [])).toBe(false);
    expect(sameAttachmentIds([IMAGE], [OTHER_IMAGE])).toBe(false);
    expect(sameAttachmentIds([IMAGE, IMAGE], [IMAGE, OTHER_IMAGE])).toBe(false);
  });
});

describe('local to durable join', () => {
  it('prefers the idempotency-key identity over any content coincidence', () => {
    const identity = record({ sendId: 'req-1', message: 'something else entirely' });
    const lookalike = record({ sendId: 'send-2', message: 'continue' });
    const result = reconcileLocalSends([local()], [identity, lookalike]);
    expect(result.claimed.get('local-1')).toBe(identity);
    expect(result.unclaimedLocal).toEqual([]);
    expect(result.durable).toEqual([lookalike]);
  });

  it('joins on normalized text plus attachments when there is no id match', () => {
    const durable = record({ sendId: 'send-2', message: '  continue\n\n  now ', attachmentIds: [IMAGE] });
    const result = reconcileLocalSends([local({ text: 'continue now', attachmentIds: [IMAGE] })], [durable]);
    expect(result.claimed.get('local-1')).toBe(durable);
  });

  it('never lowercases or strips whitespace out of existence when matching', () => {
    expect(reconcileLocalSends([local({ text: 'ok' })], [record({ sendId: 's', message: 'OK' })]).claimed.size).toBe(0);
    expect(
      reconcileLocalSends([local({ text: 'ab c' })], [record({ sendId: 's', message: 'a bc' })]).claimed.size,
    ).toBe(0);
  });

  it('refuses a prefix or a differing attachment set', () => {
    expect(
      reconcileLocalSends([local({ text: 'continue' })], [record({ sendId: 's', message: 'continue please' })]).claimed
        .size,
    ).toBe(0);
    expect(
      reconcileLocalSends([local({ attachmentIds: [IMAGE] })], [record({ sendId: 's', attachmentIds: [OTHER_IMAGE] })])
        .claimed.size,
    ).toBe(0);
  });

  it('stops an older identical row from reaping a newer send', () => {
    const older = record({ sendId: 'old', acceptedAt: at(-60_000) });
    const result = reconcileLocalSends([local({ at: NOW })], [older]);
    expect(result.claimed.size).toBe(0);
    expect(result.unclaimedLocal).toHaveLength(1);
    // Inside the clock slack the daemon's slightly-behind stamp still joins.
    const slack = record({ sendId: 'slack', acceptedAt: at(-WITHIN_SLACK_MS) });
    expect(reconcileLocalSends([local({ at: NOW })], [slack]).claimed.size).toBe(1);
  });

  it('assigns identical repeats one-to-one, closest first then FIFO', () => {
    const first = local({ key: 'first', requestId: 'r1', at: NOW });
    const second = local({ key: 'second', requestId: 'r2', at: NOW + 10_000 });
    const early = record({ sendId: 'early', acceptedAt: at(500) });
    const late = record({ sendId: 'late', acceptedAt: at(10_500) });
    const result = reconcileLocalSends([first, second], [early, late]);
    expect(result.claimed.get('first')?.sendId).toBe('early');
    expect(result.claimed.get('second')?.sendId).toBe('late');
    expect(result.durable).toEqual([]);
  });

  it('never collapses two local rows onto one durable row', () => {
    const only = record({ sendId: 'only', acceptedAt: at(1_000) });
    const result = reconcileLocalSends(
      [local({ key: 'a', requestId: 'ra' }), local({ key: 'b', requestId: 'rb' })],
      [only],
    );
    expect(result.claimed.size).toBe(1);
    expect(result.unclaimedLocal).toHaveLength(1);
  });

  it('leaves an unparseable durable instant unjoined rather than guessing', () => {
    expect(reconcileLocalSends([local()], [record({ sendId: 's', acceptedAt: 'whenever' })]).claimed.size).toBe(0);
  });
});

describe('chip selection', () => {
  it('always chips accepted and unaccounted rows, newest first', () => {
    const chips = selectLedgerChips(
      [
        record({ sendId: 'old', acceptedAt: at(-60_000) }),
        record({ sendId: 'new', acceptedAt: at(-1_000), fate: 'unaccounted' }),
      ],
      [],
      NOW,
    );
    expect(chips.map(chip => chip.sendId)).toEqual(['new', 'old']);
  });

  it('keeps a delivered chip when the daemon cited nothing', () => {
    const delivered = record({ fate: 'delivered' });
    expect(selectLedgerChips([delivered], [row({ proofKeys: ['k'] })], NOW)).toHaveLength(1);
  });

  it('keeps a delivered chip when the visible row carries no proof keys', () => {
    const delivered = record({ fate: 'delivered', evidence: { key: 'k' } });
    expect(selectLedgerChips([delivered], [row()], NOW)).toHaveLength(1);
  });

  it('retires a delivered chip only against the exact row the daemon cited', () => {
    const delivered = record({ fate: 'delivered', evidence: { key: 'k' } });
    expect(selectLedgerChips([delivered], [row({ proofKeys: ['k'] })], NOW)).toEqual([]);
    // A row that merely looks the same cannot retire it.
    expect(selectLedgerChips([delivered], [row({ proofKeys: ['other'] })], NOW)).toHaveLength(1);
  });

  it('vetoes a retirement when the cited row disagrees with the record', () => {
    const delivered = record({ fate: 'delivered', evidence: { key: 'k' }, attachmentIds: [IMAGE] });
    const cited = (over: Partial<VisibleUserRow>): VisibleUserRow[] => [
      row({ proofKeys: ['k'], attachmentIds: [IMAGE], ...over }),
    ];
    expect(selectLedgerChips([delivered], cited({}), NOW)).toEqual([]);
    expect(selectLedgerChips([delivered], cited({ text: 'different' }), NOW)).toHaveLength(1);
    expect(selectLedgerChips([delivered], cited({ attachmentIds: [] }), NOW)).toHaveLength(1);
    expect(selectLedgerChips([delivered], cited({ peerName: 'armani' }), NOW)).toHaveLength(1);
    // A row that predates the send by more than the clock slack is not its row.
    expect(selectLedgerChips([delivered], cited({ at: NOW - 60_000 }), NOW)).toHaveLength(1);
  });

  it('matches a peer send against its rendered row with the banner lifted off', () => {
    const delivered = record({
      fate: 'delivered',
      evidence: { key: 'k' },
      message: '[peer message from teammate armani]\nignored line\n\nthe real body',
      fromName: 'armani',
    });
    expect(
      selectLedgerChips([delivered], [row({ proofKeys: ['k'], text: 'the real body', peerName: 'armani' })], NOW),
    ).toEqual([]);
    // Attributed record, unattributed row: different authors.
    expect(selectLedgerChips([delivered], [row({ proofKeys: ['k'], text: 'the real body' })], NOW)).toHaveLength(1);
  });

  it('accepts either the callsign or the session id as the peer identity', () => {
    const bySession = record({ fate: 'delivered', evidence: { key: 'k' }, from: 'sess-a' });
    expect(selectLedgerChips([bySession], [row({ proofKeys: ['k'], peerName: 'sess-a' })], NOW)).toEqual([]);
    expect(selectLedgerChips([bySession], [row({ proofKeys: ['k'], peerName: 'someone-else' })], NOW)).toHaveLength(1);
  });

  it('retires an unambiguous off-page delivered send but never an ambiguous one', () => {
    const offPage = record({ fate: 'delivered', evidence: { key: 'k' }, acceptedAt: at(-600_000) });
    const loaded = [row({ proofKeys: ['other'], text: 'something else', at: NOW - 60_000 })];
    expect(selectLedgerChips([offPage], loaded, NOW)).toEqual([]);
    // An identical body is on screen, so this send cannot be told apart from it.
    const ambiguous = [row({ proofKeys: ['other'], text: 'continue', at: NOW - 60_000 })];
    expect(selectLedgerChips([offPage], ambiguous, NOW)).toHaveLength(1);
    // Nothing loaded at all means no window floor, so the chip stays.
    expect(selectLedgerChips([offPage], [], NOW)).toHaveLength(1);
  });

  it('never retires two delivered sends against one row', () => {
    const first = record({ sendId: 'a', fate: 'delivered', evidence: { key: 'k' }, acceptedAt: at(-1_000) });
    const second = record({ sendId: 'b', fate: 'delivered', evidence: { key: 'k' }, acceptedAt: at(-2_000) });
    expect(selectLedgerChips([first, second], [row({ proofKeys: ['k'] })], NOW)).toHaveLength(1);
  });

  it('drops hard-expired and withdrawn rows from the chip list', () => {
    const expired = record({ sendId: 'expired', hardDeadline: at(-1) });
    const tombstoned = record({ sendId: 'tombstoned', withdrawn: true });
    const alive = record({ sendId: 'alive' });
    expect(selectLedgerChips([expired, tombstoned, alive], [], NOW).map(chip => chip.sendId)).toEqual(['alive']);
    // Withdrawn delivered rows are excluded from both halves too.
    expect(selectLedgerChips([record({ sendId: 'gone', fate: 'delivered', withdrawn: true })], [], NOW)).toEqual([]);
  });
});

describe('transcript projection', () => {
  it('keeps only user blocks and carries proof keys through verbatim', () => {
    expect(
      visibleUserRows([
        { kind: 'assistant', text: 'hello' },
        {
          kind: 'user',
          text: 'continue',
          ts: at(-1_000),
          from: { name: 'armani' },
          attachments: [{ attachmentId: IMAGE }],
          proofKeys: ['k1', 'k2'],
        },
        { kind: 'user' },
      ]),
    ).toEqual([
      {
        text: 'continue',
        attachmentIds: [IMAGE],
        at: NOW - 1_000,
        peerName: 'armani',
        proofKeys: ['k1', 'k2'],
      },
      { text: '', attachmentIds: [], at: 0 },
    ]);
  });
});
