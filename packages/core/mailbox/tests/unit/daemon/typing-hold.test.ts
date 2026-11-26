import { PERSON_ORIGIN } from '@ferretry/core-ferrets/contract';
import type { Instant } from '@ferretry/std';
import { describe, it } from 'bun:test';
import should from 'should';
import {
  foldQueue,
  heldForTyping,
  parseSessionId,
  type QueueEvent,
  type QueuedMessage,
  reasonForWaiting,
  type SessionQueueStore,
} from '../../../contract/index.ts';
import { SessionQueueService } from '../../../daemon/lib/queue/service.ts';
import { buildSendHalf, type SendHalfDeps } from '../../../daemon/send-half.ts';

/**
 * THE TYPING HOLD (owner idea A563) through the REAL send half, over a pane the test says a person is typing in: the
 * daemon's own writes wait for the quiet and land after it, a person's own send is never held, and nothing is ever typed
 * between a person's keys. The 5 s window itself belongs to the terminal (`typing-hold.test.ts` there); this is the
 * guard that reads what the pane reports.
 */
const ID = parseSessionId('session-1');
const T0 = Date.UTC(2026, 10, 16, 18, 0, 0);
const AGENT = { kind: 'agent' } as never;
const PANE = { alive: true, dead: false, promptReady: true, activeWork: false };

function world(mode: 'auto' | 'interactive') {
  const log: QueueEvent[] = [];
  const typed: string[] = [];
  let typing = true;
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
  const summary = { id: ID, name: 'one', state: 'working', mode, harness: 'claude-code' };
  const ferrets = {
    get: async () => summary,
    list: async () => [summary],
    harness: async () => ({
      observe: async () => ({ ok: true, value: typing ? { ...PANE, typing: true } : PANE }),
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
    settle: async () => ({}),
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
  const queued = (): readonly QueuedMessage[] => foldQueue(log);
  const quiet = (): void => {
    typing = false;
  };
  return { send, queued, typed, quiet };
}

describe('the typing hold in the draft guard', () => {
  it('should hold every sender but a person, and never the person', () => {
    should(heldForTyping({ typing: true }, 'agent')).be.true();
    should(heldForTyping({ typing: true }, 'daemon')).be.true();
    should(heldForTyping({ typing: true }, 'human')).be.false();
    should(heldForTyping({}, 'daemon')).be.false();
    const view = { target: { id: ID, status: 'running', mode: 'auto', turn: 1 } as never, launching: false };
    should(reasonForWaiting({ ...view, pane: { ...PANE, typing: true } }, 'daemon')).equal('typing');
    should(reasonForWaiting({ ...view, pane: { ...PANE, typing: true } }, 'human')).be.undefined();
    should(reasonForWaiting({ ...view, pane: { ...PANE, typing: true, draft: 'half' } }, 'daemon')).equal('draft');
  });

  it('should keep a queued wake waiting while a person types, then type it once, after the quiet', async () => {
    const { send, queued, typed, quiet } = world('auto');

    await send.submit(ID, { sendId: 'wake:1', message: 'your wait is over', origin: AGENT, monitor: true });
    await send.deliverer.changed(ID);
    should(queued()[0]).containEql({ state: 'queued', waitReason: 'typing' });
    should(typed).deepEqual([]);

    quiet();
    await send.deliverer.changed(ID);
    should(typed).deepEqual(['your wait is over']);
    should(queued()[0]?.state).not.equal('queued');
  });

  it('should never hold the owner’s own send while they type', async () => {
    const { send, typed } = world('auto');

    await send.submit(ID, { sendId: 'mine', message: 'hello from me', origin: PERSON_ORIGIN });

    should(typed).deepEqual(['hello from me']);
  });

  it('should keep a direct Agenda nudge untyped while a person types, and refuse the Warden’s without typing', async () => {
    const { send, typed } = world('interactive');

    const nudge = await send.submit(ID, { sendId: 'nudge:1', message: 'finish it', origin: AGENT, agenda: true });
    should(nudge.waitReason).equal('typing');
    const warden = send.submit(ID, { sendId: 'warden:1', message: 'revive', origin: AGENT, warden: true });
    await should(warden).be.rejectedWith(/a person is typing/);

    should(typed).deepEqual([]);
  });
});
