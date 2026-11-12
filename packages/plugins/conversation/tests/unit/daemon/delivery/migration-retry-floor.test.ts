import { describe, expect, test } from 'bun:test';
import { SendLineSchema, SENDS_STATE } from '../../../../contract/index.ts';
import { StateSendLedger } from '../../../../daemon/delivery/adapters/state-send-ledger.ts';
import {
  defaultSendTrackerSettings,
  defaultSessionSendSettings,
  SendRefused,
  SendRetypeWithheld,
  SendTracker,
  SessionSendService,
} from '../../../../daemon/delivery/lib/index.ts';
import type { ObservedHumanInput } from '../../../../daemon/seams/transcript-types.ts';
import { memoryStatePort } from '../../../support/state.ts';

/**
 * A person's Retry of an `update_unconfirmed` send writes a DURABLE evidence floor (`evidenceNotBefore`) at its own
 * acceptance, and the tracker rejects every transcript input earlier than it, with no clock-skew slack. Nothing else
 * writes or moves the floor, so it survives a later Enter, and an ordinary send (no floor) keeps the normal slack.
 *
 * The rows are the ones the v4 → 5.0 conversion writes (`untyped:true` kept; the mark added), spelled out here because a
 * plugin test does not import the converter; the converter's own conversation test pins that its output carries no
 * floor. Real ledger, real `SessionSendService`, real `SendTracker`; pane and transcript are
 * fixed fakes.
 */
const F1 = 'f1' as never;
const MESSAGE = 'repeat this exact Codex message';
/** Seconds before the Retry: INSIDE the five seconds of clock-skew slack an ordinary send's window allows. */
const OLD_INPUT_AT = '2026-11-11T01:00:26.000Z';
const PENDING_AT = '2026-11-11T01:00:28.000Z';
const RETRY_AT = '2026-11-11T01:00:30.000Z';
const ENTER_AT = '2026-11-11T01:00:32.000Z';

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

interface Shape {
  /** The converted row keeps v4's `untyped` (its first actual typing is attempt 1). */
  readonly untyped?: boolean;
  /** Carries the conversion's mark; absent for an ordinary row. */
  readonly marked?: boolean;
  readonly attempt?: number;
  readonly acceptedAt?: string;
  readonly attemptAt?: string;
  /** The terminal's answer when a person's Retry looks for a held copy (default: absent). */
  readonly heldAt?: 'composer' | 'queue' | undefined;
  /** The transcript as first read (default: the one historical input that left the send unconfirmed). */
  readonly inputs?: readonly ObservedHumanInput[];
}

