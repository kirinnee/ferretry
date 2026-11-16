import { describe, it } from 'bun:test';
import { fixedClock } from '@ferretry/kernel/testing';
import should from 'should';
import { CancellableTimers } from '../../../daemon/adapters/cancellable-timers.ts';
import { ClockSendScheduler } from '../../../daemon/adapters/clock-send-scheduler.ts';
import {
  type QueuedSend,
  SendPathDeliveryView,
  SendPathQueueTransport,
} from '../../../daemon/adapters/send-path-delivery.ts';
import { QueueDeliverer } from '../../../daemon/lib/queue/deliverer.ts';
import { QueueingSends } from '../../../daemon/lib/queue/queueing-sends.ts';
import { SessionQueueService } from '../../../daemon/lib/queue/service.ts';
import {
  foldQueue,
  KeyedSerialExecutor,
  type LedgerFate,
  type LedgerRecord,
  parseSessionId,
  type QueueEvent,
  type QueuedMessage,
  type SendResult,
  type SessionQueueStore,
} from '../../../contract/index.ts';

/**
 * THE MAILBOX IS ON: an owner's send is written to the queue and typed by the deliverer, and a daemon that dies at any
 * point of that never types a message twice. The queue log and the send ledger are what survives a "kill" (they are
 * on disk in a daemon); everything else (the deliverer, its timers, the lock) is built again over them. The pane and
 * the typing are fakes: nothing here reaches tmux.
 */

const ID = parseSessionId('session-1');
const START = '2026-11-16T09:00:00.000Z';

/** What outlives a daemon: the queue's log, the ledger, and every key that ever reached the pane. */
class Disk {
  readonly log: QueueEvent[] = [];
  readonly ledger = new Map<string, LedgerFate>();
  readonly keys: string[] = [];
  /** When each message was typed, by the instant the daemon that typed it was on. */
  readonly typedAt: number[] = [];
  readonly store: SessionQueueStore = {
    messages: async () => foldQueue(this.log),
    append: async (_id, event) => void this.log.push(event),
  };

  state(messageId: string): string | undefined {
    return foldQueue(this.log).find(message => message.id === messageId)?.state;
  }
}

/** Where a daemon dies: nowhere, or at one of the three points between "marked typing" and "the answer". */
type Death = 'none' | 'before-ledger' | 'before-key' | 'after-key';

class Daemon {
  readonly clock = fixedClock(START);
  readonly typings: { readonly request: QueuedSend; readonly queueState: string | undefined; readonly at: number }[] =
    [];
  readonly timers = new CancellableTimers(this.clock);
  readonly deliverer: QueueDeliverer;
  readonly sends: QueueingSends;

  constructor(disk: Disk, death: Death = 'none', from?: number) {
    if (from !== undefined) void this.clock.advance(from - this.clock.nowMs());
    const queue = new SessionQueueService({
      store: disk.store,
      clock: { now: () => this.clock.now() },
      serial: new KeyedSerialExecutor(),
    });
    const never = async (): Promise<never> => await new Promise<never>(() => undefined);
    this.deliverer = new QueueDeliverer({
      store: disk.store,
      serial: new KeyedSerialExecutor(),
      clock: { now: () => this.clock.now() },
      scheduler: new ClockSendScheduler(this.clock),
      view: async id =>
        await new SendPathDeliveryView(
          { read: async () => ({ id, status: 'running', mode: 'auto', turn: 0 }) },
          { observe: async () => ({ alive: true, dead: false, promptReady: true, activeWork: false }) },
          { launching: () => false },
        ).view(id),
      transport: new SendPathQueueTransport(
        {
          // The typing send, as `typeMessage` does it: the row is accepted BEFORE a key goes, and the key follows.
          type: async (_id, request): Promise<SendResult> => {
            this.typings.push({ request, queueState: disk.state(request.sendId), at: this.clock.nowMs() });
            if (death === 'before-ledger') return await never();
            disk.ledger.set(request.sendId, 'accepted');
            if (death === 'before-key') return await never();
            disk.keys.push(request.message);
            disk.typedAt.push(this.clock.nowMs());
            if (death === 'after-key') return await never();
            return { ferret: ID, disposition: 'sent', sendId: request.sendId, fate: 'accepted' };
          },
          finishOwnDraft: async () => ({ kind: 'clear' as const }),
        },
        { list: async () => [...disk.ledger].map(([sendId, fate]) => ({ sendId, fate }) as LedgerRecord) },
        { check: async () => undefined },
      ),
      sessions: () => [ID],
      sleep: async milliseconds => await this.timers.after(milliseconds).done,
    });
    this.sends = new QueueingSends(
      {
        queue,
        deliverer: this.deliverer,
        direct: { send: async () => ({ ferret: ID, disposition: 'sent' }), authorize: async () => undefined },
        target: async () => ({ mode: 'auto' }),
        timer: milliseconds => this.timers.after(milliseconds),
      },
      'human',
    );
  }

