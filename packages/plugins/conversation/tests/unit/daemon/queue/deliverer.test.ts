import type { Instant } from '@ferretry/std';
import { describe, it } from 'bun:test';
import type { QueuedMessage } from '../../../../daemon/seams/protocol.ts';
import should from 'should';
import {
  type DeliveryView,
  type HandOver,
  movesFrom,
  type OwnDraft,
  reasonForWaiting,
} from '../../../../daemon/queue/lib/delivery.ts';
import {
  defaultQueueDeliverySettings,
  QueueDeliverer,
  type QueueDelivery,
  type QueueDeliverySettings,
} from '../../../../daemon/queue/lib/deliverer.ts';
import { foldQueue, type QueueEvent } from '../../../../daemon/queue/lib/model.ts';
import { type SendFate, type SendPaneObservation, type SendTarget } from '../../../../daemon/delivery/lib/types.ts';
import { parseSessionId, type SessionId } from '../../../../daemon/seams/ferret-id.ts';

const ID = parseSessionId('session-1');
const T0 = Date.UTC(2026, 9, 30, 13, 5, 0);

function message(
  id: string,
  sender: QueuedMessage['sender'],
  seconds = 0,
  extra: Partial<QueuedMessage> = {},
): QueuedMessage {
  const at = new Date(T0 + seconds * 1_000).toISOString() as Instant as Instant;
  return {
    ...extra,
    v: 1,
    id,
    sender,
    text: `${id} text`,
    attachmentIds: [],
    enqueuedAt: at,
    state: 'queued',
    stateAt: at,
    revision: 1,
  };
}

const pane = (overrides: Partial<SendPaneObservation> = {}): SendPaneObservation => ({
  alive: true,
  dead: false,
  promptReady: false,
  activeWork: true,
  ...overrides,
});

/** A session, its pane, its queue log and the send path, all in memory and all on the record. */
class World {
  readonly log: QueueEvent[] = [];
  readonly handed: string[] = [];
  /** Every delivery handed over, whole, with the queue as it stood the moment it was. */
  readonly deliveries: Array<{ delivery: QueueDelivery; during: readonly QueuedMessage[] }> = [];
  readonly scheduled: number[] = [];
  readonly fates = new Map<string, SendFate>();
  target: SendTarget = { id: ID, status: 'running', mode: 'auto', turn: 4, harness: 'claude' };
  pane: SendPaneObservation | 'unreadable' = pane();
  launching = false;
  /** What each hand-over answers, in order; then `landed`. */
  readonly answers: Array<HandOver | Error> = [];
  nowMs = T0;
  /** Each wait the deliverer asked for, resolved at once unless a test holds it. */
  readonly slept: number[] = [];
  /** A hand-over that waits until the test releases it. */
  hold: Promise<void> | undefined;
  /** A drain bound that never runs out, so only the hand-over finishing can end a stop. */
  sleepForever = false;
  /** What the send path says of a draft in the box: a person's unless a test says it is a send of ours. */
  ownDraft: () => OwnDraft = () => ({ kind: 'foreign' });
  /** How many times the deliverer asked the send path to finish a draft of ours. */
  clears = 0;
  /** How many times the deliverer asked the send tracker to look; a test may make the look settle a send. */
  rechecks = 0;
  onRecheck: () => void = () => undefined;
  /** Runs on every ledger read, so a test can act in the middle of a look. */
  onFate: () => void = () => undefined;
  /** The settings the deliverer reads on every look; a test narrows them with Object.assign. */
  readonly settings: { -readonly [K in keyof QueueDeliverySettings]: QueueDeliverySettings[K] } = {
    ...defaultQueueDeliverySettings,
  };
  readonly deliverer: QueueDeliverer;

  constructor(...messages: QueuedMessage[]) {
    for (const entry of messages) this.log.push({ v: 1, kind: 'enqueued', at: entry.enqueuedAt, message: entry });
    this.deliverer = new QueueDeliverer(
      {
        store: {
          read: async () => [...this.log],
          append: async (_id, event) => void this.log.push(event),
        },
        serial: { run: async (_key, work) => await work(), runExclusive: async work => await work() },
        clock: { now: () => new Date(this.nowMs).toISOString() as Instant },
        scheduler: { schedule: (_id, delayMs) => void this.scheduled.push(delayMs), cancelAll: () => undefined },
        view: async (): Promise<DeliveryView> => {
          if (this.pane === 'unreadable') throw new Error('capture failed');
          return { target: this.target, pane: this.pane, launching: this.launching };
        },
        transport: {
          handOver: async (_id: SessionId, delivery: QueueDelivery) => {
            this.handed.push(delivery.sendId);
            this.deliveries.push({ delivery, during: this.queue });
            if (this.hold !== undefined) await this.hold;
            const answer = this.answers.shift() ?? { kind: 'landed' };
            if (answer instanceof Error) throw answer;
            return answer;
          },
          fate: async (_id: SessionId, messageId: string) => {
            this.onFate();
            return this.fates.get(messageId);
          },
          clearOwnDraft: async () => {
            this.clears += 1;
            return this.ownDraft();
          },
          recheck: async () => {
            this.rechecks += 1;
            this.onRecheck();
          },
        },
        sessions: () => [ID],
        sleep: async milliseconds => {
          this.slept.push(milliseconds);
          if (this.sleepForever) await new Promise<void>(() => undefined);
        },
      },
      this.settings,
    );
  }