async function world(claimKey: string, shape: Shape = {}) {
  const ledger = new StateSendLedger(memoryStatePort([SENDS_STATE]), { now: () => OLD_INPUT_AT as never });
  const base = {
    acceptedTurn: 0,
    path: 'direct' as const,
    message: MESSAGE,
    matchText: MESSAGE,
    senderKind: 'human' as const,
  };
  await ledger.accept(F1, {
    ...base,
    sendId: 'first-send',
    acceptedAt: OLD_INPUT_AT,
    attempt: 1,
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
  const marked = shape.marked ?? true;
  await ledger.accept(F1, {
    ...base,
    sendId: 'send-1',
    acceptedAt: shape.acceptedAt ?? PENDING_AT,
    attempt: shape.attempt ?? 1,
    attemptAt: shape.attemptAt ?? shape.acceptedAt ?? PENDING_AT,
    fate: marked ? 'unaccounted' : 'accepted',
    ...(marked ? { unaccountedReason: 'update_unconfirmed' } : {}),
    ...(shape.untyped === true ? { untyped: true } : {}),
  } as never);

  let now = RETRY_AT;
  let inputs: readonly ObservedHumanInput[] = shape.inputs ?? [input('native-a:2:0:message', OLD_INPUT_AT)];
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
        observe: async () => ({
          alive: true,
          dead: false,
          promptReady: true,
          activeWork: false,
          ...(typed.length === 0 ? {} : { draft: MESSAGE }),
        }),
        heldAt: async () => shape.heldAt,
        submitComposer: async () => 'submitted',
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
    ledger,
    service,
    typed,
    retyped,
    row: async () => (await ledger.list(F1)).find(r => r.sendId === 'send-1')!,
    /** One tracker look, `afterMs` after the Retry. */
    look: async (afterMs: number) => {
      now = new Date(Date.parse(RETRY_AT) + afterMs).toISOString();
      await tracker.check(F1);
    },
    /** A successful Enter for this send, two seconds after the Retry. */
    enterAfterRetry: async () => {
      now = ENTER_AT;
      return await service.submit(F1, 'send-1');
    },
    appears: (entry: ObservedHumanInput) => {
      inputs = [...inputs, entry];
    },
  };
}

for (const [spelling, claimKey] of Object.entries(KEYS)) {
  describe(`EVIDENCE FLOOR: a person's Retry of an update-unconfirmed send (${spelling} claim)`, () => {
    test('RV7 UNTYPED: a converted untyped row keeps attempt 1, floors at the Retry, and the old input never delivers it', async () => {
      const w = await world(claimKey, { untyped: true });
      const retried = await w.service.reattempt(F1, 'send-1', { by: 'person', force: true });
      expect(w.typed).toEqual([MESSAGE]);
      expect(retried.unaccountedReason).toBeUndefined();
      expect(retried.attempt).toBe(1);
      expect(retried.attemptAt).toBe(RETRY_AT);
      expect(retried.acceptedAt).toBe(RETRY_AT);
      expect(retried.evidenceNotBefore).toBe(RETRY_AT);

      await w.look(1_000);
      expect((await w.row()).fate).not.toBe('delivered');
      expect((await w.row()).evidence).toBeUndefined();
      expect(w.retyped).toEqual([]);
    });

    test('RV7 AFTER ENTER: a successful Enter after the Retry leaves the floor where it was', async () => {
      const w = await world(claimKey);
      const retried = await w.service.reattempt(F1, 'send-1', { by: 'person', force: true });
      expect(retried.attempt).toBe(2);
      expect(retried.evidenceNotBefore).toBe(RETRY_AT);

      const entered = await w.enterAfterRetry();
      expect(entered.acceptedAt).toBe(RETRY_AT);
      expect(entered.attemptAt).toBe(ENTER_AT);
      expect(entered.evidenceNotBefore).toBe(RETRY_AT);

      await w.look(3_000);
      expect((await w.row()).fate).not.toBe('delivered');
      expect((await w.row()).evidence).toBeUndefined();
    });

    test('an entry written AT the floor delivers it after an Enter, and one a millisecond before never does', async () => {
      const w = await world(claimKey);
      await w.service.reattempt(F1, 'send-1', { by: 'person', force: true });
      await w.enterAfterRetry();
      w.appears(input('native-a:7:0:message', new Date(Date.parse(RETRY_AT) - 1).toISOString()));
      await w.look(3_000);
      expect((await w.row()).fate).not.toBe('delivered');

      w.appears(input('native-a:8:0:message', RETRY_AT));
      await w.look(15_000);
      expect((await w.row()).evidence?.key).toBe('native-a:8:0:message');
    });

    test('a later daemon attempt does not move the floor', async () => {
      const w = await world(claimKey);
      await w.service.reattempt(F1, 'send-1', { by: 'person', force: true });
      const settled = await w.ledger.settle(F1, 'send-1', { fate: 'timed_out', retryable: true });
      expect(settled?.evidenceNotBefore).toBe(RETRY_AT);
      await w.service.reattempt(F1, 'send-1', { by: 'daemon', force: true }).catch(() => undefined);
      expect((await w.row()).evidenceNotBefore).toBe(RETRY_AT);
    });

    test('no floor exists before a Retry, and a refused daemon retry or a refused Retry writes none', async () => {
      const w = await world(claimKey);
      expect((await w.row()).evidenceNotBefore).toBeUndefined();
      await expect(w.service.reattempt(F1, 'send-1', { by: 'daemon', force: true })).rejects.toBeInstanceOf(
        SendRefused,
      );
      expect((await w.row()).evidenceNotBefore).toBeUndefined();

      const held = await world(claimKey, { heldAt: 'composer' });
      const refused = await held.service.reattempt(F1, 'send-1', { by: 'person', force: true }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(SendRetypeWithheld);
      // It points at the action that works today (Retry is not wired), in plain words.
      expect((refused as Error).message).toContain('Clear the draft, then send the message again yourself');
      expect((refused as Error).message).not.toContain('Retry');
      expect((await held.row()).evidenceNotBefore).toBeUndefined();
      expect((await held.row()).unaccountedReason).toBe('update_unconfirmed');
    });
  });
}

describe('EVIDENCE FLOOR: sends without a floor keep the normal clock-skew slack', () => {
  for (const attempt of [1, 2]) {
    test(`RV7 SHAPE: an ordinary row at attempt ${attempt} with equal times (no mark, no Retry) delivers from a near-boundary input`, async () => {
      const w = await world(KEYS['payload.id'], {
        marked: false,
        attempt,
        acceptedAt: RETRY_AT,
        attemptAt: RETRY_AT,
        // Written four seconds before the send was accepted: within `matchSlackMs`, so it still proves delivery.
        inputs: [input('ordinary-native', OLD_INPUT_AT)],
      });
      expect((await w.row()).evidenceNotBefore).toBeUndefined();
      await w.look(1_000);
      const saved = await w.row();
      expect(saved.fate).toBe('delivered');
      expect(saved.evidence?.key).toBe('ordinary-native');
    });
  }

  test('an ordinary unconfirmed send keeps its acceptance across a person’s Retry and writes no floor', async () => {
    const w = await world(KEYS['payload.id']);
    const ledgerRow = await w.row();
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
    expect(retried.evidenceNotBefore).toBeUndefined();
  });
});

describe('EVIDENCE FLOOR: the ledger line', () => {
  const line = {
    sendId: 'send-1',
    acceptedAt: RETRY_AT,
    acceptedTurn: 0,
    path: 'direct',
    message: MESSAGE,
    fate: 'accepted',
    at: RETRY_AT,
  } as const;

  test('carries the floor as an instant, and a line written before it existed parses unchanged', () => {
    const parse = (value: unknown) => SendLineSchema.safeParse(value);
    expect(parse(line).data).toEqual(line as never);
    expect(parse({ ...line, evidenceNotBefore: RETRY_AT }).data?.evidenceNotBefore).toBe(RETRY_AT as never);
    expect(parse({ ...line, evidenceNotBefore: 'yesterday' }).success).toBe(false);
  });

  test('is durable: a ledger read back from its lines still holds the floor', async () => {
    const state = memoryStatePort([SENDS_STATE]);
    const ledger = new StateSendLedger(state, { now: () => RETRY_AT as never });
    await ledger.accept(F1, { ...line, evidenceNotBefore: RETRY_AT } as never);
    const reopened = new StateSendLedger(state, { now: () => ENTER_AT as never });
    expect((await reopened.list(F1))[0]?.evidenceNotBefore).toBe(RETRY_AT);
  });
});
