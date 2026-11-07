import { describe, expect, test } from 'bun:test';
import { turnFileInstruction } from '../../../../contract/index.ts';
import { transcriptEntriesFromLog } from '../../../../app/chat/chat-refresh.ts';
import {
  handedOverDraft,
  isOwnSend,
  LANDING_GRACE_MS,
  placeLedgerRows,
  sendRowId,
} from '../../../../app/chat/ledger-placement.ts';
import type { LedgerSendRecord } from '../../../../app/chat/send-ledger.ts';
import type { TranscriptEntry } from '../../../../app/chat/transcript-entries.ts';

const T0 = Date.parse('2026-10-21T09:00:00.000Z');
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

const send = (overrides: Partial<LedgerSendRecord> = {}): LedgerSendRecord => ({
  sendId: 'send-1',
  acceptedAt: iso(0),
  message: 'ship it',
  attachmentIds: [],
  fate: 'accepted',
  path: 'direct',
  ...overrides,
});

const user = (id: string, text: string, atOffset?: number, extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  id,
  kind: 'user',
  text,
  ...(atOffset === undefined ? {} : { at: T0 + atOffset }),
  ...extra,
});

/** What the reader sees: each row's id and the send it wears, if any. */
const shape = (rows: readonly TranscriptEntry[]) =>
  rows.map(row => ({ id: row.id, kind: row.kind, send: row.send?.sendId ?? row.ledger?.sendId }));

describe('a send that has landed in the transcript before the daemon confirmed it', () => {
  test('is worn by the row it became, under the same key its bubble had, and is not drawn twice', () => {
    const before = placeLedgerRows([user('a', 'earlier', -60_000)], [send()], T0 + 1_000);
    expect(shape(before)).toEqual([
      { id: 'a', kind: 'user', send: undefined },
      { id: sendRowId('send-1'), kind: 'ledger', send: 'send-1' },
    ]);

    const landed = placeLedgerRows([user('a', 'earlier', -60_000), user('b', 'ship it', 1_000)], [send()], T0 + 2_000);
    expect(shape(landed)).toEqual([
      { id: 'a', kind: 'user', send: undefined },
      { id: sendRowId('send-1'), kind: 'user', send: 'send-1' },
    ]);
    // It wears the send's OWN fate: the browser never decides that it was delivered.
    expect(landed[1]?.send?.fate).toBe('accepted');

    const confirmed = placeLedgerRows(
      [user('a', 'earlier', -60_000), user('b', 'ship it', 1_000)],
      [send({ fate: 'delivered', fateAt: iso(1_500), evidence: { key: 'k', observedAt: iso(1_000) } })],
      T0 + 3_000,
    );
    expect(shape(confirmed)).toEqual(shape(landed));
    expect(confirmed[1]?.send?.fate).toBe('delivered');
  });

  test('is matched through whitespace a composer or a harness adds, and never across case', () => {
    expect(shape(placeLedgerRows([user('b', ' ship   it\n', 0)], [send()], T0))).toEqual([
      { id: sendRowId('send-1'), kind: 'user', send: 'send-1' },
    ]);
    expect(shape(placeLedgerRows([user('b', 'Ship it', 0)], [send()], T0))).toEqual([
      { id: 'b', kind: 'user', send: undefined },
      { id: sendRowId('send-1'), kind: 'ledger', send: 'send-1' },
    ]);
  });

  test('is never claimed by an identical OLDER message, nor by a row it cannot be timed against', () => {
    const older = placeLedgerRows([user('a', 'ship it', -60_000)], [send()], T0);
    expect(shape(older).map(row => row.kind)).toEqual(['user', 'ledger']);
    const untimed = placeLedgerRows([user('a', 'ship it')], [send()], T0);
    expect(shape(untimed).map(row => row.kind)).toEqual(['user', 'ledger']);
    const undated = placeLedgerRows([user('a', 'ship it', 0)], [send({ acceptedAt: 'not a date' })], T0);
    expect(shape(undated).map(row => row.kind)).toEqual(['user', 'ledger']);
    // Within the clock slack it is still the same message: the harness's clock can sit behind.
    const skewed = placeLedgerRows([user('a', 'ship it', -2_000)], [send()], T0);
    expect(shape(skewed)).toEqual([{ id: sendRowId('send-1'), kind: 'user', send: 'send-1' }]);
  });

  test('is matched by identity when it travelled as a turn file or a queued file', () => {
    const rows = placeLedgerRows(
      [
        user('t', 'Read the file …', undefined, { handoff: { kind: 'turn', name: 'turn-009', turn: 9, path: '/t' } }),
        user('q', 'Read the queued message file …', undefined, {
          handoff: { kind: 'queued', name: 'queued-send-q', sendId: 'send-q', path: '/q' },
        }),
      ],
      [
        send({ sendId: 'send-t', path: 'turn-file', turn: 9, message: 'a long\nmessage', acceptedAt: iso(1) }),
        send({ sendId: 'send-q', path: 'native-file', fate: 'queued', message: 'a queued\nmessage' }),
      ],
      T0,
    );
    expect(shape(rows)).toEqual([
      { id: sendRowId('send-t'), kind: 'user', send: 'send-t' },
      { id: sendRowId('send-q'), kind: 'user', send: 'send-q' },
    ]);
  });

  test('a turn file that carried several messages is one row; the members riding in it get no bubble of their own', () => {
    const queue = {
      state: 'delivered',
      stateAt: iso(2_000),
      revision: 1,
    } as const;
    const rows = placeLedgerRows(
      [user('t', 'Read the file …', undefined, { handoff: { kind: 'turn', name: 'turn-009', turn: 9, path: '/t' } })],
      [
        send({ sendId: 'send-lead', path: 'turn-file', turn: 9, message: 'combined', acceptedAt: iso(1), queue }),
        send({
          sendId: 'send-b',
          message: 'second',
          acceptedAt: iso(2),
          queue: { ...queue, deliveredAs: 'send-lead' },
        }),
        send({ sendId: 'send-c', message: 'third', acceptedAt: iso(3), queue: { ...queue, deliveredAs: 'send-lead' } }),
      ],
      T0 + 5_000,
    );
    expect(shape(rows)).toEqual([{ id: sendRowId('send-lead'), kind: 'user', send: 'send-lead' }]);
  });

  test('a member of a combined turn whose lead is not on screen still gets its own bubble', () => {
    const rows = placeLedgerRows(
      [],
      [
        send({
          sendId: 'send-b',
          message: 'second',
          queue: { state: 'delivered', stateAt: iso(2_000), revision: 1, deliveredAs: 'send-lead' },
        }),
      ],
      T0 + 5_000,
    );
    expect(shape(rows)).toEqual([{ id: sendRowId('send-b'), kind: 'ledger', send: 'send-b' }]);
  });

  test('settled sends are never worn: a failure stays its own note, at the time it was sent, beside any look-alike', () => {
    const rows = placeLedgerRows([user('b', 'ship it', 1_000)], [send({ fate: 'timed_out' })], T0 + 2_000);
    expect(shape(rows).map(row => row.kind)).toEqual(['ledger', 'user']);
  });
});

