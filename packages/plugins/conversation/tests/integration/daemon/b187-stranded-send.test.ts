import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import type {
  FerretHarness,
  FerretId,
  FerretTurnDocument,
  FerretTurns,
  RunnerDelivery,
  TranscriptEntry,
} from '@ferretry/core-ferrets/contract';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { StatePort } from '@ferretry/kernel/contract';
import { fixedClock, testHost } from '@ferretry/kernel/testing';
import type { Instant } from '@ferretry/std';
import { err, ok } from '@ferretry/std';
import { CONVERSATION_STATE, ConversationPort } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';
import { StateSendLedger } from '../../../daemon/delivery/adapters/index.ts';
import { parseSessionId } from '../../../daemon/seams/ferret-id.ts';
import { memoryStatePort } from '../../support/state.ts';
import { wardenStandIn } from '../../support/warden-plugin.ts';

/**
 * B187 — a direct send the fill could not confirm, drawn by the pane long after, and never submitted (nelly, two days).
 *
 * The real conversation daemon half over a fake Ferrets whose pane is a small model of Claude's composer: it draws what
 * is typed only when the test says so (a pane too slow to show it within the fill's window), holds it as a draft, and
 * submits it when Enter takes. The clock is driven, no tmux, no network. The message is two PLAIN lines — no quoted
 * `>` line — so none of this is the composer reader's doing: what failed was that nothing looked again after the
 * tracker's ten minutes, and nothing raised the message when the one Enter did not take.
 *
 * Not in this rig, and proved where they live: that idle compaction no longer pins `working` (B1/B2:
 * `transcript-tail.test.ts`, `turn-look-status.test.ts`, `turn-policy.test.ts`), and the Warden flagging `input_stuck`
 * (`tests/integration/subsystem.test.ts` of the Warden).
 */

const F1 = ferretId('f1');
const F2 = ferretId('f2');
const START = '2026-11-07T09:00:00Z';
const MINUTE = 60_000;

/** Two plain lines, a peer's, well under the 500-character direct ceiling. */
const MESSAGE = '[message · from :ireland · peer]\nPlease keep the queue ordering as v4 and tell me when it is in.';

class Pane {
  /** What the composer shows now: `undefined` while the pane has drawn nothing. */
  draft: string | undefined;
  /** Whether the fill's typing is drawn at all (a stalled pane draws it later, when the test says so). */
  draws = false;
  /** Whether an Enter submits the draft. */
  enterTakes = true;
  readonly typed: string[] = [];
  readonly submitted: string[] = [];
}

class StrandedFerrets extends FakeFerrets {
  readonly pane = new Pane();
  readonly documents: { readonly turn: number; readonly document: string }[] = [];
  transcript: TranscriptEntry[] = [];
  stored: FerretTurnDocument[] = [];

  async harness(ferret: FerretId): Promise<FerretHarness | undefined> {
    if ((await this.get(ferret)) === undefined) return undefined;
    const pane = this.pane;
    return {
      deliver: async (delivery: RunnerDelivery) => {
        pane.typed.push(delivery.text);
        if (!pane.draws) return err({ unconfirmed: true as const, stranded: false });
        pane.draft = delivery.text;
        return ok('turn-started' as const);
      },
      queue: async () => ok('held' as const),
      interrupt: async () => ok({ pressed: true, working: false }),
      observe: async () =>
        ok({
          alive: true,
          dead: false,
          promptReady: pane.draft === undefined,
          activeWork: false,
          ...(pane.draft === undefined ? {} : { draft: pane.draft }),
        }),
      heldAt: async text => ok(pane.draft !== undefined && pane.draft === text ? ('composer' as const) : undefined),
      submitComposer: async text => {
        pane.submitted.push(text);
        if (pane.draft !== text) return ok('absent' as const);
        if (!pane.enterTakes) return ok('holding' as const);
        pane.draft = undefined;
        // The harness writes its user record for the message the Enter submitted.
        this.transcript = [
          ...this.transcript,
          { id: `u-${pane.submitted.length}`, role: 'user', text, at: START as Instant },
        ];
        return ok('submitted' as const);
      },
      transcript: {
        read: async () => this.transcript,
        follow: () => {
          throw new Error('unused');
        },
        find: async () => undefined,
      },
    };
  }

  async turns(ferret: FerretId): Promise<FerretTurns | undefined> {
    if ((await this.get(ferret)) === undefined) return undefined;
    const base: FerretTurns = { list: async () => this.stored };
    return {
      ...base,
      write: async request => {
        const turn = this.documents.length + 2;
        this.documents.push({ turn, document: request.document });
        this.stored.push({ turn, text: request.document.trimEnd() });
        return { turn, file: `/state/turns/turn-${String(turn).padStart(3, '0')}.md` };
      },
      writeQueued: async sendId => `/state/channel/queued-${sendId}.md`,
      clearMarkers: async () => undefined,
    };
  }
}

const settle = async (): Promise<void> => {
  for (let round = 0; round < 25; round += 1) await Bun.sleep(0);
};

