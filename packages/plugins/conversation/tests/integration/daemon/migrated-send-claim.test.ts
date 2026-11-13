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

/**
 * v4 → 5.0 (fix round 4): a Codex claim cannot be translated, so the sends it leaves unresolved are marked by the
 * converter (`update_unconfirmed`), and the real tracker neither confirms them from the transcript nor retypes them.
 *
 * The staged probe is the one the reviewer used: a freshly migrated home has NO Codex rollout binding (the read is
 * empty, `unbound`); a native resume then binds the unchanged old rollout, whose input for the very same text is named by
 * the 5.0 entry id (neither old format claims it). The row starts as `unaccounted`, exactly as before the fix.
 */
describe('a send the converter could not prove stays unconfirmed when the old Codex input becomes readable', () => {
  const OLD_INPUT: TranscriptEntry = {
    id: 'native-a:2:0:message',
    at: AT as Instant,
    role: 'user',
    text: MESSAGE,
  };
  const CODEX_KEYS = ['/v4/home/runtimes/codex/sessions/rollout-a.jsonl#120#340', 'native-message-uuid'] as const;
  const codexClaim = (key: string) => ({
    ...delivered(key),
    evidence: { ...delivered(key).evidence, harness: 'codex', kind: 'response_item', proof: 'normal-user-record' },
  });
  /** What the converter writes for the pending send of a ledger it could not prove. */
  const migrated = { ...pending, fate: 'unaccounted', unaccountedReason: 'update_unconfirmed' };
  /** The same row as a 5.0 tracker alone leaves it when the rollout is unbound. */
  const unbound = { ...pending, fate: 'unaccounted', unaccountedReason: 'transcript_unbound' };

  /** One ledger, one tracker; each look reads whatever the rollout holds NOW, `later` seconds after the second send. */
  async function staged(
    rows: readonly object[],
    steps: readonly { entries: readonly TranscriptEntry[]; after: number }[],
  ) {
    const state = memoryStatePort(CONVERSATION_STATE);
    for (const row of rows) await state.append(SENDS_STATE, row, F1);
    let now = SECOND_AT;
    const ledger = new StateSendLedger(state, { now: () => now } as never);
    let entries: readonly TranscriptEntry[] = [];
    const source: Pick<BoundTranscriptReader, 'read' | 'readCovering'> = {
      read: async () => entries,
      readCovering: async () => ({ entries, covered: true }),
    };
    const retyped: string[] = [];
    const tracker = new SendTracker(
      {
        ledger,
        evidence: new EntriesSendEvidence(async () => ({ harness: 'codex', reader: source })),
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
        clock: { now: () => now },
      } as never,
      defaultSendTrackerSettings,
    );
    const seen: { fate: string | undefined; reason: string | undefined }[] = [];
    for (const step of steps) {
      entries = step.entries;
      now = new Date(Date.parse(SECOND_AT) + step.after).toISOString();
      await tracker.check(F1 as never);
      const record = (await ledger.list(F1)).find(row => row.sendId === 'send-1');
      seen.push({ fate: record?.fate, reason: record?.unaccountedReason });
    }
    return { seen, retyped };
  }
  const HOUR = 60 * 60_000;
  const UNBOUND_THEN_BOUND = [
    { entries: [], after: HOUR },
    { entries: [OLD_INPUT], after: HOUR + 20_000 },
  ];

  for (const key of CODEX_KEYS)
    test(`a migrated row is never delivered (${key.includes('#') ? 'byte-span' : 'payload.id'} claim): unbound, then bound`, async () => {
      const { seen, retyped } = await staged([codexClaim(key), migrated], UNBOUND_THEN_BOUND);
      expect(seen).toEqual([
        { fate: 'unaccounted', reason: 'update_unconfirmed' },
        { fate: 'unaccounted', reason: 'update_unconfirmed' },
      ]);
      expect(retyped).toEqual([]);
    });

  test('a migrated row that was still accepted is not retyped when the transcript has nothing', async () => {
    const accepted = { ...pending, unaccountedReason: 'update_unconfirmed' };
    const { seen, retyped } = await staged([codexClaim(CODEX_KEYS[0]), accepted], [{ entries: [], after: HOUR }]);
    expect(seen).toEqual([{ fate: 'accepted', reason: 'update_unconfirmed' }]);
    expect(retyped).toEqual([]);
  });

  test('control: the same row WITHOUT the mark (the reviewer’s staged probe) is falsely delivered', async () => {
    const { seen } = await staged([codexClaim(CODEX_KEYS[0]), unbound], UNBOUND_THEN_BOUND);
    expect(seen[1]?.fate).toBe('delivered');
  });

  test('a 5.0-native pending send over the same input is unaffected: it is delivered', async () => {
    const { seen } = await staged([pending], [{ entries: [OLD_INPUT], after: 10_000 }]);
    expect(seen).toEqual([{ fate: 'delivered', reason: undefined }]);
  });

  test('a delivered migrated row stays delivered', async () => {
    const state = memoryStatePort(CONVERSATION_STATE);
    await state.append(SENDS_STATE, codexClaim(CODEX_KEYS[1]), F1);
    const [row] = await new StateSendLedger(state, fixedClock(SECOND_AT as Instant)).list(F1);
    expect(row).toMatchObject({ fate: 'delivered', evidence: { key: CODEX_KEYS[1] } });
  });
});