describe('several sends of the same words', () => {
  test('each lands on the row nearest where its own message was written, one to one', () => {
    const rows = placeLedgerRows(
      [user('r1', 'yes', 1_000), user('r2', 'yes', 4_000)],
      [
        send({ sendId: 'first', message: 'yes', fate: 'delivered', evidence: { key: 'k1', observedAt: iso(1_000) } }),
        send({ sendId: 'second', message: 'yes', acceptedAt: iso(3_000) }),
      ],
      T0 + 5_000,
    );
    expect(shape(rows)).toEqual([
      { id: sendRowId('first'), kind: 'user', send: 'first' },
      { id: sendRowId('second'), kind: 'user', send: 'second' },
    ]);
  });

  test('the earlier send takes the one row that has landed, and the later keeps its bubble', () => {
    const rows = placeLedgerRows(
      [user('r1', 'yes', 1_000)],
      [send({ sendId: 'first', message: 'yes' }), send({ sendId: 'second', message: 'yes', acceptedAt: iso(3_000) })],
      T0 + 4_000,
    );
    expect(shape(rows)).toEqual([
      { id: sendRowId('first'), kind: 'user', send: 'first' },
      { id: sendRowId('second'), kind: 'ledger', send: 'second' },
    ]);
  });

  test('a delivered send whose row is off the page cannot take the row a newer send just landed on', () => {
    const rows = placeLedgerRows(
      [user('r2', 'continue', 100_000)],
      [
        send({ sendId: 'old', message: 'continue', fate: 'delivered', evidence: { key: 'k', observedAt: iso(1_000) } }),
        send({ sendId: 'new', message: 'continue', acceptedAt: iso(99_500) }),
      ],
      T0 + 101_000,
    );
    expect(shape(rows)).toEqual([{ id: sendRowId('new'), kind: 'user', send: 'new' }]);
  });
});