  /** The owner's own send, which a dead daemon never answers. */
  send(sendId: string, message: string): Promise<SendResult | undefined> {
    return this.sends.send({ id: ID, sendId, message });
  }
}

/** Lets every promise chain that can finish, finish. */
const settle = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

describe('every send goes into the queue and is typed by the deliverer', () => {
  it('should write the message to disk, mark it typing BEFORE it is handed over, and key the ledger by the same id (R1)', async () => {
    const disk = new Disk();
    const daemon = new Daemon(disk);

    await daemon.send('q-1', 'ship it');

    // The deliverer had moved it to `typing` on disk when the typing send was called, under its own id.
    should(daemon.typings.map(typing => [typing.request.sendId, typing.queueState])).eql([['q-1', 'typing']]);
    should([...disk.ledger]).eql([['q-1', 'accepted']]);
    should(disk.keys).eql(['ship it']);
    should(disk.state('q-1')).equal('delivered');
  });

  it('should answer the owner’s send without waiting for a periodic look: it is typed on the same instant (R2)', async () => {
    const disk = new Disk();
    const daemon = new Daemon(disk);
    const sentAt = daemon.clock.nowMs();

    const sending = daemon.send('q-1', 'ship it');
    await settle();

    // No clock was advanced: nothing waited on the five-second look, and no look was scheduled to be waited for.
    should(daemon.clock.nowMs()).equal(sentAt);
    should(disk.typedAt).eql([sentAt]);
    should(daemon.typings).have.length(1);
    await sending;
    // The answer's own wait for the first look is given up, not left running.
    should(daemon.timers.pending()).equal(0);
  });

  it('should hold an owner’s message behind the one in flight, and type it the moment the first is proven', async () => {
    const disk = new Disk();
    const daemon = new Daemon(disk);

    await daemon.send('q-1', 'first');
    disk.ledger.set('q-1', 'accepted');
    // The first is typed and not yet proven by the transcript: the second waits, one thing in flight per ferret.
    disk.log.splice(
      0,
      disk.log.length,
      ...disk.log.filter(event => !(event.kind === 'moved' && event.state === 'delivered')),
    );
    await daemon.send('q-2', 'second');
    should(disk.keys).eql(['first']);

    disk.ledger.set('q-1', 'delivered');
    await daemon.deliverer.look(ID);
    should(disk.keys).eql(['first', 'second']);
  });
});

