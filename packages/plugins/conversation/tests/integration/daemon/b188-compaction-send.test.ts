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
 * B188 — "send while Compacting → lots of stuck messages", on a FAKE Claude pane and a driven clock (no tmux).
 *
 * The real conversation daemon half (send path, tracker, ledger over a state port) over a fake Ferrets whose pane is a
 * small model of Claude's composer and of its idle compaction. An IDLE ferret that starts compacting draws
 * `· Compacting conversation…`, and its record says `awaiting_user`, a status that routes a send idle: the message was
 * typed straight into the compacting composer, and a turn document was written for a turn that could not start. A
 * visible compaction now outranks the stored status: the message rides the harness's own queue and starts no turn.
 *
 * Not in this rig, and proved where they live: that the compaction summary is not turn work and that an idle composer
 * holding a draft is an idle prompt for the turn look (`turn-policy.test.ts` and `idle-draft-prompt.test.ts` of
 * Ferrets, `policy.test.ts` of the turns); that the queue holds a message behind a draft (`deliverer.test.ts` of the
 * queue); and the runner's own refusal of a compacting pane, through the real pane parsers (`b188-compaction-send.test.ts`
 * of the terminals plugin, on the fake tmux server).
 */

const F1 = ferretId('f1');
const F2 = ferretId('f2');
const START = '2026-11-10T21:46:00Z';
const MINUTE = 60_000;
const PEER = 'please rerun the catalog suite against the new share links';

class Pane {
  /** Whether the harness shows `Compacting conversation…` over the composer. */
  compacting = false;
  /** Typed through the idle path (`deliver`), in order. */
  readonly typed: string[] = [];
  /** Typed through the harness's own queue (`queue`), in order. */
  readonly queued: string[] = [];
}

class CompactingFerrets extends FakeFerrets {
  readonly pane = new Pane();
  transcript: TranscriptEntry[] = [];
  stored: FerretTurnDocument[] = [];

  async harness(ferret: FerretId): Promise<FerretHarness | undefined> {
    if ((await this.get(ferret)) === undefined) return undefined;
    const pane = this.pane;
    return {
      deliver: async (delivery: RunnerDelivery) => {
        // The terminals runner's own rule (`paneShowsActiveWork`, a compaction included): a pane at work types nothing.
        if (pane.compacting) return err({ refused: 'not_ready' as const, why: 'busy' as const });
        pane.typed.push(delivery.text);
        // The idle path types, presses Enter and the harness writes its user record for the message.
        this.transcript = [
          ...this.transcript,
          { id: `u-${pane.typed.length}`, role: 'user', text: delivery.text, at: START as Instant },
        ];
        return ok('turn-started' as const);
      },
      queue: async text => {
        pane.queued.push(text);
        return ok('held' as const);
      },
      interrupt: async () => ok({ pressed: true, working: false }),
      observe: async () =>
        ok({
          alive: true,
          dead: false,
          promptReady: !pane.compacting,
          activeWork: pane.compacting,
          compacting: pane.compacting,
        }),
      heldAt: async () => ok(undefined),
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
        const turn = this.stored.length + 2;
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
  const ferrets = new CompactingFerrets();
  // The ferret is idle: its record says `awaiting_user`, a status that routes a send idle outside a compaction.
  ferrets.add({ id: F1, state: 'idle' });
  ferrets.add({ id: F2, state: 'idle' });
  const clock = fixedClock(START);
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
  return { host, ferrets, api, stored, advance };
}

describe('B188 an idle ferret starts compacting', () => {
  test('B188 a peer send handed over while an idle ferret compacts rides the harness queue, and nothing is typed through the idle path', async () => {
    const world = await rig();
    const { ferrets, advance } = world;
    ferrets.pane.compacting = true;

    // A peer's message arrives a few seconds into the compaction, and the compaction outlasts the tracker's looks.
    await advance(4_000, 2_000);
    await world.api().send(F1, { kind: 'ferret', ferret: F2 }, { message: PEER, sendId: 's-peer' });
    await advance(5 * MINUTE);

    // The send rode the harness's own queue (busy), never the idle path that types into a composer.
    expect(ferrets.pane.queued).toHaveLength(1);
    expect(ferrets.pane.queued[0]).toContain(PEER);
    expect(ferrets.pane.typed).toEqual([]);
    // No turn document was written for it: a compacting pane is not somewhere a turn starts (the idle route writes one).
    expect(ferrets.stored).toEqual([]);
    expect(await world.stored('s-peer')).toMatchObject({ path: 'native-inline' });
    await world.host.stop();
  });

  test('B188 the same send with the compaction over goes the idle path and starts a turn, so only the compaction decided the route', async () => {
    const world = await rig();
    const { ferrets, advance } = world;

    await world.api().send(F1, { kind: 'ferret', ferret: F2 }, { message: PEER, sendId: 's-peer' });
    await advance(5 * MINUTE);

    expect(ferrets.pane.queued).toEqual([]);
    expect(ferrets.pane.typed).toHaveLength(1);
    expect(ferrets.pane.typed[0]).toContain(PEER);
    expect(ferrets.stored).toHaveLength(1);
    await world.host.stop();
  });
});
