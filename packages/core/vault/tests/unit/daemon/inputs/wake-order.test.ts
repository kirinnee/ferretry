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

  it('should still have the journal event written, after the wake', async () => {
    const order: string[] = [];
    const world = inputRequestService({
      journalled: event => void order.push(`journal:${(event as { type: string }).type}`),
    });
    await world.service.raise(SESSION, RAISE);
    const [request] = await world.service.list(OWNER);
    if (request === undefined) throw new Error('no request');

    const waiting = world.service.agentView(SESSION, 'A1' as AgendaId, 60_000).then(() => void order.push('woken'));
    await settle();
    await world.service.deliver(
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
    await waiting;

    should(order.filter(entry => entry === 'journal:surface.input_delivered').length).equal(1);
    // The delivered journal event is still written before deliver returns.
    should(order.includes('journal:surface.input_delivered')).be.true();
  });
});
