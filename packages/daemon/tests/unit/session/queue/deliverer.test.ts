import { describe, it } from 'bun:test';
import type { QueuedMessage } from '@ferretry/protocol';
import should from 'should';
import {
  type DeliveryView,
  defaultQueueDeliverySettings,
  foldQueue,
  type HandOver,
  movesFrom,
  QueueDeliverer,
  type QueueEvent,
  type SendFate,
  type SendPaneObservation,
  type SendTarget,
  waitReasonOf,
} from '../../../../src/lib/index.ts';
import { parseSessionId, type SessionId } from '../../../../src/lib/session-id.ts';

const ID = parseSessionId('session-1');
const T0 = Date.UTC(2026, 9, 30, 13, 5, 0);

function message(id: string, sender: QueuedMessage['sender'], seconds = 0): QueuedMessage {
  const at = new Date(T0 + seconds * 1_000).toISOString();
  return {
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
  readonly scheduled: number[] = [];
  readonly fates = new Map<string, SendFate>();
  target: SendTarget = { id: ID, status: 'running', mode: 'auto', turn: 4, harness: 'claude' };
  pane: SendPaneObservation | 'unreadable' = pane();
  launching = false;
  /** What each hand-over answers, in order; then `landed`. */
  readonly answers: Array<HandOver | Error> = [];
  nowMs = T0;
  readonly deliverer: QueueDeliverer;

  constructor(...messages: QueuedMessage[]) {
    for (const entry of messages) this.log.push({ v: 1, kind: 'enqueued', at: entry.enqueuedAt, message: entry });
    this.deliverer = new QueueDeliverer({
      store: {
        read: async () => [...this.log],
        append: async (_id, event) => void this.log.push(event),
      },
      serial: { run: async (_key, work) => await work(), runExclusive: async work => await work() },
      clock: { now: () => new Date(this.nowMs).toISOString() },
      scheduler: { schedule: (_id, delayMs) => void this.scheduled.push(delayMs), cancelAll: () => undefined },
      view: async (): Promise<DeliveryView> => {
        if (this.pane === 'unreadable') throw new Error('capture failed');
        return { target: this.target, pane: this.pane, launching: this.launching };
      },
      transport: {
        handOver: async (_id: SessionId, entry: QueuedMessage) => {
          this.handed.push(entry.id);
          const answer = this.answers.shift() ?? { kind: 'landed' };
          if (answer instanceof Error) throw answer;
          return answer;
        },
        fate: async (_id: SessionId, messageId: string) => this.fates.get(messageId),
      },
      sessions: () => [ID],
    });
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
      message(`m${index}`, 'agent', index),
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

    const disarm = await world.deliverer.arm();
    disarm();
    should(world.handed).eql(['a']);
  });

  it('should keep going when one session cannot be looked at during the restart look', async () => {
    const world = new World(message('a', 'human'));
    world.answers.push({ kind: 'landed' });
    const failing = new QueueDeliverer({
      store: { read: async () => Promise.reject(new Error('disk')), append: async () => undefined },
      serial: { run: async (_key, work) => await work(), runExclusive: async work => await work() },
      clock: { now: () => new Date(T0).toISOString() },
      scheduler: { schedule: () => undefined, cancelAll: () => undefined },
      view: async () => ({ target: world.target, pane: pane(), launching: false }),
      transport: { handOver: async () => ({ kind: 'landed' }), fate: async () => undefined },
      sessions: () => [ID],
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
    should(waitReasonOf(view())).be.undefined();
    should(waitReasonOf(view({ pane: pane({ alive: false }) }))).be.undefined();
    should(waitReasonOf(view({ pane: pane({ dead: true, blockingPrompt: 'x' }) }))).be.undefined();
    should(waitReasonOf(view({ pane: pane({ draft: '   ' }) }))).be.undefined();
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

  it('should fail what the ledger could not deliver, saying when it may still have landed', () => {
    should(movesFrom(typing, 'timed_out')[0]?.failure).equal('it never reached the agent');
    should(movesFrom(typing, 'unaccounted')[0]?.failure).match(/may have/u);
    should(movesFrom(typing, 'cancelled')[0]?.failure).equal('its send was cancelled');
  });
});