  get queue(): readonly QueuedMessage[] {
    return foldQueue(this.log);
  }

  state(id: string): QueuedMessage | undefined {
    return this.queue.find(entry => entry.id === id);
  }
}

describe('handing over a queue', () => {
  it("should type the owner's message first, then the ferret's, then the daemon's, mid-turn", async () => {
    // The input box is empty and a turn is running: the owner's rule says that is ready.
    const world = new World(message('warden', 'daemon', 0), message('peer', 'agent', 1), message('owner', 'human', 2));

    await world.deliverer.enqueued(ID);

    should(world.handed).eql(['owner', 'peer', 'warden']);
    should(world.queue.map(entry => entry.state)).eql(['delivered', 'delivered', 'delivered']);
  });

  it('should hold every message for a draft in the box, saying so once, and look again soon', async () => {
    const world = new World(message('a', 'human'), message('b', 'agent', 1));
    world.pane = pane({ draft: 'half a question' });

    await world.deliverer.enqueued(ID);
    await world.deliverer.changed(ID);

    should(world.handed).be.empty();
    should(world.queue.map(entry => entry.waitReason)).eql(['draft', 'draft']);
    should(world.log.filter(event => event.kind === 'waiting')).have.length(2);
    should(world.scheduled.at(-1)).equal(defaultQueueDeliverySettings.lookMs);
  });

  it('should finish a send of ours left unsubmitted in the box, then deliver at once (B144)', async () => {
    // annabeth, 2026-11-02: her own turn pointer sat typed in the box, idle, and thirteen messages waited
    // behind it as a "draft" for five hours. The draft is the daemon's, so the queue clears it and goes on.
    const world = new World(message('a', 'agent'), message('b', 'daemon', 1));
    world.pane = pane({ activeWork: false, draft: 'Read the file /x/turns/turn-063.md now, then …' });
    world.ownDraft = () => {
      world.pane = pane({ activeWork: false });
      return { kind: 'clear' };
    };

    await world.deliverer.enqueued(ID);

    should(world.clears).equal(1);
    should(world.handed).eql(['a', 'b']);
    should(world.queue.map(entry => entry.state)).eql(['delivered', 'delivered']);
    should(world.log.filter(event => event.kind === 'waiting')).be.empty();
  });

  it('should name the send of ours a message waits behind when an Enter did not take it', async () => {
    const world = new World(message('a', 'agent'));
    world.pane = pane({ activeWork: false, draft: '[Pasted text #40 +3 lines]' });
    world.ownDraft = () => ({ kind: 'stuck', sendId: 'stranded-1', tried: true });

    await world.deliverer.enqueued(ID);

    should(world.handed).be.empty();
    should(world.state('a')?.waitReason).equal('draft');
    should(world.state('a')?.waitBehind).equal('stranded-1');
    should(world.scheduled.at(-1)).equal(defaultQueueDeliverySettings.lookMs);
  });

  it('should wait as unreadable when the box cannot be read again after clearing a draft of ours', async () => {
    const world = new World(message('a', 'agent'));
    world.pane = pane({ activeWork: false, draft: 'Read the file /x/turns/turn-063.md now, then …' });
    world.ownDraft = () => {
      world.pane = 'unreadable';
      return { kind: 'clear' };
    };

    await world.deliverer.enqueued(ID);

    should(world.handed).be.empty();
    should(world.state('a')?.waitReason).equal('unreadable');
  });

  it("should leave a person's draft alone, waiting with no send named behind it", async () => {
    const world = new World(message('a', 'agent'));
    world.pane = pane({ activeWork: false, draft: 'half a question' });

    await world.deliverer.enqueued(ID);

    should(world.clears).equal(1);
    should(world.handed).be.empty();
    should(world.state('a')?.waitReason).equal('draft');
    should(world.state('a')).not.have.property('waitBehind');
  });

  it('should go as soon as the box clears, dropping the reason it waited for', async () => {
    const world = new World(message('a', 'human'));
    world.pane = pane({ draft: 'half a question' });
    await world.deliverer.enqueued(ID);

    world.pane = pane();
    await world.deliverer.changed(ID);

    should(world.handed).eql(['a']);
    should(world.state('a')).not.have.property('waitReason');
    should(world.state('a')?.state).equal('delivered');
  });

  it('should say which thing holds the session: starting, a question, a dialog, an unreadable screen', async () => {
    const cases: Array<[string, (world: World) => void, string]> = [
      [
        'launching',
        world => {
          world.launching = true;
        },
        'launching',
      ],
      [
        'question',
        world => {
          world.target = { ...world.target, pendingQuestion: { toolUseId: 't1' } };
        },
        'question',
      ],
      [
        'dialog',
        world => {
          world.pane = pane({ blockingPrompt: 'Do you trust this folder?' });
        },
        'dialog',
      ],
      [
        'unreadable',
        world => {
          world.pane = 'unreadable';
        },
        'unreadable',
      ],
    ];
    for (const [, arrange, reason] of cases) {
      const world = new World(message('a', 'human'));
      arrange(world);

      await world.deliverer.enqueued(ID);

      should(world.handed).be.empty();
      should(world.state('a')?.waitReason).equal(reason);
    }
  });

  it('should type nothing else while one message is unproven, and settle it from the send ledger', async () => {
    const world = new World(message('a', 'human'), message('b', 'human', 1));
    world.answers.push({ kind: 'unproven' });

    await world.deliverer.enqueued(ID);
    should(world.handed).eql(['a']);
    should(world.state('a')?.state).equal('typing');

    world.fates.set('a', 'queued');
    await world.deliverer.changed(ID);

    should(world.handed).eql(['a', 'b']);
    should(world.state('a')?.state).equal('delivered');
  });

  it('should put a refused message back with the reason, and never fail it', async () => {
    const world = new World(message('a', 'human'));
    world.answers.push({ kind: 'refused', reason: 'unreadable' });

    await world.deliverer.enqueued(ID);

    should(world.state('a')).containEql({ state: 'queued', waitReason: 'unreadable' });
  });

  it('should fail a message the send path refused for good, and move on to the next', async () => {
    const world = new World(message('a', 'human'), message('b', 'human', 1));
    world.answers.push({ kind: 'failed', failure: 'a send requires a message' });

    await world.deliverer.enqueued(ID);

    should(world.state('a')).containEql({ state: 'failed', failure: 'a send requires a message' });
    should(world.state('b')?.state).equal('delivered');
  });

  it('should hold the queue with a reason, not behind a typing message, when the pane never came to a prompt (&B153)', async () => {
    // ryu: the send path gave up waiting for a prompt before any key. It now says so, and the message waits
    // as `busy` — visible to its sender — instead of sitting `typing` with everything else behind it.
    const world = new World(message('a', 'human'), message('b', 'human', 1));
    world.answers.push({ kind: 'refused', reason: 'busy' });

    await world.deliverer.enqueued(ID);

    should(world.handed).eql(['a']);
    should(world.state('a')).containEql({ state: 'queued', waitReason: 'busy' });
    should(world.state('b')).containEql({ state: 'queued', waitReason: 'busy' });
    should(world.scheduled.at(-1)).equal(defaultQueueDeliverySettings.lookMs);

    // The next look finds the prompt: both go, in order, and nothing was typed twice.
    await world.deliverer.changed(ID);

    should(world.handed).eql(['a', 'a', 'b']);
    should(world.queue.map(entry => entry.state)).eql(['delivered', 'delivered']);
  });

  it('should ask the tracker to look at a hand-over left accepted too long, then move on once it settles (&B153)', async () => {
    const world = new World(message('a', 'human'), message('b', 'human', 1));
    world.answers.push(new Error('tmux session fy-ryu did not become ready to accept a turn'));
    world.fates.set('a', 'accepted');

    await world.deliverer.enqueued(ID);
    should(world.state('a')?.state).equal('typing');

    // Inside the window the tracker's own look is still due: nothing is asked.
    world.nowMs += defaultQueueDeliverySettings.recheckMs - 1;
    await world.deliverer.changed(ID);
    should(world.rechecks).equal(0);

    // Past it, the tracker is asked once — and not again on every five-second look after.
    world.nowMs += 1;
    await world.deliverer.changed(ID);
    world.nowMs += defaultQueueDeliverySettings.lookMs;
    await world.deliverer.changed(ID);
    should(world.rechecks).equal(1);
    should(world.handed).eql(['a']);

    // Still accepted a window later: asked again. This look proves it absent and retypes it, held in the queue.
    world.onRecheck = () => void world.fates.set('a', 'queued');
    world.nowMs += defaultQueueDeliverySettings.recheckMs;
    await world.deliverer.changed(ID);
    should(world.rechecks).equal(2);
    await world.deliverer.changed(ID);

    should(world.state('a')?.state).equal('delivered');
    should(world.handed).eql(['a', 'b']);
    should(world.state('b')?.state).equal('delivered');
  });

  it('should not hand a message over again until the pane shows a prompt, after one never came (&B153)', async () => {
    // Each hand-over to a pane with no prompt waits out a half-minute readiness window under both locks;
    // handed over on every five-second look, a pane drawing neither a prompt nor work looped for hours.
    const world = new World(message('a', 'human'), message('b', 'human', 1));
    world.target = { ...world.target, status: 'awaiting_user' };
    world.pane = pane({ activeWork: false });
    world.answers.push({ kind: 'refused', reason: 'busy', untilPrompt: true });

    await world.deliverer.enqueued(ID);
    world.nowMs += defaultQueueDeliverySettings.lookMs;
    await world.deliverer.changed(ID);
    world.nowMs += defaultQueueDeliverySettings.lookMs;
    await world.deliverer.changed(ID);

    should(world.handed).eql(['a']);
    should(world.queue.map(entry => entry.waitReason)).eql(['busy', 'busy']);

    // A prompt shows: the queue goes at once, both in order.
    world.pane = pane({ activeWork: false, promptReady: true });
    await world.deliverer.changed(ID);

    should(world.handed).eql(['a', 'a', 'b']);
    should(world.queue.map(entry => entry.state)).eql(['delivered', 'delivered']);
  });

  it('should keep waiting when the record still says ready for a pane that showed no prompt (stale flag)', async () => {
    // The record's readiness flag was already true when the pane was refused for having no prompt: still
    // true on the next look is the very reading that was refused, so the backoff must hold, not end.
    const world = new World(message('a', 'human'));
    world.target = { ...world.target, promptReady: true };
    world.pane = pane({ activeWork: false });
    world.answers.push({ kind: 'refused', reason: 'busy', untilPrompt: true });

    await world.deliverer.enqueued(ID);
    for (let look = 0; look < 3; look += 1) {
      world.nowMs += defaultQueueDeliverySettings.lookMs;
      await world.deliverer.changed(ID);
    }

    should(world.handed).eql(['a']);
    should(world.state('a')?.waitReason).equal('busy');

    // The flag falling and rising again is a real readiness change after the refusal: the queue goes.
    world.target = { ...world.target, promptReady: false };
    await world.deliverer.changed(ID);
    should(world.handed).eql(['a']);
    world.target = { ...world.target, promptReady: true };
    await world.deliverer.changed(ID);

    should(world.handed).eql(['a', 'a']);
    should(world.state('a')?.state).equal('delivered');
  });

  it('should go at once when the record turns ready after a refusal made while it was not', async () => {
    const world = new World(message('a', 'human'));
    world.pane = pane({ activeWork: false });
    world.answers.push({ kind: 'refused', reason: 'busy', untilPrompt: true });

    await world.deliverer.enqueued(ID);
    world.nowMs += defaultQueueDeliverySettings.lookMs;
    await world.deliverer.changed(ID);
    should(world.handed).eql(['a']);

    world.target = { ...world.target, promptReady: true };
    await world.deliverer.changed(ID);

    should(world.handed).eql(['a', 'a']);
  });

  it('should try a promptless pane again once `recheckMs` has passed, in case its prompt is not recognised', async () => {
    const world = new World(message('a', 'human'));
    world.pane = pane({ activeWork: false });
    world.answers.push({ kind: 'refused', reason: 'dialog', untilPrompt: true });

    await world.deliverer.enqueued(ID);
    world.nowMs += defaultQueueDeliverySettings.recheckMs - 1;
    await world.deliverer.changed(ID);
    should(world.handed).eql(['a']);
    should(world.state('a')?.waitReason).equal('dialog');

    world.nowMs += 1;
    await world.deliverer.changed(ID);

    should(world.handed).eql(['a', 'a']);
    should(world.state('a')?.state).equal('delivered');
  });

  it('should hand over again at once after a refusal that is not about a missing prompt', async () => {
    const world = new World(message('a', 'human'));
    world.answers.push({ kind: 'refused', reason: 'unreadable' });

    await world.deliverer.enqueued(ID);
    await world.deliverer.changed(ID);

    should(world.handed).eql(['a', 'a']);
  });

  it('should start no tracker look once the daemon is stopping', async () => {
    const world = new World(message('a', 'human'));
    world.answers.push(new Error('tmux went away'));
    world.fates.set('a', 'accepted');
    await world.deliverer.enqueued(ID);
    world.nowMs += defaultQueueDeliverySettings.recheckMs;
    // The stop lands mid-look, between reading the ledger and asking the tracker.
    world.onFate = () => void world.deliverer.stop();

    await world.deliverer.look(ID);

    should(world.rechecks).equal(0);
  });

  it('should not ask the tracker about a hand-over still being proven, or one the ledger already settled', async () => {
    const world = new World(message('a', 'human'));
    world.answers.push({ kind: 'unproven' });
    world.fates.set('a', 'accepted');

    await world.deliverer.enqueued(ID);
    world.fates.set('a', 'unaccounted');
    world.nowMs += defaultQueueDeliverySettings.recheckMs;
    await world.deliverer.changed(ID);

    should(world.state('a')?.state).equal('unconfirmed');
    should(world.rechecks).equal(0);
  });

  it('should leave a hand-over that threw to the ledger when the ledger has it, and fail it when it does not', async () => {
    const recorded = new World(message('a', 'human'));
    recorded.answers.push(new Error('tmux went away'));
    recorded.fates.set('a', 'accepted');
    const absent = new World(message('a', 'human'));
    absent.answers.push(new Error('tmux went away'));

    await recorded.deliverer.enqueued(ID);
    await absent.deliverer.enqueued(ID);

    should(recorded.state('a')?.state).equal('typing');
    should(absent.state('a')).containEql({ state: 'failed', failure: 'tmux went away' });
  });

  it('should not hold the next message behind an unconfirmed one, and still watch it for proof', async () => {
    const world = new World(message('a', 'human'), message('b', 'human', 1));
    world.answers.push({ kind: 'unproven' });
    await world.deliverer.enqueued(ID);
    world.fates.set('a', 'unaccounted');

    await world.deliverer.changed(ID);
    should(world.state('a')?.state).equal('unconfirmed');
    should(world.handed).eql(['a', 'b']);

    world.fates.set('a', 'delivered');
    await world.deliverer.changed(ID);
    should(world.state('a')?.state).equal('read');
  });

  it('should read the read tick from the ledger, and stop looking once nothing can move', async () => {
    const world = new World(message('a', 'human'));
    await world.deliverer.enqueued(ID);
    const looks = world.scheduled.length;

    world.fates.set('a', 'delivered');
    await world.deliverer.changed(ID);
    await world.deliverer.changed(ID);

    should(world.state('a')?.state).equal('read');
    // Read is final: the look that saw it schedules nothing, and the change after it is not looked at.
    should(world.scheduled.length).equal(looks);
  });

  it('should stop watching a delivered message for its read tick after the watch window', async () => {
    const world = new World(message('a', 'human'));
    await world.deliverer.enqueued(ID);

    world.nowMs = T0 + defaultQueueDeliverySettings.readWatchMs;
    const before = world.scheduled.length;
    await world.deliverer.look(ID);

    should(world.scheduled.length).equal(before);
    should(world.state('a')?.state).equal('delivered');
  });

  it('should hand over no more than one look allows, and look again for the rest', async () => {
    const messages = Array.from({ length: defaultQueueDeliverySettings.perLook + 2 }, (_, index) =>
      message(`m${index}`, 'human', index),
    );
    const world = new World(...messages);

    await world.deliverer.enqueued(ID);

    should(world.handed).have.length(defaultQueueDeliverySettings.perLook);
    should(world.scheduled).have.length(1);
  });

  it('should deliver to a Codex session mid-turn, holding the rest until its transcript proves the first', async () => {
    // Codex steers text typed mid-turn into the running turn and shows no queue: the pane proves nothing.
    const world = new World(message('a', 'human'), message('b', 'agent', 1));
    world.target = { ...world.target, harness: 'codex' };
    world.answers.push({ kind: 'unproven' });

    await world.deliverer.enqueued(ID);
    should(world.handed).eql(['a']);
    should(world.state('b')?.state).equal('queued');

    world.fates.set('a', 'delivered');
    await world.deliverer.changed(ID);

    should(world.state('a')?.state).equal('read');
    should(world.handed).eql(['a', 'b']);
  });

  it('should leave a daemon notice to the owner’s chat alone', async () => {
    const chat = new World(message('warden', 'daemon'));
    chat.target = { ...chat.target, mode: 'interactive' };

    await chat.deliverer.enqueued(ID);

    should(chat.handed).be.empty();
    should(chat.scheduled).be.empty();
  });

  it('should ignore a change to a session with nothing open, and pick up what a restart left', async () => {
    const world = new World(message('a', 'human'));

    await world.deliverer.changed(ID);
    should(world.handed).be.empty();

    await world.deliverer.arm();
    should(world.handed).eql(['a']);
  });

  it('should finish a hand-over in flight when the daemon stops, and start nothing after', async () => {
    // A send answers once its message is on disk; a daemon stopped a moment later cut the typing in half.
    const world = new World(message('a', 'human'), message('b', 'human', 1));
    let release = (): void => undefined;
    world.hold = new Promise(resolve => {
      release = resolve;
    });
    world.sleepForever = true;
    void world.deliverer.enqueued(ID);
    await Promise.resolve();

    const stopping = world.deliverer.stop();
    release();
    await stopping;
    // The stop returned only once the hand-over in flight had finished.
    should(world.state('a')?.state).equal('delivered');
    await world.deliverer.changed(ID);
    await world.deliverer.look(ID);

    should(world.state('a')?.state).equal('delivered');
    should(world.handed).eql(['a', 'b']);
    should(world.slept).eql([defaultQueueDeliverySettings.drainMs]);
  });

  it('should stop at once when nothing is in flight', async () => {
    const world = new World(message('a', 'human'));

    await world.deliverer.stop();
    await world.deliverer.enqueued(ID);

    should(world.handed).be.empty();
    should(world.slept).be.empty();
  });

  it('should keep going when one session cannot be looked at during the restart look', async () => {
    const world = new World(message('a', 'human'));
    world.answers.push({ kind: 'landed' });
    const failing = new QueueDeliverer({
      store: { read: async () => Promise.reject(new Error('disk')), append: async () => undefined },
      serial: { run: async (_key, work) => await work(), runExclusive: async work => await work() },
      clock: { now: () => new Date(T0).toISOString() as Instant },
      scheduler: { schedule: () => undefined, cancelAll: () => undefined },
      view: async () => ({ target: world.target, pane: pane(), launching: false }),
      transport: {
        handOver: async () => ({ kind: 'landed' }),
        fate: async () => undefined,
        clearOwnDraft: async () => ({ kind: 'foreign' }),
        recheck: async () => undefined,
      },
      sessions: () => [ID],
      sleep: async () => undefined,
    });

    await failing.arm();
  });
});