async function rig(state: StatePort = memoryStatePort(CONVERSATION_STATE)) {
  const ferrets = new StrandedFerrets();
  ferrets.add({ id: F1, state: 'idle' });
  ferrets.add({ id: F2, state: 'idle' });
  const clock = fixedClock(START);
  // The daemon half over the test's own state port, so the ledger can be read without asking the tracker to look.
  const implementation = {
    ...daemon,
    build: (ctx: Parameters<NonNullable<typeof daemon.build>>[0]) => {
      const build = daemon.build;
      if (build === undefined) throw new Error('the conversation daemon half has no build');
      return build({ ...ctx, kernel: { ...ctx.kernel, state } });
    },
  } as typeof daemon;
  const host = await testHost({
    plugins: [implementation, wardenStandIn],
    fakes: { ferrets, asks: new FakeAsks() },
    clock,
  });
  await settle();
  const api = () => host.provided(ConversationPort);
  /** The row as the ledger holds it, read WITHOUT asking the tracker for a look: only its own looks move a fate. */
  const stored = async (sendId: string) =>
    (await new StateSendLedger(state, { now: () => START as Instant }).list(parseSessionId('f1'))).find(
      entry => entry.sendId === sendId,
    );
  const advance = async (totalMs: number, stepMs = 10_000): Promise<void> => {
    for (let spent = 0; spent < totalMs; spent += stepMs) {
      await clock.advance(stepMs);
      await settle();
    }
  };
  const events = (): string[] => host.logs.map(entry => entry.message);
  return { host, ferrets, api, stored, advance, events };
}

/** The direct peer send of the incident: typed, nothing drawn within the fill's window, settled unconfirmed. */
async function strandedSend(world: Awaited<ReturnType<typeof rig>>, sendId: string) {
  const sent = await world.api().send(F1, { kind: 'ferret', ferret: F2 }, { message: MESSAGE, sendId });
  expect(sent).toMatchObject({ ok: false, error: { code: 'send_unconfirmed' } });
  const row = await world.stored(sendId);
  expect(row).toMatchObject({ path: 'direct', fate: 'unaccounted', unaccountedReason: 'landing_unconfirmed' });
  return row;
}

describe('B187 a stranded direct send', () => {
  test('B187 a direct send unconfirmed at the fill, drawn late, then idle compaction: one Enter submits it and the queue drains', async () => {
    const world = await rig();
    const { ferrets, advance } = world;
    const row = await strandedSend(world, 's-nelly');
    const text = row?.matchText ?? MESSAGE;

    // The pane draws nothing for eleven minutes — past the old ten-minute look — and nobody presses a key.
    await advance(11 * MINUTE);
    expect(await world.stored('s-nelly')).toMatchObject({ fate: 'unaccounted' });
    expect(await world.stored('s-nelly')).not.toHaveProperty('typedNotSent');
    expect(ferrets.pane.submitted).toEqual([]);

    // The pane finally draws the text and sits idle with it in the box (the idle-compaction banner changes nothing the
    // tracker reads). Two more messages are queued behind it.
    ferrets.pane.draft = text;
    await world.api().send(F1, { kind: 'ferret', ferret: F2 }, { message: 'FIXTURE later A', sendId: 's-a' });
    await world.api().send(F1, { kind: 'ferret', ferret: F2 }, { message: 'FIXTURE later B', sendId: 's-b' });
    await advance(5 * MINUTE);

    // The tracker saw the text in the box, said so once, and ONE Enter submitted it; the harness's record proved it.
    expect(world.events()).toContain('control.send_typed_not_sent');
    expect(ferrets.pane.submitted).toEqual([text]);
    expect(await world.stored('s-nelly')).toMatchObject({ fate: 'delivered' });
    expect(ferrets.pane.draft).toBeUndefined();

    // The queue is clear: the two messages that waited behind it were typed, in order.
    expect(ferrets.pane.typed.filter(typed => typed.includes('FIXTURE later'))).toEqual([
      expect.stringContaining('FIXTURE later A'),
      expect.stringContaining('FIXTURE later B'),
    ]);
    await world.host.stop();
  });

  test('B187 the same sequence where the Enter does not take: the send is raised stranded once and no Enter is repeated', async () => {
    const world = await rig();
    const { ferrets, advance } = world;
    const row = await strandedSend(world, 's-nelly');
    const text = row?.matchText ?? MESSAGE;
    ferrets.pane.enterTakes = false;

    await advance(11 * MINUTE);
    ferrets.pane.draft = text;
    await advance(10 * MINUTE);

    // Seen late, it got exactly one verified Enter; still there after it, it is raised — and the Warden's input_stuck
    // reads that raised send from here (its own tests).
    expect(ferrets.pane.submitted).toEqual([text]);
    expect(await world.stored('s-nelly')).toMatchObject({
      fate: 'unaccounted',
      typedNotSent: true,
      unaccountedReason: 'typed_not_submitted',
    });
    expect(world.events().filter(event => event === 'control.send_stranded')).toHaveLength(1);
    expect(world.events().filter(event => event === 'control.send_typed_not_sent')).toHaveLength(1);
    await world.host.stop();
  });
});
