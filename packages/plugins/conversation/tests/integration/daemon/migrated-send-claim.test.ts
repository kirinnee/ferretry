/**
 * v4 → 5.0 (transcript bytes round 3, the migration blocker): a send ledger the one-time converter wrote keeps a delivered
 * input CLAIMED, so a second identical send that is still pending is never confirmed by the same drain.
 *
 * The one-time home conversion renames a v4 Claude drain claim `<path>#<start>#<end>` to
 * `queued-prompt:<start>`, which is the id the Claude harness gives that unchanged drain (pinned in the claude-code
 * plugin's own `claude-harness.test.ts`, "a drain without a uuid is named by its byte offset in the file"; another
 * package's daemon half is not imported by a test). This file proves the other end with PRODUCTION code: rows written in
 * the converted shape are loaded by the real `StateSendLedger`, and the real `EntriesSendEvidence` + `SendTracker` read
 * the harness's entry for that drain. The control row, still in v4's spelling, shows why the conversion is needed: it does
 * not claim the drain, and the pending send is falsely delivered.
 */
import { describe, expect, test } from 'bun:test';
import type { BoundTranscriptReader, TranscriptEntry } from '@ferretry/core-ferrets/contract';
import { fixedClock } from '@ferretry/kernel/testing';
import type { Instant } from '@ferretry/std';
import { CONVERSATION_STATE, SENDS_STATE } from '../../../contract/index.ts';
import { StateSendLedger } from '../../../daemon/delivery/adapters/state-send-ledger.ts';
import { EntriesSendEvidence } from '../../../daemon/delivery/adapters/entries-send-evidence.ts';
import { SendTracker } from '../../../daemon/delivery/lib/tracker.ts';
import { defaultSendTrackerSettings } from '../../../daemon/delivery/lib/tracking.ts';
import type { SessionId } from '../../../daemon/seams/ferret-id.ts';
import { memoryStatePort } from '../../support/state.ts';

const F1 = 'f1' as SessionId;
const AT = '2026-11-11T00:00:00.000Z';
const SECOND_AT = '2026-11-11T00:00:02.000Z';
const MESSAGE = 'repeat this exact queued message';
const V4_KEY = '/v4/home/runtimes/claude/projects/-work/conv-1.jsonl#283#476';
const V5_KEY = 'queued-prompt:283';

/** What the converter wrote for a v4 delivered send, and for a second identical send accepted two seconds later. */
const delivered = (key: string) => ({
  format: 1,
  sendId: 'first-send',
  acceptedAt: AT,
  attemptAt: AT,
  acceptedTurn: 4,
  path: 'direct',
  message: MESSAGE,
  matchText: MESSAGE,
  turn: 4,
  senderKind: 'human',
  fate: 'delivered',
  fateAt: AT,
  at: AT,
  evidence: {
    key,
    harness: 'claude',
    kind: 'queued_command',
    proof: 'native-queue-drain',
    observedAt: AT,
    shapeVersion: 1,
    matchedTurn: 4,
    tier: 'exact-text',
  },
});
const pending = {
  format: 1,
  sendId: 'send-1',
  acceptedAt: SECOND_AT,
  attemptAt: SECOND_AT,
  acceptedTurn: 4,
  path: 'direct',
  message: MESSAGE,
  matchText: MESSAGE,
  turn: 4,
  senderKind: 'human',
  fate: 'accepted',
  attempt: 1,
  deadlineAt: '2026-11-11T00:00:03.000Z',
  at: SECOND_AT,
};

/** The Claude harness's entry for the unchanged, uuid-less drain at byte 283 (its id is the offset). */
const drain: TranscriptEntry = {
  id: V5_KEY,
  at: AT as Instant,
  role: 'system',
  text: MESSAGE,
  data: { proof: 'queued-prompt' },
};
const reader: Pick<BoundTranscriptReader, 'read' | 'readCovering'> = {
  read: async () => [drain],
  readCovering: async () => ({ entries: [drain], covered: true }),
};

/** The ledger loaded from disk-shaped rows, then one tracker look at the pending send over the real evidence. */
async function look(rows: readonly object[]) {
  const state = memoryStatePort(CONVERSATION_STATE);
  for (const row of rows) await state.append(SENDS_STATE, row, F1);
  const ledger = new StateSendLedger(state, fixedClock(SECOND_AT as Instant));
  const loaded = await ledger.list(F1);
  const retyped: string[] = [];
  const tracker = new SendTracker(
    {
      ledger,
      evidence: new EntriesSendEvidence(async () => ({ harness: 'claude', reader })),
      terminal: {
        observe: async () => ({ alive: true, dead: false, promptReady: true, activeWork: false }),
        heldAt: async () => undefined,
      },
      repository: {
        read: async () => ({ id: 'f1', status: 'running', mode: 'auto', turn: 4 }),
        journal: async () => {},
      },
      attempts: {
        reattempt: async (_id: unknown, send: string) => {
          retyped.push(send);
          return (await ledger.list(F1)).find(record => record.sendId === send)!;
        },
        resubmit: async () => undefined,
      },
      notifier: { notify: async () => {} },
      scheduler: { schedule: () => {}, cancelAll: () => {} },
      roster: { sessions: () => [] },
      serial: { run: async (_id: unknown, work: () => Promise<unknown>) => await work() },
      clock: { now: () => new Date(Date.parse(SECOND_AT) + 10_000).toISOString() },
    } as never,
    defaultSendTrackerSettings,
  );
  await tracker.check(F1 as never);
  const after = await ledger.list(F1);
  return { loaded, retyped, fate: (id: string) => after.find(record => record.sendId === id)?.fate };
}

describe('a send ledger converted from v4 keeps its delivered input claimed', () => {
  test('the claim survives loading, and the pending identical send is NOT confirmed by the claimed drain', async () => {
    const { loaded, fate } = await look([delivered(V5_KEY), pending]);
    expect(loaded.map(record => [record.sendId, record.fate])).toEqual([
      ['first-send', 'delivered'],
      ['send-1', 'accepted'],
    ]);
    expect(loaded[0]?.evidence?.key).toBe(V5_KEY);
    expect(fate('first-send')).toBe('delivered');
    expect(fate('send-1')).not.toBe('delivered');
  });

  test('control: a claim left in v4’s spelling does not claim the drain, and the pending send is falsely delivered', async () => {
    const { fate } = await look([delivered(V4_KEY), pending]);
    expect(fate('send-1')).toBe('delivered');
  });

  test('control: with no earlier claim at all, the same drain does deliver the pending send', async () => {
    const { fate } = await look([pending]);
    expect(fate('send-1')).toBe('delivered');
  });
});
