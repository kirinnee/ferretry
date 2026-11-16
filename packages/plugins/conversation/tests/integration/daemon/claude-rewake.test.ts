import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import type {
  FerretHarness,
  FerretId,
  FerretRewake,
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
import { OWNER_NUDGE_TEXT } from '../../../daemon/delivery/lib/index.ts';
import { parseSessionId } from '../../../daemon/seams/ferret-id.ts';
import { memoryStatePort } from '../../support/state.ts';
import { wardenStandIn } from '../../support/warden-plugin.ts';

/**
 * A Claude agent's messages from another ferret and the daemon's notices are handed in by the Stop hook's listener, not
 * typed; the OWNER's words never are (the harness frames hook text as a system notification, not as the owner).
 *
 * The real conversation daemon half over a fake Ferrets whose pane is a small model of Claude's composer AND whose rewake
 * inbox is a map the test drives (the listener claiming a file, going quiet). The clock is driven; no tmux, no network.
 */

const F1 = ferretId('f1');
const F2 = ferretId('f2');
const START = '2026-11-16T09:00:00Z';
const SECOND = 1_000;

/** The banner the daemon puts on a message from ferret `avary` (session f2), and the message after it. */
const BANNER = '[message from ferret avary (session f2) — not from the owner] To reply: fy send avary "<reply>"\n';
const AGENT_TEXT = `${BANNER}Please look at the failing build and tell me what you find.`;

class RewakeFerrets extends FakeFerrets {
  /** What the pane was typed (the composer, submitted). */
  readonly typed: string[] = [];
  /** The listener's inbox: file name (the send id) to its text. */
  readonly inbox = new Map<string, string>();
  /** The listener's heartbeat is fresh. */
  armed = true;
  /** The composer cannot be read to prove it empty (a stuck frame). */
  unreadable = false;
  transcript: TranscriptEntry[] = [];
  stored: FerretTurnDocument[] = [];
  private turnCount = 1;

  async harness(ferret: FerretId): Promise<FerretHarness | undefined> {
    if ((await this.get(ferret)) === undefined) return undefined;
    return {
      deliver: async (delivery: RunnerDelivery) => {
        if (this.unreadable) return err({ refused: 'composer_unreadable' as const });
        this.typed.push(delivery.text);
        this.transcript = [
          ...this.transcript,
          { id: `u-${this.typed.length}`, role: 'user', text: delivery.text, at: this.clockAt() },
        ];
        return ok('turn-started' as const);
      },
      queue: async () => ok('held' as const),
      interrupt: async () => ok({ pressed: true, working: false }),
      observe: async () => ok({ alive: true, dead: false, promptReady: true, activeWork: false }),
      heldAt: async () => ok(undefined),
      submitComposer: async () => ok('absent' as const),
      transcript: {
        read: async () => this.transcript,
        follow: () => {
          throw new Error('unused');
        },
        find: async () => undefined,
      },
    };
  }

  now: () => Instant = () => START as Instant;
  private clockAt(): Instant {
    return this.now();
  }

  async turns(ferret: FerretId): Promise<FerretTurns | undefined> {
    if ((await this.get(ferret)) === undefined) return undefined;
    return {
      list: async () => this.stored,
      write: async request => {
        this.turnCount += 1;
        const turn = this.turnCount;
        this.stored.push({ turn, text: request.document.trimEnd() });
        return { turn, file: `/state/turns/turn-${String(turn).padStart(3, '0')}.md` };
      },
      writeQueued: async sendId => `/state/channel/queued-${sendId}.md`,
      clearMarkers: async () => undefined,
    };
  }

  async rewake(ferret: FerretId): Promise<FerretRewake | undefined> {
    if ((await this.get(ferret)) === undefined) return undefined;
    return {
      armed: async () => this.armed,
      deposit: async (sendId, text) => {
        if (!this.inbox.has(sendId)) this.inbox.set(sendId, text);
      },
      waiting: async sendId => this.inbox.has(sendId),
      withdraw: async sendId => this.inbox.delete(sendId),
    };
  }
}

const settle = async (): Promise<void> => {
  for (let round = 0; round < 25; round += 1) await Bun.sleep(0);
};

async function rig(state: StatePort = memoryStatePort(CONVERSATION_STATE)) {
  const ferrets = new RewakeFerrets();
  ferrets.add({ id: F1, name: 'nelly', state: 'idle' });
  ferrets.add({ id: F2, name: 'avary', state: 'idle' });
  const clock = fixedClock(START);
  ferrets.now = () => clock.now() as Instant;
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
  const row = async (sendId: string) =>
    (await new StateSendLedger(state, { now: () => START as Instant }).list(parseSessionId('f1'))).find(
      entry => entry.sendId === sendId,
    );
  const advance = async (totalMs: number, stepMs = 2 * SECOND): Promise<void> => {
    for (let spent = 0; spent < totalMs; spent += stepMs) {
      await clock.advance(stepMs);
      await settle();
    }
  };
  return { host, ferrets, api, row, advance, clock };
}

/** The harness's record of a hook delivery, in the measured wrapper form (Claude Code 2.1.317). */
const hookRecord = (text: string, id: string, at: Instant): TranscriptEntry => ({
  id,
  role: 'user',
  at,
  text:
    '<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\n' +
    `Stop hook blocking error from command "Stop": ${text}\n\n</system-reminder>`,
});

describe('a Claude ferret is handed an agent’s message by the Stop hook', () => {
  test('an agent send to an armed ferret is written to the inbox, nothing is typed, and it is proven from the wrapper entry', async () => {
    const world = await rig();
    const { ferrets } = world;

    const sent = await world
      .api()
      .send(
        F1,
        { kind: 'ferret', ferret: F2 },
        { message: 'Please look at the failing build and tell me what you find.', sendId: 'agent-1' },
      );

    expect(sent.ok).toBe(true);
    // Exactly what would have been typed, banner line included — and not a key was pressed.
    expect([...ferrets.inbox.values()]).toEqual([AGENT_TEXT]);
    expect(ferrets.typed).toEqual([]);
    expect(await world.row('agent-1')).toMatchObject({
      path: 'hook',
      fate: 'accepted',
      senderKind: 'agent',
      message: AGENT_TEXT,
      matchText: AGENT_TEXT,
    });

    // The listener claims the file and the harness records the wake in its hook-feedback wrapper: that is the proof.
    ferrets.inbox.clear();
    ferrets.transcript = [hookRecord(AGENT_TEXT, 'wake-1', world.clock.now() as Instant)];
    await world.advance(6 * SECOND);

    expect(await world.row('agent-1')).toMatchObject({ path: 'hook', fate: 'delivered' });
    expect(ferrets.typed).toEqual([]);
    await world.host.stop();
  });

  test('an OWNER send to the same armed ferret is typed, never written to the inbox', async () => {
    const world = await rig();
    const { ferrets } = world;

    const sent = await world.api().send(F1, { kind: 'owner' }, { message: 'Please ship it.', sendId: 'owner-1' });

    expect(sent.ok).toBe(true);
    expect(ferrets.inbox.size).toBe(0);
    expect(ferrets.typed).toEqual(['Please ship it.']);
    expect(await world.row('owner-1')).toMatchObject({ path: 'direct', senderKind: 'human' });
    await world.host.stop();
  });

  test('a ferret whose listener is not armed is typed as it always was', async () => {
    const world = await rig();
    const { ferrets } = world;
    ferrets.armed = false;

    await world
      .api()
      .send(
        F1,
        { kind: 'ferret', ferret: F2 },
        { message: 'Please look at the failing build and tell me what you find.', sendId: 'agent-2' },
      );

    expect(ferrets.inbox.size).toBe(0);
    expect(ferrets.typed).toEqual([AGENT_TEXT]);
    expect(await world.row('agent-2')).toMatchObject({ path: 'direct' });
    await world.host.stop();
  });

  test('the Warden’s composer acts are never handed over by the hook', async () => {
    const world = await rig();
    const { ferrets } = world;

    await world.host
      .provided(ConversationPort, 'warden')
      .send(F1, { kind: 'warden' }, { message: 'FIXTURE warden nudge', sendId: 'warden-1' });

    expect(ferrets.inbox.size).toBe(0);
    expect(ferrets.typed).toEqual(['FIXTURE warden nudge']);
    await world.host.stop();
  });

  test('a message the listener never claims is taken back out of the inbox after the limit and typed instead', async () => {
    const world = await rig();
    const { ferrets } = world;

    await world
      .api()
      .send(
        F1,
        { kind: 'ferret', ferret: F2 },
        { message: 'Please look at the failing build and tell me what you find.', sendId: 'agent-3' },
      );
    expect(ferrets.inbox.size).toBe(1);

    // The listener goes quiet and claims nothing: well past the limit the file is gone and the message was typed, once.
    await world.advance(40 * SECOND);

    expect(ferrets.inbox.size).toBe(0);
    expect(ferrets.typed).toEqual([AGENT_TEXT]);
    expect(await world.row('agent-3')).toMatchObject({ path: 'direct', matchText: AGENT_TEXT });
    await world.host.stop();
  });

  test('a message the listener DID claim is never typed, however long the harness takes to record it', async () => {
    const world = await rig();
    const { ferrets } = world;

    await world
      .api()
      .send(
        F1,
        { kind: 'ferret', ferret: F2 },
        { message: 'Please look at the failing build and tell me what you find.', sendId: 'agent-4' },
      );
    ferrets.inbox.clear();
    await world.advance(90 * SECOND);

    expect(ferrets.typed).toEqual([]);
    expect(await world.row('agent-4')).toMatchObject({ path: 'hook', fate: 'accepted' });
    await world.host.stop();
  });
});

describe('the owner nudge', () => {
  test('a stuck owner message earns ONE notice with none of the owner’s words, and is typed once the frame reads clear', async () => {
    const world = await rig();
    const { ferrets } = world;
    ferrets.unreadable = true;

    const sent = await world
      .api()
      .send(F1, { kind: 'owner' }, { message: 'SECRET-OWNER-WORDS please deploy', sendId: 'owner-stuck' });
    expect(sent).toMatchObject({ ok: true });
    expect(ferrets.typed).toEqual([]);
    expect(await world.row('owner-stuck')).toMatchObject({ untyped: true });

    // Not yet stuck long enough: no notice.
    await world.advance(20 * SECOND);
    expect(ferrets.inbox.size).toBe(0);

    // Past 30 s: exactly one notice, which names nobody's words.
    await world.advance(30 * SECOND);
    expect([...ferrets.inbox.values()]).toEqual([OWNER_NUDGE_TEXT]);
    expect([...ferrets.inbox.values()].join('')).not.toContain('SECRET-OWNER-WORDS');
    expect(await world.row('owner-stuck')).toMatchObject({ untyped: true, nudgedAt: expect.any(String) });

    // The woken turn ends and the frame reads clear: the next retype types the OWNER's message as real input.
    ferrets.inbox.clear();
    ferrets.unreadable = false;
    await world.advance(30 * SECOND);

    expect(ferrets.typed).toEqual(['SECRET-OWNER-WORDS please deploy']);
    expect(await world.row('owner-stuck')).not.toMatchObject({ untyped: true });
    // Once per send: it was not left again, before or after.
    expect(ferrets.inbox.size).toBe(0);
    await world.host.stop();
  });

  test('no notice is left for a ferret whose listener is not armed, and none is left twice', async () => {
    const world = await rig();
    const { ferrets } = world;
    ferrets.unreadable = true;
    ferrets.armed = false;

    await world.api().send(F1, { kind: 'owner' }, { message: 'please deploy', sendId: 'owner-stuck-2' });
    await world.advance(60 * SECOND);
    expect(ferrets.inbox.size).toBe(0);

    // The listener arms later: one notice, and a second stretch of waiting leaves no second one.
    ferrets.armed = true;
    await world.advance(20 * SECOND);
    expect(ferrets.inbox.size).toBe(1);
    ferrets.inbox.clear();
    await world.advance(60 * SECOND);
    expect(ferrets.inbox.size).toBe(0);
    await world.host.stop();
  });
});
