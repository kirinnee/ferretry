import { describe, expect, test } from 'bun:test';
import { SENDS_STATE } from '../../../../contract/index.ts';
import { StateSendLedger } from '../../../../daemon/delivery/adapters/state-send-ledger.ts';
import {
  defaultSendTrackerSettings,
  defaultSessionSendSettings,
  SendRefused,
  SendTracker,
  SessionSendService,
} from '../../../../daemon/delivery/lib/index.ts';
import type { ObservedHumanInput } from '../../../../daemon/seams/transcript-types.ts';
import { memoryStatePort } from '../../../support/state.ts';

/**
 * A person's Retry of a send the v4 → 5.0 conversion left `update_unconfirmed` is a FRESH send. The old transcript input
 * (the one its ledger claim could not be proved to name) is history: only an entry written AFTER the new attempt may
 * deliver it. Real ledger, real `SessionSendService`, real `SendTracker`; the pane and the transcript are fixed fakes.
 */
const F1 = 'f1' as never;
const MESSAGE = 'repeat this exact Codex message';
const OLD_INPUT_AT = '2026-11-11T00:00:00.000Z';
const PENDING_AT = '2026-11-11T00:00:02.000Z';
const RETRY_AT = '2026-11-11T01:00:30.000Z';

const input = (proofKey: string, observedAt: string): ObservedHumanInput => ({
  harness: 'codex',
  text: MESSAGE,
  proof: 'normal-user-record',
  observedAt,
  proofKey,
  shapeVersion: 1,
});

/** Both spellings of the v4 claim: a byte-span key, and the Codex payload id. */
const KEYS = {
  'byte-span': '/home/x/rollout-a.jsonl#120#310',
  'payload.id': 'native-message-uuid',
} as const;

async function world(claimKey: string) {
  const ledger = new StateSendLedger(memoryStatePort([SENDS_STATE]), { now: () => OLD_INPUT_AT as never });
  const base = {
    acceptedTurn: 0,
    path: 'direct' as const,
    message: MESSAGE,
    matchText: MESSAGE,
    senderKind: 'human' as const,
    attempt: 1,
  };
  await ledger.accept(F1, {
    ...base,
    sendId: 'first-send',
    acceptedAt: OLD_INPUT_AT,
    attemptAt: OLD_INPUT_AT,
    fate: 'delivered',
    fateAt: OLD_INPUT_AT,
    evidence: {
      key: claimKey,
      harness: 'codex',
      kind: 'response_item',
      proof: 'normal-user-record',
      observedAt: OLD_INPUT_AT as never,
      shapeVersion: 1,
      matchedTurn: 0,
      tier: 'exact-text',
    },
  } as never);
  await ledger.accept(F1, {
    ...base,
    sendId: 'send-1',
    acceptedAt: PENDING_AT,
    attemptAt: PENDING_AT,
    fate: 'unaccounted',
    unaccountedReason: 'update_unconfirmed',
  } as never);

  let now = RETRY_AT;
  let inputs: readonly ObservedHumanInput[] = [input('native-a:2:0:message', OLD_INPUT_AT)];
  const typed: string[] = [];
  const serial = { run: async (_id: unknown, work: () => Promise<unknown>) => await work() };
  const clock = { now: () => now };
  const service = new SessionSendService(
    {
      ledger,
      repository: {
        read: async () => ({ id: 'f1', status: 'running', mode: 'auto', turn: 4 }),
        journal: async () => {},
      },
      terminal: {
        observe: async () => ({ alive: true, dead: false, promptReady: true, activeWork: false }),
        heldAt: async () => undefined,
        deliver: async (_id: unknown, text: string) => {
          typed.push(text);
        },
      },
      serial,
      clock,
      tracking: { track: () => {} },
    } as never,
    defaultSessionSendSettings,
  );
  const retyped: string[] = [];
  const tracker = new SendTracker(
    {
      ledger,
      evidence: { read: async () => ({ readable: true, inputs }) },
      terminal: {
        observe: async () => ({ alive: true, dead: false, promptReady: true, activeWork: false }),
        heldAt: async () => undefined,
      },
      repository: {
        read: async () => ({ id: 'f1', status: 'running', mode: 'auto', turn: 4 }),
        journal: async () => {},
      },
      attempts: {
        reattempt: async (_id: unknown, sendId: string) => {
          retyped.push(sendId);
          return (await ledger.list(F1)).find(row => row.sendId === sendId)!;
        },
        resubmit: async () => (await ledger.list(F1)).find(row => row.sendId === 'send-1')!,
      },
      notifier: { notify: async () => {} },
      scheduler: { schedule: () => {}, cancelAll: () => {} },
      roster: { sessions: () => [] },
      serial,
      clock,
    } as never,
    defaultSendTrackerSettings,
  );
  return {
    service,
    typed,
    retyped,
    row: async () => (await ledger.list(F1)).find(r => r.sendId === 'send-1')!,
    /** One tracker look, `afterMs` after the Retry. */
    look: async (afterMs: number) => {
      now = new Date(Date.parse(RETRY_AT) + afterMs).toISOString();
      await tracker.check(F1);
    },
    appears: (entry: ObservedHumanInput) => {
      inputs = [...inputs, entry];
    },
  };
}

