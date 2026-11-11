/**
 * G162 / security review P1-4: a delivered input that sits beyond the first 8 MiB of a long transcript is recognized and
 * never typed again, and a send that a CUT read cannot show absent is unconfirmed, never retyped. The evidence
 * (`EntriesSendEvidence`) and the decision (`SendTracker`) are production code. The reader is a stand-in that keeps the
 * harness contract exactly (`read` and `readCovering` over a window cut from the end): another package's daemon half is
 * not imported by a test (the context-imports gate), so the real Claude Code harness is proved against the same contract
 * in its own test (claude-harness.test.ts, "G162: entries() reads the NEWEST 8 MiB") and this file proves what
 * Conversation does with it.
 */
import { describe, expect, test } from 'bun:test';
import type { BoundTranscriptReader, TranscriptEntry } from '@ferretry/core-ferrets/contract';
import type { Instant } from '@ferretry/std';
import { EntriesSendEvidence } from '../../../daemon/delivery/adapters/entries-send-evidence.ts';
import { SendTracker } from '../../../daemon/delivery/lib/tracker.ts';
import { defaultSendTrackerSettings } from '../../../daemon/delivery/lib/tracking.ts';

const AT = '2026-11-11T00:00:00.000Z';
const MESSAGE = 'this input was already delivered at the end of the long transcript';
const entry = (id: string, at: string, text: string): TranscriptEntry => ({
  id,
  at: at as Instant,
  role: 'user',
  text,
});

/**
 * A long conversation read by its newest part: only `window` is in the read. `covered` follows the contract: the oldest
 * complete record read is not newer than the instant asked for (nothing was cut when `cut` is false).
 */
function cutReader(
  window: readonly TranscriptEntry[],
  cut: boolean,
  withCovering = true,
): Pick<BoundTranscriptReader, 'read' | 'readCovering'> {
  return {
    read: async () => window,
    ...(withCovering
      ? {
          readCovering: async (since: Instant) => ({
            entries: window,
            covered: !cut || (window[0] !== undefined && Date.parse(window[0].at) <= Date.parse(since)),
          }),
        }
      : {}),
  };
}

const evidenceOver = (reader: Pick<BoundTranscriptReader, 'read' | 'readCovering'>): EntriesSendEvidence =>
  new EntriesSendEvidence(async () => ({ harness: 'claude', reader }));

/** The tracker over the evidence, one send accepted at AT whose deadline has passed, a quiet idle pane. */
async function tracked(evidence: EntriesSendEvidence) {
  let record: Record<string, unknown> = {
    sendId: 'send-1',
    acceptedAt: AT,
    attemptAt: AT,
    acceptedTurn: 4,
    path: 'direct',
    message: MESSAGE,
    matchText: MESSAGE,
    turn: 4,
    fate: 'accepted',
    attempt: 1,
    senderKind: 'human',
    deadlineAt: new Date(Date.parse(AT) + 1000).toISOString(),
  };
  const retyped: string[] = [];
  const tracker = new SendTracker(
    {
      ledger: {
        list: async () => [record],
        settle: async (_id: unknown, _send: unknown, patch: object) => {
          record = { ...record, ...patch };
          return record;
        },
      },
      evidence,
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
          record = { ...record, attempt: 2 };
          return record;
        },
        resubmit: async () => record,
      },
      notifier: { notify: async () => {} },
      scheduler: { schedule: () => {}, cancelAll: () => {} },
      roster: { sessions: () => [] },
      serial: { run: async (_id: unknown, work: () => Promise<unknown>) => await work() },
      clock: { now: () => new Date(Date.parse(AT) + 10_000).toISOString() },
    } as never,
    defaultSendTrackerSettings,
  );
  await tracker.check('f1' as never);
  return { retyped, record: () => record };
}

describe('P1-4: a long transcript’s delivered input is found, and an unprovable absence is never a retype', () => {
  test('a delivered input in the newest window is recognized and never reattempted', async () => {
    const evidence = evidenceOver(cutReader([entry('delivered', AT, MESSAGE)], true));
    const reading = await evidence.read('f1', AT);
    expect(reading.inputs.map(input => input.text)).toEqual([MESSAGE]);
    const { retyped, record } = await tracked(evidence);
    expect(retyped).toEqual([]);
    expect(record().fate).toBe('delivered');
  });

  test('a send that is NOT in a cut window that does not reach back to it is unproved (unconfirmed), never typed again', async () => {
    const evidence = evidenceOver(cutReader([entry('later', '2026-11-11T05:00:00.000Z', 'something else')], true));
    const reading = await evidence.read('f1', AT);
    expect(reading.readable).toBe(false);
    // What the window DID find is still reported (it can prove a delivery); only absence is unproved.
    expect(reading.inputs.map(input => input.text)).toEqual(['something else']);
    const { retyped, record } = await tracked(evidence);
    expect(retyped).toEqual([]);
    expect(record().fate).not.toBe('delivered');
  });

  test('a cut window that DOES reach back before the send proves it absent, as a whole transcript does', async () => {
    const evidence = evidenceOver(cutReader([entry('older', '2026-11-10T23:30:00.000Z', 'earlier input')], true));
    expect((await evidence.read('f1', AT)).readable).toBe(true);
    const { retyped } = await tracked(evidence);
    expect(retyped).toEqual(['send-1']);
  });

  test('a harness without readCovering reads the whole conversation: covered, as before', async () => {
    const evidence = evidenceOver(cutReader([entry('older', '2026-11-10T00:00:00.000Z', 'old input')], false, false));
    expect((await evidence.read('f1', AT)).readable).toBe(true);
    const { retyped } = await tracked(evidence);
    expect(retyped).toEqual(['send-1']);
  });
});
