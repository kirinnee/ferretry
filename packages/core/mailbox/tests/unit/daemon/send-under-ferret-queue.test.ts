import type { Instant } from '@ferretry/std';
import { describe, it } from 'bun:test';
import should from 'should';
import { foldQueue, parseSessionId, type QueueEvent, type SessionQueueStore } from '../../../contract/index.ts';
import { SessionQueueService } from '../../../daemon/lib/queue/service.ts';
import { buildSendHalf, type SendHalfDeps } from '../../../daemon/send-half.ts';

const ID = parseSessionId('session-1');
const T0 = Date.UTC(2026, 10, 16, 18, 0, 0);
const AGENT = { kind: 'agent' } as never;

/**
 * The REAL send half over a Ferrets that lends the ferret's one mutation queue (`FerretsApi.exclusive`): a typed message,
 * an owner's answer to an ask included, waits behind whatever holds that queue (a stop, a resume) and a send to a stopped
 * ferret reaches its revive without taking the queue first (the revive's `resume` takes it itself).
 */
function world(state: 'working' | 'stopped', withQueue = true) {
  const log: QueueEvent[] = [];
  const typed: string[] = [];
  const queueTaken: string[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  let seconds = 0;
  const clock = { now: () => new Date(T0 + seconds++ * 1_000).toISOString() as Instant };
  const store: SessionQueueStore = {
    messages: async () => foldQueue(log),
    append: async (_id, event) => void log.push(event),
  };
  const queue = new SessionQueueService({
    store,
    clock,
    serial: { run: async (_key: string, work: () => Promise<never>) => await work() } as never,
  });
  const summary = () => ({ id: ID, name: 'one', state, mode: 'interactive', harness: 'claude-code' });
  const exclusive = async <T>(ferret: string, work: () => Promise<T>): Promise<T> => {
    queueTaken.push(ferret);
    const result = tail.catch(() => undefined).then(work);
    tail = result;
    return await result;
  };
  const ferrets = {
    get: async () => summary(),
    list: async () => [summary()],
    ...(withQueue ? { exclusive } : {}),
    resume: async () => ({ ok: false, error: { reason: 'relaunch refused' } }),
    harness: async () => ({
      observe: async () => ({ ok: true, value: { alive: true, dead: false, promptReady: true, activeWork: false } }),
      deliver: async ({ text }: { text: string }) => {
        typed.push(text);
        return { ok: true, value: { typed: true } };
      },
      queue: async () => ({ ok: true, value: undefined }),
    }),
  };
  const ledger = {
    list: async () => [],
    accept: async () => ({ created: true }),
    settle: async () => undefined,
    withdraw: async () => undefined,
    revise: async () => undefined,
  };
  const send = buildSendHalf({
    kernel: {
      clock: { now: clock.now, nowMs: () => T0 + seconds * 1_000, after: () => () => undefined },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      redaction: { read: (text: string) => text },
    },
    ferrets,
    gate: { send: true, interrupt: true },
    transformMessage: async ({ text }: { text: string }) => ({ ok: true, value: { text } }),
    boundaries: { markInterrupted: () => undefined },
    evidence: {} as never,
    keepFrame: async () => '/tmp/frame',
    stamp: async () => 'absent',
    clock,
    queue,
    queueStore: store as never,
    ledger,
    channel: {},
    askedQuestion: async () => undefined,
  } as unknown as SendHalfDeps);
  /** Something else on the ferret's queue (a stop, a resume) that has not finished until `release` is called. */
  const hold = (): { readonly release: () => void } => {
    let release = (): void => undefined;
    const held = new Promise<void>(resolve => (release = resolve));
    tail = tail.catch(() => undefined).then(() => held);
    return { release };
  };
  return { send, typed, queueTaken, hold };
}

const later = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, 20));

describe('a typed send runs on the ferret mutation queue', () => {
  it('should type nothing while a stop or resume holds the ferret queue, and type once it lets go', async () => {
    const { send, typed, hold } = world('working');
    const holding = hold();

    const sending = send.submit(ID, { sendId: 'answer-1', message: 'yes, ship it', origin: AGENT });
    await later();
    should(typed).deepEqual([]);

    holding.release();
    await sending;
    should(typed.length).equal(1);
  });

  it('should reach a revive without taking the ferret queue, which the revive takes itself', async () => {
    const { send, queueTaken } = world('stopped');

    await send
      .submit(ID, { sendId: 'answer-2', message: 'yes, ship it', origin: AGENT })
      .catch((): undefined => undefined);

    should(queueTaken).deepEqual([]);
  });

  it('should type as before when Ferrets lends no queue', async () => {
    const { send, typed } = world('working', false);

    await send.submit(ID, { sendId: 'answer-3', message: 'yes, ship it', origin: AGENT });

    should(typed.length).equal(1);
  });
});