for (const [spelling, claimKey] of Object.entries(KEYS))
  describe(`RETRY: a person's Retry of an update-unconfirmed send (${spelling} claim)`, () => {
    test('is a fresh send: a new acceptance, and the unchanged historical input never delivers it', async () => {
      const w = await world(claimKey);
      const retried = await w.service.reattempt(F1, 'send-1', { by: 'person', force: true });
      expect(w.typed).toEqual([MESSAGE]);
      expect(retried.unaccountedReason).toBeUndefined();
      expect(retried.attempt).toBe(2);
      expect(retried.attemptAt).toBe(RETRY_AT);
      expect(retried.acceptedAt).toBe(RETRY_AT);

      await w.look(1_000);
      expect((await w.row()).fate).not.toBe('delivered');
      expect((await w.row()).evidence).toBeUndefined();
      expect(w.retyped).toEqual([]);
    });

    test('is delivered once a genuinely new entry appears, and by nothing older', async () => {
      const w = await world(claimKey);
      await w.service.reattempt(F1, 'send-1', { by: 'person', force: true });
      await w.look(1_000);
      expect((await w.row()).fate).not.toBe('delivered');

      w.appears(input('native-a:9:0:message', '2026-11-11T01:00:40.000Z'));
      await w.look(15_000);
      const saved = await w.row();
      expect(saved.fate).toBe('delivered');
      expect(saved.evidence?.key).toBe('native-a:9:0:message');
    });

    test('the daemon’s own retry refuses it: only a person’s Retry clears the mark', async () => {
      const w = await world(claimKey);
      await expect(w.service.reattempt(F1, 'send-1', { by: 'daemon' })).rejects.toBeInstanceOf(SendRefused);
      await expect(w.service.reattempt(F1, 'send-1', { by: 'daemon', force: true })).rejects.toBeInstanceOf(
        SendRefused,
      );
      expect(w.typed).toEqual([]);
      const saved = await w.row();
      expect(saved.unaccountedReason).toBe('update_unconfirmed');
      expect(saved.acceptedAt).toBe(PENDING_AT);
    });
  });

test('an ordinary unconfirmed send keeps its acceptance across a person’s Retry (only the update’s mark makes it fresh)', async () => {
  const w = await world(KEYS['payload.id']);
  const ledgerRow = await w.row();
  expect(ledgerRow.acceptedAt).toBe(PENDING_AT);
  // The same row without the mark: a plain `timeout` unaccounted send.
  const plain = new StateSendLedger(memoryStatePort([SENDS_STATE]), { now: () => OLD_INPUT_AT as never });
  await plain.accept(F1, { ...ledgerRow, unaccountedReason: 'timeout' } as never);
  const service = new SessionSendService(
    {
      ledger: plain,
      repository: {
        read: async () => ({ id: 'f1', status: 'running', mode: 'auto', turn: 4 }),
        journal: async () => {},
      },
      terminal: {
        observe: async () => ({ alive: true, dead: false, promptReady: true, activeWork: false }),
        heldAt: async () => undefined,
        deliver: async () => {},
      },
      serial: { run: async (_id: unknown, work: () => Promise<unknown>) => await work() },
      clock: { now: () => RETRY_AT },
      tracking: { track: () => {} },
    } as never,
    defaultSessionSendSettings,
  );
  const retried = await service.reattempt(F1, 'send-1', { by: 'person', force: true });
  expect(retried.acceptedAt).toBe(PENDING_AT);
  expect(retried.attemptAt).toBe(RETRY_AT);
});