describe('sends the harness joined into one message', () => {
  const a = send({ sendId: 'a', message: 'Check the deploy logs' });
  const b = send({ sendId: 'b', message: 'and the error budget', acceptedAt: iso(150) });

  test('are worn by that one row, under the last send’s key, and neither keeps a bubble', () => {
    const rows = placeLedgerRows([user('m', 'Check the deploy logsand the error budget', 1_000)], [a, b], T0 + 2_000);
    expect(shape(rows)).toEqual([{ id: sendRowId('b'), kind: 'user', send: 'b' }]);
  });

  test('only when the row is EXACTLY consecutive sends, each sent before the row was written', () => {
    const reversed = placeLedgerRows([user('m', 'and the error budgetCheck the deploy logs', 1_000)], [a, b], T0);
    expect(shape(reversed).map(row => row.kind)).toEqual(['user', 'ledger', 'ledger']);
    const longer = placeLedgerRows([user('m', 'Check the deploy logsand the error budget!', 1_000)], [a, b], T0);
    expect(shape(longer).map(row => row.kind)).toEqual(['user', 'ledger', 'ledger']);
    const one = placeLedgerRows([user('m', 'Check the deploy logs', 1_000)], [a], T0);
    expect(shape(one)).toEqual([{ id: sendRowId('a'), kind: 'user', send: 'a' }]);
    const early = placeLedgerRows(
      [user('m', 'Check the deploy logsand the error budget', 1_000)],
      [a, send({ ...b, acceptedAt: iso(60_000) })],
      T0,
    );
    expect(shape(early).map(row => row.kind)).toEqual(['user', 'ledger', 'ledger']);
    const undated = placeLedgerRows(
      [user('m', 'Check the deploy logsand the error budget', 1_000)],
      [a, send({ ...b, acceptedAt: 'not a date' })],
      T0,
    );
    expect(shape(undated).map(row => row.kind)).toEqual(['user', 'ledger', 'ledger']);
  });

  test('never from an untimed row, a hand-off row, or a row another send already wears', () => {
    const untimed = placeLedgerRows([user('m', 'Check the deploy logsand the error budget')], [a, b], T0);
    expect(shape(untimed).map(row => row.kind)).toEqual(['user', 'ledger', 'ledger']);
    const handoff = placeLedgerRows(
      [
        user('m', 'Check the deploy logsand the error budget', 1_000, {
          handoff: { kind: 'turn', name: 'turn-001', turn: 1, path: '/t' },
        }),
      ],
      [a, b],
      T0,
    );
    expect(shape(handoff).map(row => row.kind)).toEqual(['user', 'ledger', 'ledger']);
    const worn = placeLedgerRows(
      [user('m', 'Check the deploy logs', 1_000), user('n', 'and the error budget', 1_000)],
      [a, b],
      T0,
    );
    expect(shape(worn)).toEqual([
      { id: sendRowId('a'), kind: 'user', send: 'a' },
      { id: sendRowId('b'), kind: 'user', send: 'b' },
    ]);
  });
});