describe('a daemon killed anywhere in a hand-over never types a message twice (R1)', () => {
  it('should deliver once after a restart when it died between "marked typing" and the ledger', async () => {
    const disk = new Disk();
    const first = new Daemon(disk, 'before-ledger');

    void first.send('q-1', 'ship it');
    await settle();
    should(disk.state('q-1')).equal('typing');
    should(disk.keys).eql([]);

    // The daemon is gone; a new one is built over the same log and ledger and armed at boot.
    const second = new Daemon(disk, 'none', first.clock.nowMs());
    await second.deliverer.arm();

    should(disk.keys).eql(['ship it']);
    should(disk.state('q-1')).equal('delivered');
    await second.deliverer.stop();
    await second.deliverer.arm();
    should(disk.keys).eql(['ship it']);
  });

  it('should settle from the ledger, and type nothing, when it died between the key and the answer', async () => {
    const disk = new Disk();
    const first = new Daemon(disk, 'after-key');

    void first.send('q-1', 'ship it');
    await settle();
    should(disk.keys).eql(['ship it']);
    should(disk.state('q-1')).equal('typing');

    const second = new Daemon(disk, 'none', first.clock.nowMs());
    await second.deliverer.arm();
    // The ledger says a key went, and nothing proves where: it is not typed again.
    should(disk.keys).eql(['ship it']);
    should(disk.state('q-1')).equal('typing');

    // The transcript proves it (the send tracker's work): the message settles from the ledger, never from a guess.
    disk.ledger.set('q-1', 'delivered');
    await second.deliverer.look(ID);
    should(disk.keys).eql(['ship it']);
    should(disk.state('q-1')).equal('read');
  });

  it('should leave a hand-over that died after the ledger and before the key to the tracker, never retyped by the queue', async () => {
    const disk = new Disk();
    const first = new Daemon(disk, 'before-key');

    void first.send('q-1', 'ship it');
    await settle();

    const second = new Daemon(disk, 'none', first.clock.nowMs());
    await second.deliverer.arm();

    // A row `accepted` is the tracker's to prove absent and type once; the queue never types over it.
    should(disk.keys).eql([]);
    should(disk.state('q-1')).equal('typing');
  });
});

describe('nothing accepted is lost (the queue is on disk before the sender is answered)', () => {
  it('should deliver at boot a message accepted before the daemon stopped', async () => {
    const disk = new Disk();
    const first = new Daemon(disk);
    // Accepted and on disk, then the daemon stops before any look is taken.
    await new SessionQueueService({
      store: disk.store,
      clock: { now: () => first.clock.now() },
      serial: new KeyedSerialExecutor(),
    }).enqueue(ID, { id: 'q-1', sender: 'human', text: 'before the crash', attachmentIds: [] });
    should(disk.state('q-1')).equal('queued');

    const second = new Daemon(disk, 'none', first.clock.nowMs());
    await second.deliverer.arm();

    should(disk.keys).eql(['before the crash']);
    should(disk.state('q-1')).equal('delivered');
  });
});

describe('arming, telling and stopping', () => {
  it('should look again for what waits, and leave no timer once it is stopped', async () => {
    const disk = new Disk();
    const daemon = new Daemon(disk);
    // A message the box refuses to take: it waits, and the deliverer asks to be woken to look again.
    await new SessionQueueService({
      store: disk.store,
      clock: { now: () => daemon.clock.now() },
      serial: new KeyedSerialExecutor(),
    }).enqueue(ID, { id: 'q-1', sender: 'human', text: 'waits', attachmentIds: [] });
    disk.log.push({ v: 1, kind: 'waiting', at: daemon.clock.now(), id: 'q-1', reason: 'draft' });
    await daemon.deliverer.arm();
    // Typed at the look the boot took: nothing was in the way of this fake pane.
    should(disk.keys).eql(['waits']);

    // A message held to combine with others has a look scheduled for the moment its hold ends.
    await new SessionQueueService({
      store: disk.store,
      clock: { now: () => daemon.clock.now() },
      serial: new KeyedSerialExecutor(),
    }).enqueue(ID, {
      id: 'q-2',
      sender: 'agent',
      from: 'session-2',
      label: 'action',
      text: 'batch me',
      attachmentIds: [],
    });
    await daemon.deliverer.look(ID);
    should(daemon.clock.pending()).be.above(0);

    await daemon.deliverer.stop();
    should(daemon.clock.pending()).equal(0);
    // Stopped: a look that is asked for later starts nothing.
    await daemon.deliverer.look(ID);
    should(disk.keys).eql(['waits']);
    should(foldQueue(disk.log).map((message: QueuedMessage) => message.id)).eql(['q-1', 'q-2']);
    should(daemon.timers.pending()).equal(0);
  });
});