describe('when a message may go', () => {
  const view = (overrides: Partial<DeliveryView> = {}): DeliveryView => ({
    target: { id: ID, status: 'running', mode: 'auto', turn: 1 },
    pane: pane(),
    launching: false,
    ...overrides,
  });

  it('should be ready mid-turn with an empty box, and for a stopped session the send path revives', () => {
    should(reasonForWaiting(view())).be.undefined();
    should(reasonForWaiting(view({ pane: pane({ alive: false }) }))).be.undefined();
    should(reasonForWaiting(view({ pane: pane({ dead: true, blockingPrompt: 'x' }) }))).be.undefined();
    should(reasonForWaiting(view({ pane: pane({ draft: '   ' }) }))).be.undefined();
  });

  it('should wait as launching while Codex holds a submission until its startup ends', () => {
    should(reasonForWaiting(view({ pane: pane({ startupParked: true, draft: 'say hello' }) }))).equal('launching');
    should(reasonForWaiting(view({ pane: pane({ startupParked: true, blockingPrompt: 'x' }) }))).equal('dialog');
  });
});

describe('settling a hand-over from the send ledger', () => {
  const typing = { ...message('a', 'human'), state: 'typing' as const };
  const delivered = { ...message('a', 'human'), state: 'delivered' as const };

  it('should wait again when no key was typed, and stay put while the send is in flight', () => {
    should(movesFrom(typing, undefined)).eql([{ state: 'queued' }]);
    should(movesFrom(typing, 'withdrawn')).eql([{ state: 'queued' }]);
    should(movesFrom(typing, 'accepted')).eql([]);
  });

  it('should tick delivered and read as the ledger proves them', () => {
    should(movesFrom(typing, 'queued')).eql([{ state: 'delivered' }]);
    should(movesFrom(typing, 'delivered')).eql([{ state: 'delivered' }, { state: 'read' }]);
    should(movesFrom(delivered, 'delivered')).eql([{ state: 'read' }]);
    should(movesFrom(delivered, 'unaccounted')).eql([]);
    should(movesFrom(message('a', 'human'), 'delivered')).eql([]);
  });

  it('should fail what the ledger proved absent, and call one that may have landed unconfirmed, never failed', () => {
    // The owner read "✗ failed, may have reached" for a message the agent had (2026-10-30).
    should(movesFrom(typing, 'timed_out')[0]?.failure).equal('it never reached the agent');
    should(movesFrom(typing, 'unaccounted')).eql([{ state: 'unconfirmed' }]);
    should(movesFrom(typing, 'cancelled')[0]?.failure).equal('its send was cancelled');
  });

  it('should move an unconfirmed message on when proof turns up later', () => {
    const unconfirmed = { ...message('a', 'human'), state: 'unconfirmed' as const };
    should(movesFrom(unconfirmed, 'delivered')).eql([{ state: 'read' }]);
    should(movesFrom(unconfirmed, 'queued')).eql([{ state: 'delivered' }]);
    should(movesFrom(unconfirmed, 'unaccounted')).eql([]);
  });
});