describe('a delivered send the loaded transcript does not show yet', () => {
  const delivered = (overrides: Partial<LedgerSendRecord> = {}) =>
    send({ fate: 'delivered', fateAt: iso(1_500), ...overrides });

  test('keeps its bubble for a moment, so a confirmation that outruns the transcript read does not blink it out', () => {
    expect(shape(placeLedgerRows([user('a', 'earlier', -60_000)], [delivered()], T0 + 2_000))).toEqual([
      { id: 'a', kind: 'user', send: undefined },
      { id: sendRowId('send-1'), kind: 'ledger', send: 'send-1' },
    ]);
    // The daemon's own observation dates it when no fate time came with it.
    const observed = delivered({ fateAt: undefined, evidence: { key: 'k', observedAt: iso(1_000) } });
    expect(shape(placeLedgerRows([], [observed], T0 + 2_000)).map(row => row.kind)).toEqual(['ledger']);
  });

  test('lets go once the moment has passed, or when it was never dated', () => {
    expect(placeLedgerRows([], [delivered()], T0 + 1_500 + LANDING_GRACE_MS + 1)).toEqual([]);
    expect(placeLedgerRows([], [delivered({ fateAt: undefined })], T0 + 2_000)).toEqual([]);
  });

  test('defers to any unexplained message written after it, which is most likely this one in another shape', () => {
    expect(shape(placeLedgerRows([user('x', 'ship it (redacted)', 1_000)], [delivered()], T0 + 2_000))).toEqual([
      { id: 'x', kind: 'user', send: undefined },
    ]);
    expect(shape(placeLedgerRows([user('x', 'something')], [delivered()], T0 + 2_000))).toEqual([
      { id: 'x', kind: 'user', send: undefined },
    ]);
    // An undated send is compared against every row.
    expect(
      shape(placeLedgerRows([user('x', 'something', -60_000)], [delivered({ acceptedAt: 'nope' })], T0 + 2_000)),
    ).toEqual([{ id: 'x', kind: 'user', send: undefined }]);
  });
});

describe('a send followed by a note the agent drained from its queue mid-turn', () => {
  // The owner's report: the message drawn twice — once bare, once with its ticks after the Instructions
  // row. The agent had it exactly once; the note it was sent while busy is written after the tool call it
  // waited behind but stamped with the time it was queued, and that step back used to date the owner's
  // row a day early, so the row could not be the send.
  const sentAt = '2026-11-01T00:33:01.019Z';
  const words =
    "what's going on here? also im going out for halloween tonight. block it on the cal thanks. 6pm to 11pm";
  const note = turnFileInstruction('/home/kirin/.ferretry/state/sessions/s1/turns/turn-169.md');
  const log = [
    '[00:23:36] assistant/message: The claim card is now closed.',
    `[00:33:01] user/message: ${words}`,
    '[00:33:06] assistant/tool-call: Bash({"command":"date"})',
    '[00:33:06] tool/tool-result: Sat 2026-10-31 17:33 PDT',
    `[00:33:01] user/message: ${note}`,
  ].join('\n');
  const owner = send({
    sendId: 'a5a86528',
    acceptedAt: sentAt,
    message: words,
    turn: 168,
    fate: 'delivered',
    fateAt: '2026-11-01T00:33:01.631Z',
    evidence: { key: '323ec0d1', observedAt: '2026-11-01T00:33:01.181Z' },
  });
  const instructions = send({
    sendId: 'instructions-1cf9802d9430b9',
    acceptedAt: '2026-11-01T00:33:01.513Z',
    message: 'Ferretry changed part of the instructions you were started with.',
    path: 'turn-file',
    turn: 169,
    fate: 'delivered',
    fateAt: '2026-11-01T00:33:07.120Z',
    evidence: { key: 'ad297191', observedAt: '2026-11-01T00:33:06.779Z' },
  });

  test('draws the message once, on its own row, and the note on its hand-off row', () => {
    for (const nowMs of [Date.parse('2026-11-01T00:33:13.000Z'), Date.parse('2026-11-01T00:40:00.000Z')]) {
      const rows = placeLedgerRows(transcriptEntriesFromLog(log, nowMs), [owner, instructions], nowMs);
      const users = rows.filter(row => row.kind === 'user' || row.kind === 'ledger');
      expect(users.map(row => ({ kind: row.kind, send: row.send?.sendId ?? row.ledger?.sendId }))).toEqual([
        { kind: 'user', send: 'a5a86528' },
        { kind: 'user', send: 'instructions-1cf9802d9430b9' },
      ]);
      expect(rows.filter(row => row.text === words)).toHaveLength(1);
    }
  });
});

describe('isOwnSend', () => {
  test('is the reader’s own send, and not a teammate’s message or Ferretry’s notice', () => {
    expect(isOwnSend(send())).toBe(true);
    expect(isOwnSend(send({ from: 'mv-1' }))).toBe(false);
    expect(isOwnSend(send({ fromName: 'torrey' }))).toBe(false);
    expect(isOwnSend(send({ senderKind: 'daemon' }))).toBe(false);
    expect(isOwnSend(send({ message: '[message from ferret nero]\nFYI\n\nthe rail landed' }))).toBe(false);
    expect(isOwnSend(send({ by: { kind: 'ferretry', feature: 'Instructions' } }))).toBe(false);
  });
});

