import type { Instant } from '@ferretry/std';
import { describe, it } from 'bun:test';
import should from 'should';
import {
  foldQueue,
  parseSessionId,
  type QueueEvent,
  type QueuedMessage,
  type SessionQueueStore,
} from '../../../contract/index.ts';
import { SessionQueueService } from '../../../daemon/lib/queue/service.ts';
import { buildSendHalf, type SendHalfDeps } from '../../../daemon/send-half.ts';

const ID = parseSessionId('session-1');
const STOPPED = 'the ferret is stopped and a wake never revives it, so nothing was typed';
const T0 = Date.UTC(2026, 10, 16, 18, 0, 0);
const AGENT = { kind: 'agent' } as never;

/**
 * The REAL send half (typeMessage, typeLocked, the deliverer and the senders) over an in-memory queue log, and a Ferrets
 * whose one ferret the test starts, stops, and counts relaunches of. Nothing here stands in for the choice under test.
 */
function world(mode: 'auto' | 'interactive') {
  const log: QueueEvent[] = [];
  const revived: string[] = [];
  const typed: string[] = [];
  let state: 'working' | 'stopped' = 'working';
  let stopOnOpen = false;
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
  const summary = () => ({ id: ID, name: 'one', state, mode, harness: 'claude-code' });
  const ferrets = {
    get: async () => summary(),
    list: async () => [summary()],
    resume: async () => {
      revived.push('resume');
      return { ok: false, error: { reason: 'relaunch refused' } };
    },
    harness: async () => {
      // The race the direct path has: the ferret ran when the send chose it, and has stopped by the time it types.
      if (stopOnOpen) state = 'stopped';
      return {
        // A pane behind a dialog holds a message back (the gate); once the ferret has stopped its pane is gone.
        observe: async () => ({
          ok: true,
          value:
            state === 'working'
              ? { alive: true, dead: false, promptReady: false, activeWork: false, blockingPrompt: 'Allow this?' }
              : { alive: false, dead: true, promptReady: false, activeWork: false },
        }),
        deliver: async ({ text }: { text: string }) => {
          typed.push(text);
          return { ok: true, value: { typed: true } };
        },
        queue: async () => ({ ok: true, value: undefined }),
      };
    },
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
      clock: {
        now: clock.now,
        nowMs: () => T0 + seconds * 1_000,
        after: () => () => undefined,
      },
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
  const queued = (): readonly QueuedMessage[] => foldQueue(log);
  const stop = (): void => {
    state = 'stopped';
  };
  const stopWhenOpened = (): void => {
    stopOnOpen = true;
  };
  return { send, queued, revived, typed, stop, stopWhenOpened };
}

describe('a Monitor wake never revives a stopped ferret', () => {
  it('should refuse a wake queued behind a gate and handed over after the ferret stopped, with no revive', async () => {
    const { send, queued, revived, typed, stop } = world('auto');

    // The ferret is at work, so the wake waits in its queue; the owner (or its own end) stops it; the queue then looks.
    await send.submit(ID, { sendId: 'wake:session-1:t', message: 'your wait is over', origin: AGENT, monitor: true });
    should(queued().map(entry => entry.state)).deepEqual(['queued']);
    stop();
    await send.deliverer.changed(ID);

    should(revived).deepEqual([]);
    should(typed).deepEqual([]);
    should(queued()[0]?.state).not.equal('queued');
    should(JSON.stringify(queued())).containEql(STOPPED);
  });

  it('should refuse the same wake on the direct (interactive) path, with no revive', async () => {
    const { send, revived, typed, stopWhenOpened } = world('interactive');
    let error: unknown;

    stopWhenOpened();
    const direct = send.submit(ID, {
      sendId: 'wake:session-1:u',
      message: 'your wait is over',
      origin: AGENT,
      monitor: true,
    });
    await direct.catch((caught: unknown) => (error = caught));

    should(String(error)).containEql(STOPPED);
    should(revived).deepEqual([]);
    should(typed).deepEqual([]);
  });
});
