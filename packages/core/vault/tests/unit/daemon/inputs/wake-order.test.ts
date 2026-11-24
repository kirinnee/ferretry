import { describe, it } from 'bun:test';
import should from 'should';
import type { AgendaId } from '../../../../daemon/lib/inputs/wire.ts';
import { padInputValue } from '../../../../daemon/lib/inputs/wire.ts';
import type { InputCaller } from '../../../../daemon/lib/inputs/ports.ts';
import { RAISE, SESSION, inputRequestService } from './support.ts';

const OWNER: InputCaller = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' };

/** A fake clock for slow follow-up work: a write "takes" `ms` of fake time, and only the test moves time on. */
function fakeTime() {
  const waits: { at: number; done: () => void }[] = [];
  const clock = { now: 0 };
  return {
    clock,
    /** A write that takes `ms` of fake time. */
    takes: async (ms: number) => await new Promise<void>(resolve => waits.push({ at: clock.now + ms, done: resolve })),
    /** Move fake time on, finishing every write that is due. */
    advance: (ms: number) => {
      clock.now += ms;
      for (const wait of waits.filter(each => each.at <= clock.now)) wait.done();
    },
  };
}

const settle = async () => {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
};

describe('a ferret waiting with input_wait when the owner answers', () => {
  it('should be woken in the turn the value is typed, while a 200 ms agenda close, audit and notice are still running', async () => {
    const time = fakeTime();
    const journalled: string[] = [];
    const closed: string[] = [];
    const told: string[] = [];
    const world = inputRequestService({
      agenda: {
        raise: async () => ({ ok: true, id: 'A1' as AgendaId }),
        close: async (_session, _id, note) => {
          await time.takes(200);
          closed.push(note);
        },
        promptOf: async () => 'sudo wants your password',
      },
      notifier: { tell: async (_session, _id, message) => void told.push(message) },
      journalled: event => void journalled.push((event as { type: string }).type),
    });
    await world.service.raise(SESSION, RAISE);
    const [request] = await world.service.list(OWNER);
    if (request === undefined) throw new Error('no request');

    let woken: { state: string; at: number } | undefined;
    const waiting = world.service.agentView(SESSION, 'A1' as AgendaId, 60_000).then(view => {
      woken = { state: view.state, at: time.clock.now };
    });
    await settle();
    should(woken).be.undefined();

    const answered = world.service.deliver(
      SESSION,
      request.id,
      {
        deliveryId: crypto.randomUUID(),
        observedDigest: request.observedDigest ?? '',
        padded: padInputValue('hunter2-UNIQUE'),
        submit: true,
      },
      OWNER,
    );
    await settle();

    // Typed and woken at fake time 0; the 200 ms agenda close has not finished, so neither has the notice.
    should(world.writes).eql(['hunter2-UNIQUE']);
    should(woken).eql({ state: 'delivered', at: 0 });
    should(closed).eql([]);
    should(told).eql([]);

    time.advance(200);
    await Promise.all([answered, waiting]);
    should(closed.length).equal(1);
    should(told.length).equal(1);
  });

  const answer = async (world: ReturnType<typeof inputRequestService>) => {
    await world.service.raise(SESSION, RAISE);
    const [request] = await world.service.list(OWNER);
    if (request === undefined) throw new Error('no request');
    return request;
  };
  const owner = (request: { id: string; observedDigest?: string | undefined }) =>
    [
      SESSION,
      request.id,
      {
        deliveryId: crypto.randomUUID(),
        observedDigest: request.observedDigest ?? '',
        padded: padInputValue('hunter2-UNIQUE'),
        submit: true,
      },
      OWNER,
    ] as const;

  it('should write the final outcome durably BEFORE the wait is woken, so a restart reads the true outcome', async () => {
    const time = fakeTime();
    const stored: string[] = [];
    const world = inputRequestService({
      journalled: async event => {
        const { type } = event as { type: string };
        // The final write is slow: 30 ms of fake time.
        if (type === 'surface.input_delivered') await time.takes(30);
        stored.push(type);
      },
    });
    const request = await answer(world);

    let woke: { at: number; stored: string[] } | undefined;
    const waiting = world.service.agentView(SESSION, 'A1' as AgendaId, 60_000).then(() => {
      woke = { at: time.clock.now, stored: [...stored] };
    });
    await settle();
    const answered = world.service.deliver(...owner(request));
    await settle();

    // Typed, but the outcome is not durable yet, so the ferret has not been told "delivered".
    should(world.writes).eql(['hunter2-UNIQUE']);
    should(stored.includes('surface.input_delivered')).be.false();
    should(woke).be.undefined();

    time.advance(30);
    await Promise.all([answered, waiting]);

    // Woken at fake time 30 (the journal write is the wake's whole cost), and `delivered` was already stored: the last
    // journal word a restart would find for this request is the true outcome, never `delivering`.
    should(woke?.at).equal(30);
    should(woke?.stored.at(-1)).equal('surface.input_delivered');
  });

  it('should wake the wait with an unknown outcome, never delivered, when the final journal write fails', async () => {
    const world = inputRequestService({
      journalled: event => {
        if ((event as { type: string }).type === 'surface.input_delivered') throw new Error('disk full');
      },
    });
    const request = await answer(world);

    let seen: string | undefined;
    const waiting = world.service.agentView(SESSION, 'A1' as AgendaId, 60_000).then(view => {
      seen = view.state;
    });
    await settle();
    const result = await world.service.deliver(...owner(request));
    await waiting;

    should(world.writes).eql(['hunter2-UNIQUE']);
    // The owner's Send did type it; the ferret is told what the journal can prove (durable-final.test.ts has the restart).
    should(result.state).equal('delivered');
    should(seen).equal('cancelled');
  });

  it('should still have the journal event written exactly once, before the wake', async () => {
    const order: string[] = [];
    const world = inputRequestService({
      journalled: event => void order.push(`journal:${(event as { type: string }).type}`),
    });
    const request = await answer(world);

    const waiting = world.service.agentView(SESSION, 'A1' as AgendaId, 60_000).then(() => void order.push('woken'));
    await settle();
    await world.service.deliver(...owner(request));
    await waiting;

    should(order.filter(entry => entry === 'journal:surface.input_delivered').length).equal(1);
    should(order.indexOf('journal:surface.input_delivered')).be.below(order.indexOf('woken'));
  });
});