describe('handedOverDraft', () => {
  test('reads a file-borne send’s message and its files, and nothing for a typed one', () => {
    const message = 'Look at this\n\nAttached files — open them from these paths:\n- /s/att/screen.png (image/png)';
    expect(handedOverDraft(send({ path: 'turn-file', message }))).toEqual({
      message: 'Look at this',
      files: [{ path: '/s/att/screen.png', mime: 'image/png' }],
    });
    expect(handedOverDraft(send({ path: 'native-file', message: 'long' }))).toEqual({ message: 'long', files: [] });
    expect(handedOverDraft(send({ path: 'direct' }))).toBeUndefined();
    expect(handedOverDraft(send({ path: undefined }))).toBeUndefined();
  });
});

/**
 * &B157, the incident's own records: Claude Code 2.1.317 writes an UNTIMED copy of each message before
 * the real, timed record. The daemon sent "moved" once, by the direct path, and proved it delivered on
 * the timed record — but the chat drew a bare bubble (no time, no ticks) above the ticked one.
 */
describe('a direct send the harness wrote twice, once with no time', () => {
  const nowMs = Date.parse('2026-11-04T04:41:00.000Z');
  const moved = (sendId: string, acceptedAt: string, key: string, observedAt: string): LedgerSendRecord =>
    send({
      sendId,
      acceptedAt,
      message: 'moved',
      path: 'direct',
      fate: 'delivered',
      fateAt: observedAt,
      evidence: { key, observedAt },
    });
  const own = (rows: readonly TranscriptEntry[]) =>
    rows
      .filter(row => row.kind === 'user' || row.kind === 'ledger')
      .map(row => ({ kind: row.kind, text: row.text, send: row.send?.sendId ?? row.ledger?.sendId }));

  test('is one bubble, the timed row wearing the send', () => {
    const log = [
      '[04:39:00] assistant/message: Move #F923 to Implement on the Board.',
      '[04:39:00] system/turn: completed',
      'user/message: moved',
      '[04:39:30] user/message: moved',
      '[04:39:33] assistant/tool-call: Bash({"command":"fy task show F923"})',
    ].join('\n');
    const delivered = moved('87d1d58d', '2026-11-04T04:39:30.495Z', '66d6883c', '2026-11-04T04:39:30.653Z');
    const rows = placeLedgerRows(transcriptEntriesFromLog(log, nowMs), [delivered], nowMs);
    expect(own(rows)).toEqual([{ kind: 'user', text: 'moved', send: '87d1d58d' }]);
    const bubble = rows.find(row => row.kind === 'user');
    expect(bubble?.id).toBe(sendRowId('87d1d58d'));
    expect(bubble?.at).toBe(Date.parse('2026-11-04T04:39:30.000Z'));
  });

  test('keeps a real second send of the same words as a second bubble', () => {
    const log = [
      'user/message: moved',
      '[04:39:30] user/message: moved',
      '[04:39:31] assistant/message: Checking.',
      'user/message: moved',
      '[04:39:50] user/message: moved',
    ].join('\n');
    const first = moved('send-a', '2026-11-04T04:39:30.495Z', 'key-a', '2026-11-04T04:39:30.653Z');
    const second = moved('send-b', '2026-11-04T04:39:50.100Z', 'key-b', '2026-11-04T04:39:50.300Z');
    const rows = placeLedgerRows(transcriptEntriesFromLog(log, nowMs), [first, second], nowMs);
    expect(own(rows)).toEqual([
      { kind: 'user', text: 'moved', send: 'send-a' },
      { kind: 'user', text: 'moved', send: 'send-b' },
    ]);
  });

  test('keeps a second send typed straight after the first, with nothing between the two', () => {
    const log = [
      'user/message: moved',
      '[04:39:30] user/message: moved',
      'user/message: moved',
      '[04:39:31] user/message: moved',
    ].join('\n');
    const first = moved('send-a', '2026-11-04T04:39:30.100Z', 'key-a', '2026-11-04T04:39:30.300Z');
    const second = moved('send-b', '2026-11-04T04:39:30.900Z', 'key-b', '2026-11-04T04:39:31.200Z');
    const rows = placeLedgerRows(transcriptEntriesFromLog(log, nowMs), [first, second], nowMs);
    expect(own(rows).map(row => row.send)).toEqual(['send-a', 'send-b']);
  });
});