describe('labels and combined delivery', () => {
  const action = (id: string, seconds: number, extra: Partial<QueuedMessage> = {}): QueuedMessage =>
    message(id, 'agent', seconds, {
      label: 'action',
      holdUntil: new Date(T0 + (seconds + 60) * 1_000).toISOString() as Instant,
      ...extra,
    });
  const fyi = (id: string, seconds: number, extra: Partial<QueuedMessage> = {}): QueuedMessage =>
    message(id, 'agent', seconds, {
      label: 'fyi',
      holdUntil: new Date(T0 + (seconds + 600) * 1_000).toISOString() as Instant,
      ...extra,
    });

  it('should hold an action for its window, look again exactly when it ends, then deliver it alone', async () => {
    const world = new World(action('a', 0));

    await world.deliverer.enqueued(ID);

    should(world.handed).be.empty();
    should(world.state('a')).containEql({ state: 'queued' });
    should(world.state('a')).not.have.property('waitReason');
    should(world.scheduled.at(-1)).equal(60_000);

    world.nowMs = T0 + 60_000;
    await world.deliverer.look(ID);

    should(world.handed).eql(['a']);
    should(world.deliveries[0]?.delivery.members.map(entry => entry.id)).eql(['a']);
    should(world.state('a')?.state).equal('delivered');
    should(world.state('a')).not.have.property('deliveredAs');
  });

  it('should combine every ferret message that arrives inside the window into ONE turn, oldest first', async () => {
    const world = new World(action('a', 0), fyi('f', 20), action('b', 59));
    world.nowMs = T0 + 60_000;

    await world.deliverer.look(ID);

    should(world.handed).eql(['a']);
    should(world.deliveries[0]?.delivery.members.map(entry => entry.id)).eql(['a', 'f', 'b']);
    should(world.queue.map(entry => [entry.state, entry.deliveredAs])).eql([
      ['delivered', 'a'],
      ['delivered', 'a'],
      ['delivered', 'a'],
    ]);
  });

  it('should have every member typing under the delivery id BEFORE anything is handed over', async () => {
    const world = new World(action('a', 0), action('b', 5));
    world.nowMs = T0 + 60_000;

    await world.deliverer.look(ID);

    should(world.deliveries[0]?.during.map(entry => [entry.state, entry.deliveredAs])).eql([
      ['typing', 'a'],
      ['typing', 'a'],
    ]);
  });

  it('should start a new window for what arrives after the first batch left', async () => {
    const world = new World(action('a', 0));
    world.nowMs = T0 + 60_000;
    await world.deliverer.look(ID);
    should(world.handed).eql(['a']);

    const late = action('late', 61);
    world.log.push({ v: 1, kind: 'enqueued', at: late.enqueuedAt, message: late });
    world.nowMs = T0 + 61_000;
    await world.deliverer.enqueued(ID);

    should(world.handed).eql(['a']);
    should(world.state('late')?.state).equal('queued');

    world.nowMs = T0 + 121_000;
    await world.deliverer.look(ID);
    should(world.handed).eql(['a', 'late']);
    should(world.deliveries[1]?.delivery.members.map(entry => entry.id)).eql(['late']);
  });

  it('should deliver a blocker at once, carrying the actions and FYIs already waiting', async () => {
    const world = new World(action('a', 0), fyi('f', 1), message('b', 'agent', 2, { label: 'blocker' }));
    world.nowMs = T0 + 2_000;

    await world.deliverer.look(ID);

    should(world.deliveries.map(entry => entry.delivery.members.map(member => member.id))).eql([['a', 'f', 'b']]);
  });

  it("should never hold the owner's message or the daemon's behind a held ferret message", async () => {
    const world = new World(action('a', 0), message('warden', 'daemon', 1), message('owner', 'human', 2));

    await world.deliverer.look(ID);

    should(world.handed).eql(['owner', 'warden']);
    should(world.state('a')?.state).equal('queued');
  });

  it('should let a due ferret message go before a daemon notice, as it always did', async () => {
    const world = new World(message('warden', 'daemon', 0), action('a', 1));
    world.nowMs = T0 + 61_000;

    await world.deliverer.look(ID);

    should(world.handed).eql(['a', 'warden']);
  });

  it('should hold an FYI past a turn that ended before it arrived, and deliver it at the next turn end', async () => {
    const world = new World(fyi('f', 10));
    world.target = {
      ...world.target,
      turnState: 'your-turn',
      turnStateAt: new Date(T0 + 5_000).toISOString() as Instant,
    };
    world.nowMs = T0 + 20_000;
    await world.deliverer.look(ID);
    should(world.handed).be.empty();

    world.target = {
      ...world.target,
      turnState: 'working',
      turnStateAt: new Date(T0 + 30_000).toISOString() as Instant,
    };
    await world.deliverer.changed(ID);
    should(world.handed).be.empty();

    world.nowMs = T0 + 90_000;
    world.target = {
      ...world.target,
      turnState: 'your-turn',
      turnStateAt: new Date(T0 + 90_000).toISOString() as Instant,
    };
    await world.deliverer.changed(ID);

    should(world.handed).eql(['f']);
  });

  it('should deliver an FYI at its cap even when no turn ends', async () => {
    const world = new World(fyi('f', 0));
    await world.deliverer.enqueued(ID);
    should(world.scheduled.at(-1)).equal(600_000);

    world.nowMs = T0 + 600_000;
    await world.deliverer.look(ID);

    should(world.handed).eql(['f']);
  });

  it('should deliver a question at once, however it is labelled, and a reply the sender is waited on for', async () => {
    const question = new World(
      fyi('q', 0, { replyExpected: true, holdUntil: new Date(T0 + 60_000).toISOString() as Instant }),
    );
    await question.deliverer.enqueued(ID);
    should(question.handed).eql(['q']);

    const reply = new World(action('r', 0, { from: 'peer-session' }));
    reply.target = { ...reply.target, waiting: { peer: 'peer-session' } };
    await reply.deliverer.enqueued(ID);
    should(reply.handed).eql(['r']);
  });

  it('should keep an FYI-only delivery from reviving a stopped session, saying why', async () => {
    const world = new World(fyi('f', 0));
    world.target = { ...world.target, status: 'stopped' };
    world.nowMs = T0 + 600_000;

    await world.deliverer.look(ID);

    should(world.handed).be.empty();
    should(world.state('f')).containEql({ state: 'queued', waitReason: 'stopped' });
  });

  it('should split a long wait at the batch limit and deliver the rest under the normal rules', async () => {
    const world = new World(...Array.from({ length: 5 }, (_, index) => action(`m${index}`, index)));
    Object.assign(world.settings, { batchMax: 2 });
    world.nowMs = T0 + 70_000;

    await world.deliverer.look(ID);

    should(world.deliveries.map(entry => entry.delivery.members.map(member => member.id))).eql([
      ['m0', 'm1'],
      ['m2', 'm3'],
      ['m4'],
    ]);
  });

  it('should treat every label as a blocker, one turn each, when coalescing is switched off', async () => {
    const off = new World(action('a', 0), fyi('f', 1), action('b', 2));
    Object.assign(off.settings, { coalesce: false });

    await off.deliverer.look(ID);

    should(off.deliveries.map(entry => entry.delivery.members.map(member => member.id))).eql([['a'], ['f'], ['b']]);
  });

  it('should apply a refusal to every member, leaving none half-batched', async () => {
    const world = new World(action('a', 0), action('b', 1));
    world.nowMs = T0 + 61_000;
    world.answers.push({ kind: 'refused', reason: 'draft' });

    await world.deliverer.look(ID);

    should(world.queue.map(entry => [entry.state, entry.waitReason])).eql([
      ['queued', 'draft'],
      ['queued', 'draft'],
    ]);
    should(world.queue.every(entry => entry.deliveredAs === undefined)).equal(true);
  });

  it('should fail every member when the send path refused the turn for good', async () => {
    const world = new World(action('a', 0), action('b', 1));
    world.nowMs = T0 + 61_000;
    world.answers.push({ kind: 'failed', failure: 'nope' });

    await world.deliverer.look(ID);

    should(world.queue.map(entry => entry.state)).eql(['failed', 'failed']);
  });

  it('should settle every member from the ONE ledger record under the lead id', async () => {
    const world = new World(action('a', 0), action('b', 1));
    world.nowMs = T0 + 61_000;
    world.answers.push({ kind: 'unproven' });
    await world.deliverer.look(ID);
    should(world.queue.map(entry => entry.state)).eql(['typing', 'typing']);

    world.fates.set('a', 'delivered');
    await world.deliverer.look(ID);

    should(world.queue.map(entry => entry.state)).eql(['read', 'read']);
  });

  it('should put every member back when a crash left them typing with no ledger record, and type nothing twice', async () => {
    const world = new World(action('a', 0), action('b', 1));
    world.log.push(
      { v: 1, kind: 'moved', at: new Date(T0).toISOString() as Instant, id: 'a', state: 'typing', batch: 'a' },
      { v: 1, kind: 'moved', at: new Date(T0).toISOString() as Instant, id: 'b', state: 'typing', batch: 'a' },
    );

    await world.deliverer.arm();

    should(world.queue.map(entry => [entry.state, entry.deliveredAs])).eql([
      ['queued', undefined],
      ['queued', undefined],
    ]);
    should(world.handed).be.empty();
  });

  it('should deliver what a restart finds overdue', async () => {
    const world = new World(action('a', 0), fyi('f', 1));
    world.nowMs = T0 + 700_000;

    await world.deliverer.arm();

    should(world.deliveries.map(entry => entry.delivery.members.map(member => member.id))).eql([['a', 'f']]);
  });
});
