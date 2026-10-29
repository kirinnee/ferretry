import { describe, it } from 'bun:test';
import should from 'should';
import {
  ATTENTION_REPLY_CAP_MS,
  ATTENTION_REPLY_COMPOSER_WAIT_MS,
  ATTENTION_REPLY_HOLD_CEILING_MS,
  ATTENTION_REPLY_RECEIPT_MS,
  ATTENTION_REPLY_RECHECK_MS,
  ATTENTION_REPLY_SETTLE_MS,
  type AttentionComposerState,
  AttentionNotTyped,
  type AttentionOutbox,
  type AttentionOutboxRepository,
  type AttentionReceipt,
  AttentionReplyBatcher,
  type AttentionReplyTimers,
  attentionBatchSendId,
  attentionReplyDueAt,
  beginAttentionBatch,
  emptyAttentionOutbox,
  finishAttentionBatch,
  instructionsReplyKey,
  MAX_ATTENTION_PENDING_REPLIES,
  needsInfoReplyKey,
  withPendingReply,
} from '../../../src/lib/attention/index.ts';

const AT = '2026-10-28T17:00:00.000Z';
const SESSION = 'session-1';

class MemoryOutboxes implements AttentionOutboxRepository {
  readonly files = new Map<string, AttentionOutbox>();
  failReads = false;

  async read(sessionId: string): Promise<AttentionOutbox | null> {
    if (this.failReads) throw new Error('unreadable');
    return this.files.get(sessionId) ?? null;
  }

  async write(outbox: AttentionOutbox): Promise<void> {
    this.files.set(outbox.sessionId, structuredClone(outbox));
  }
}

/** Timers that keep the task, so a case can run what the real timer would. */
class HeldTimers implements AttentionReplyTimers {
  readonly tasks = new Map<string, { delayMs: number; task: () => void }>();

  schedule(key: string, delayMs: number, task: () => void): void {
    this.tasks.set(key, { delayMs, task });
  }

  cancel(key: string): void {
    this.tasks.delete(key);
  }
}

class Sends {
  readonly sent: Array<{ message: string; sendId: string }> = [];
  failure?: Error;

  async send(_sessionId: string, message: string, sendId: string): Promise<void> {
    this.sent.push({ message, sendId });
    if (this.failure !== undefined) throw this.failure;
  }
}

/**
 * The sends without the time stamp each batch's id carries (`-<base36 ms>`), for the cases about which
 * items went together rather than when.
 */
const unstamped = (sent: readonly { message: string; sendId: string }[]) =>
  sent.map(({ message, sendId }) => ({ message, sendId: sendId.replace(/-[0-9a-z]+$/u, '') }));

const inline = { run: async <T>(_key: string, task: () => Promise<T>): Promise<T> => await task() };
const clock = { now: () => AT };
/** The production executor's contract: work under one key runs one at a time, in arrival order. */
function perKey(): { run: <T>(key: string, task: () => Promise<T>) => Promise<T> } {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run: async <T>(key: string, task: () => Promise<T>): Promise<T> => {
      const result = (tails.get(key) ?? Promise.resolve()).then(task);
      tails.set(
        key,
        result.catch(() => undefined),
      );
      return await result;
    },
  };
}

/** Lets a detached delivery run to its end: it awaits several file reads and writes. */
const settled = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, 0));

function world() {
  const outboxes = new MemoryOutboxes();
  const timers = new HeldTimers();
  const sends = new Sends();
  return { outboxes, timers, sends, batcher: new AttentionReplyBatcher(outboxes, sends, timers, inline, clock) };
}

describe('the attention outbox', () => {
  it('should take each item once, whether it is held, sending or delivered', () => {
    // Arrange
    const reply = (id: string) => ({ id, message: `[answer to !${id}] yes`, at: AT });
    const held = withPendingReply(emptyAttentionOutbox(SESSION), reply('A1')) as AttentionOutbox;
    const begun = beginAttentionBatch(held);
    const sending = begun?.outbox as AttentionOutbox;
    const delivered = finishAttentionBatch(sending, begun?.batch as never);

    // Act + Assert
    should(withPendingReply(held, reply('A1'))).be.null();
    should(withPendingReply(sending, reply('A1'))).be.null();
    should(withPendingReply(delivered, reply('A1'))).be.null();
    should(withPendingReply(delivered, reply('A2'))?.pending.map(each => each.id)).deepEqual(['A2']);
    should(delivered).containDeep({ pending: [], sending: [], delivered: ['A1'] });
  });

  it('should be due a settle after the last answer, never later than the cap after the first', () => {
    // Arrange
    const outbox = (...seconds: number[]): AttentionOutbox => ({
      ...emptyAttentionOutbox(SESSION),
      pending: seconds.map((second, index) => ({
        id: `A${index + 1}`,
        message: 'm',
        at: new Date(Date.parse(AT) + second * 1_000).toISOString(),
      })),
    });

    // Act + Assert
    should(attentionReplyDueAt(emptyAttentionOutbox(SESSION))).be.undefined();
    should(attentionReplyDueAt(outbox(0))).equal(Date.parse(AT) + ATTENTION_REPLY_SETTLE_MS);
    should(attentionReplyDueAt(outbox(0, 150))).equal(Date.parse(AT) + ATTENTION_REPLY_CAP_MS);
  });

  it('should name every item in a batch’s send id, stamped with when it was begun', () => {
    // Act + Assert — the stamp keeps an answer given again after a failed delivery off the settled id.
    should(attentionBatchSendId(SESSION, ['A3'])).equal('attention-session-1-A3');
    should(attentionBatchSendId(SESSION, ['A3', 'A7'])).equal('attention-session-1-A3-A7');
    should(attentionBatchSendId(SESSION, ['A3'], AT)).equal(`attention-session-1-A3-${Date.parse(AT).toString(36)}`);
    should(attentionBatchSendId(SESSION, ['A3'], '2026-10-28T17:00:01.000Z')).not.equal(
      attentionBatchSendId(SESSION, ['A3'], AT),
    );
  });

  it('should leave an unknown batch sending when another finishes, and remember a bounded history', () => {
    // Arrange
    const many = Array.from({ length: 300 }, (_, index) => `A${index + 1}`);
    const other = { sendId: 'attention-session-1-A9', ids: ['A9'], message: 'm' };
    const outbox = { ...emptyAttentionOutbox(SESSION), sending: [other] };

    // Act
    const finished = finishAttentionBatch(outbox, { sendId: 'x', ids: many, message: 'm' });

    // Assert
    should(finished.sending).deepEqual([other]);
    should(finished.delivered.length).equal(256);
    should(finished.delivered.at(-1)).equal('A300');
  });
});

describe('the attention reply batcher', () => {
  it('should deliver when its timer fires', async () => {
    // Arrange
    const { batcher, timers, sends } = world();
    await batcher.add(SESSION, 'A1', 'one');

    // Act
    timers.tasks.get(SESSION)?.task();
    await settled();

    // Assert
    should(unstamped(sends.sent)).deepEqual([{ message: 'one', sendId: 'attention-session-1-A1' }]);
  });

  it('should send an answer once when the owner skips the wait as the timer fires', async () => {
    // Arrange — one send id is one message; the ledger shows its accepted → withdrawn history as two rows.
    const outboxes = new MemoryOutboxes();
    const timers = new HeldTimers();
    const sends = new Sends();
    const batcher = new AttentionReplyBatcher(outboxes, sends, timers, perKey(), clock);
    await batcher.add(SESSION, 'A6', 'Reached you');

    // Act — "Send now" races the timer that was already due, and the answer is given again meanwhile.
    await Promise.all([batcher.sendNow(SESSION), batcher.flush(SESSION), batcher.add(SESSION, 'A6', 'Reached you')]);
    timers.tasks.get(SESSION)?.task();
    await settled();

    // Assert
    should(unstamped(sends.sent)).deepEqual([{ message: 'Reached you', sendId: 'attention-session-1-A6' }]);
  });

  it('should send a full outbox before it takes one more answer', async () => {
    // Arrange
    const { batcher, sends, outboxes } = world();
    for (let index = 1; index <= MAX_ATTENTION_PENDING_REPLIES; index += 1)
      await batcher.add(SESSION, `A${index}`, 'm');

    // Act
    await batcher.add(SESSION, 'A999', 'overflow');
    await settled();

    // Assert
    should(sends.sent).have.length(1);
    should(unstamped(sends.sent)[0]?.sendId.endsWith(`-A${MAX_ATTENTION_PENDING_REPLIES}`)).be.true();
    should(outboxes.files.get(SESSION)?.pending.map(each => each.id)).deepEqual(['A999']);
  });

  it('should report nothing held, deliver nothing and arm nothing for an empty outbox', async () => {
    // Arrange
    const { batcher, sends, timers } = world();

    // Act
    const held = await batcher.pending(SESSION);
    await batcher.sendNow(SESSION);
    await batcher.flush(SESSION);
    await batcher.resume([SESSION]);

    // Assert
    should(held).be.undefined();
    should(sends.sent).be.empty();
    should(timers.tasks.size).equal(0);
  });

  it('should swallow a timer’s failed delivery: the outbox keeps what it held for the next start', async () => {
    // Arrange
    const { batcher, timers, outboxes, sends } = world();
    await batcher.add(SESSION, 'A1', 'one');
    outboxes.failReads = true;

    // Act
    timers.tasks.get(SESSION)?.task();
    await settled();

    // Assert
    should(sends.sent).be.empty();
    should(outboxes.files.get(SESSION)?.pending.map(each => each.id)).deepEqual(['A1']);
  });

  it('should keep resuming the other ferrets when one outbox cannot be read', async () => {
    // Arrange
    const { batcher, outboxes } = world();
    outboxes.failReads = true;

    // Act + Assert
    await should(batcher.resume([SESSION, 'session-2'])).be.fulfilled();
  });
});

describe('the attention reply batcher and needs-info requests', () => {
  it('should name each request of one item with its own key, and deliver each request exactly once, batched with answers', async () => {
    // Arrange
    const { batcher, sends, outboxes } = world();
    const first = needsInfoReplyKey('A3', 1);
    const second = needsInfoReplyKey('A3', 2);

    // Act
    await batcher.add(SESSION, 'A1', '[answer to !A1] yes');
    await batcher.add(SESSION, first, '[needs more info !A3] one');
    await batcher.add(SESSION, first, '[needs more info !A3] one');
    await batcher.flush(SESSION);
    await batcher.add(SESSION, first, '[needs more info !A3] one');
    await batcher.add(SESSION, second, '[needs more info !A3] two');
    await batcher.flush(SESSION);
    await batcher.watch(SESSION);

    // Assert
    should(first).equal('A3~1');
    should(unstamped(sends.sent)).deepEqual([
      {
        message: '[answer to !A1] yes\n\n[needs more info !A3] one',
        sendId: 'attention-session-1-A1-A3~1',
      },
      { message: '[needs more info !A3] two', sendId: 'attention-session-1-A3~2' },
    ]);
    should(outboxes.files.get(SESSION)?.delivered).deepEqual(['A1', 'A3~1', 'A3~2']);
  });

  it('should report the items held, with a request key mapped back to its item once', async () => {
    // Arrange
    const { batcher } = world();
    await batcher.add(SESSION, needsInfoReplyKey('A3', 1), 'one');
    await batcher.add(SESSION, 'A3', 'answer');

    // Act
    const held = await batcher.pending(SESSION);

    // Assert
    should(held?.pending).deepEqual(['A3']);
  });
});

/** A clock the case moves, and a ferret that is busy while the case says so. */
function timed() {
  const outboxes = new MemoryOutboxes();
  const timers = new HeldTimers();
  const sends = new Sends();
  const time = { ms: Date.parse(AT) };
  const ferret = { busy: false, unreadable: false };
  const batcher = new AttentionReplyBatcher(
    outboxes,
    sends,
    timers,
    inline,
    { now: () => new Date(time.ms).toISOString() },
    { settleMs: ATTENTION_REPLY_SETTLE_MS, capMs: ATTENTION_REPLY_CAP_MS },
    {
      busy: async () => {
        if (ferret.unreadable) throw new Error('state unreadable');
        return ferret.busy;
      },
    },
  );
  /** Moves time to the armed timer and runs what it would. */
  const fire = async (): Promise<number> => {
    const armed = timers.tasks.get(SESSION);
    time.ms += armed?.delayMs ?? 0;
    await batcher.flush(SESSION);
    return armed?.delayMs ?? -1;
  };
  return { outboxes, timers, sends, time, ferret, batcher, fire };
}

describe('the attention reply batcher while the ferret is mid-turn', () => {
  it('should hold a due batch while the ferret works, let later answers join it, and send once it is idle', async () => {
    // Arrange
    const { batcher, timers, sends, time, ferret } = timed();
    ferret.busy = true;
    await batcher.add(SESSION, 'A1', 'one');

    // Act — due while busy: nothing goes, and it looks again soon. An answer joins the held batch.
    time.ms += ATTENTION_REPLY_SETTLE_MS;
    await batcher.flush(SESSION);
    const rechecked = timers.tasks.get(SESSION)?.delayMs;
    const during = await batcher.pending(SESSION);
    await batcher.add(SESSION, 'A2', 'two');
    time.ms += ATTENTION_REPLY_SETTLE_MS;
    await batcher.flush(SESSION);
    const sentWhileBusy = sends.sent.length;
    ferret.busy = false;
    time.ms += ATTENTION_REPLY_RECHECK_MS;
    await batcher.flush(SESSION);

    // Assert
    should(rechecked).equal(ATTENTION_REPLY_RECHECK_MS);
    should(during?.heldForTurn).be.true();
    should(sentWhileBusy).equal(0);
    should(unstamped(sends.sent)).deepEqual([{ message: 'one\n\ntwo', sendId: 'attention-session-1-A1-A2' }]);
  });

  it('should not say a batch is held for the turn before it is due, or when the ferret is idle', async () => {
    // Arrange
    const { batcher, time, ferret } = timed();
    ferret.busy = true;
    await batcher.add(SESSION, 'A1', 'one');

    // Act
    const early = await batcher.pending(SESSION);
    time.ms += ATTENTION_REPLY_SETTLE_MS;
    ferret.busy = false;
    const idle = await batcher.pending(SESSION);

    // Assert
    should(early).not.have.property('heldForTurn');
    should(idle).not.have.property('heldForTurn');
    should(idle?.pending).deepEqual(['A1']);
  });

  it('should send anyway once the hold has lasted its ceiling past the due time', async () => {
    // Arrange
    const { batcher, sends, time, ferret } = timed();
    ferret.busy = true;
    await batcher.add(SESSION, 'A1', 'one');
    time.ms += ATTENTION_REPLY_SETTLE_MS;

    // Act
    await batcher.flush(SESSION);
    const held = sends.sent.length;
    time.ms += ATTENTION_REPLY_HOLD_CEILING_MS;
    const projected = await batcher.pending(SESSION);
    await batcher.flush(SESSION);

    // Assert
    should(held).equal(0);
    should(projected).not.have.property('heldForTurn');
    should(sends.sent).have.length(1);
  });

  it('should treat a state that cannot be read as not busy', async () => {
    // Arrange
    const { batcher, sends, time, ferret } = timed();
    ferret.unreadable = true;
    await batcher.add(SESSION, 'A1', 'one');
    time.ms += ATTENTION_REPLY_SETTLE_MS;

    // Act
    await batcher.flush(SESSION);

    // Assert
    should(sends.sent).have.length(1);
  });

  it('should let "Send now" ignore the hold', async () => {
    // Arrange
    const { batcher, sends, timers, time, ferret } = timed();
    ferret.busy = true;
    await batcher.add(SESSION, 'A1', 'one');
    time.ms += ATTENTION_REPLY_SETTLE_MS;
    await batcher.flush(SESSION);

    // Act
    await batcher.sendNow(SESSION);
    await settled();

    // Assert
    should(unstamped(sends.sent)).deepEqual([{ message: 'one', sendId: 'attention-session-1-A1' }]);
    should(timers.tasks.has(SESSION)).be.false();
  });

  it('should keep the hold across a restart: resume re-arms it and the ferret still works', async () => {
    // Arrange
    const { batcher, sends, timers, time, ferret, outboxes } = timed();
    ferret.busy = true;
    await batcher.add(SESSION, 'A1', 'one');
    timers.tasks.clear();
    time.ms += ATTENTION_REPLY_SETTLE_MS;

    // Act
    await batcher.resume([SESSION]);
    const rearmed = await timers.tasks.get(SESSION)?.delayMs;
    await batcher.flush(SESSION);

    // Assert
    should(rearmed).equal(0);
    should(sends.sent).be.empty();
    should(outboxes.files.get(SESSION)?.pending.map(each => each.id)).deepEqual(['A1']);
  });

  it('should run the timer’s recheck task, and send when the ferret has gone idle', async () => {
    // Arrange
    const { batcher, sends, timers, time, ferret } = timed();
    ferret.busy = true;
    await batcher.add(SESSION, 'A1', 'one');
    time.ms += ATTENTION_REPLY_SETTLE_MS;
    await batcher.flush(SESSION);

    // Act
    ferret.busy = false;
    time.ms += ATTENTION_REPLY_RECHECK_MS;
    timers.tasks.get(SESSION)?.task();
    await settled();

    // Assert
    should(sends.sent).have.length(1);
  });

  it('should never list a non-item key as an item, and report nothing when only one is held', async () => {
    // Arrange
    const { batcher, time } = timed();
    const key = instructionsReplyKey('0123456789abcd');
    await batcher.add(SESSION, key, '[instructions updated] …');
    time.ms += ATTENTION_REPLY_SETTLE_MS;

    // Act
    const onlyNote = await batcher.pending(SESSION);
    await batcher.add(SESSION, 'A4', 'answer');
    const both = await batcher.pending(SESSION);

    // Assert
    should(key).equal('instructions~0123456789abcd');
    should(onlyNote).be.undefined();
    should(both?.pending).deepEqual(['A4']);
  });

  it('should send a note and the answers together as one message under one send id', async () => {
    // Arrange
    const { batcher, sends, fire } = timed();
    await batcher.add(SESSION, 'A4', 'answer');
    await batcher.add(SESSION, instructionsReplyKey('0123456789abcd'), 'note');

    // Act
    await fire();

    // Assert
    should(unstamped(sends.sent)).deepEqual([
      { message: 'answer\n\nnote', sendId: 'attention-session-1-A4-instructions~0123456789abcd' },
    ]);
  });
});

/**
 * A ferret whose composer, send ledger and board the case controls, on a clock the case moves: the delivery
 * the owner asked for (docs/attention.md § Delivery).
 */
function delivering() {
  const outboxes = new MemoryOutboxes();
  const timers = new HeldTimers();
  const sends = new Sends();
  const time = { ms: Date.parse(AT) };
  const composer: { state: AttentionComposerState; throws: boolean } = { state: 'empty', throws: false };
  const receipts = new Map<string, AttentionReceipt>();
  const undelivered: Array<{ key: string; reason: string }> = [];
  const batcher = new AttentionReplyBatcher(
    outboxes,
    sends,
    timers,
    inline,
    { now: () => new Date(time.ms).toISOString() },
    { settleMs: ATTENTION_REPLY_SETTLE_MS, capMs: ATTENTION_REPLY_CAP_MS },
    { busy: async () => false },
    {
      composer: {
        state: async () => {
          if (composer.throws) throw new Error('pane gone');
          return composer.state;
        },
      },
      receipts: { receipt: async (_session, sendId) => receipts.get(sendId) ?? { state: 'pending' } },
      undelivered: {
        undelivered: async (_session, key, reason) => {
          undelivered.push({ key, reason });
        },
      },
    },
  );
  /** Moves time to the armed window timer and runs it. */
  const fire = async (): Promise<void> => {
    time.ms += timers.tasks.get(SESSION)?.delayMs ?? 0;
    await batcher.flush(SESSION);
  };
  const lastSendId = (): string => sends.sent.at(-1)?.sendId ?? '';
  return { outboxes, timers, sends, time, composer, receipts, undelivered, batcher, fire, lastSendId };
}

describe('the attention reply window', () => {
  it('should go ten seconds after the last card action, each action restarting it, never past two minutes', async () => {
    // Arrange
    const { batcher, timers, time } = delivering();

    // Act — an answer, another eight seconds later, then one every nine seconds for three minutes.
    await batcher.add(SESSION, 'A1', 'one');
    const first = timers.tasks.get(SESSION)?.delayMs;
    time.ms += 8_000;
    await batcher.add(SESSION, 'A2', 'two');
    const extended = timers.tasks.get(SESSION)?.delayMs;
    for (let index = 3; time.ms - Date.parse(AT) < 180_000; index += 1) {
      time.ms += 9_000;
      await batcher.add(SESSION, `A${index}`, 'more');
    }
    const capped = timers.tasks.get(SESSION)?.delayMs;

    // Assert — every action restarts the countdown; the cap is two minutes after the first.
    should(ATTENTION_REPLY_SETTLE_MS).equal(10_000);
    should(ATTENTION_REPLY_CAP_MS).equal(120_000);
    should(first).equal(10_000);
    should(extended).equal(10_000);
    should(capped).equal(0);
  });
});

describe('the attention reply batcher and the ferret’s composer', () => {
  it('should never type into a composer that holds text, and say the answers are held for it', async () => {
    // Arrange
    const { batcher, sends, timers, composer, fire } = delivering();
    composer.state = 'occupied';
    await batcher.add(SESSION, 'A1', 'one');

    // Act
    await fire();
    const held = await batcher.delivery(SESSION);
    const replies = await batcher.pending(SESSION);

    // Assert
    should(sends.sent).be.empty();
    should(held).deepEqual({ sending: [], heldForComposer: true });
    should(replies?.pending).deepEqual(['A1']);
    should(timers.tasks.get(SESSION)?.delayMs).equal(ATTENTION_REPLY_RECHECK_MS);
  });

  it('should treat a composer that cannot be read as not empty', async () => {
    // Arrange
    const { batcher, sends, composer, fire } = delivering();
    composer.throws = true;
    await batcher.add(SESSION, 'A1', 'one');

    // Act
    await fire();

    // Assert
    should(sends.sent).be.empty();
    should(await batcher.delivery(SESSION)).deepEqual({ sending: [], heldForComposer: true });
  });

  it('should deliver once the composer is empty again, with answers given meanwhile joining the batch', async () => {
    // Arrange
    const { batcher, sends, time, composer, fire } = delivering();
    composer.state = 'occupied';
    await batcher.add(SESSION, 'A1', 'one');
    await fire();

    // Act
    await batcher.add(SESSION, 'A2', 'two');
    composer.state = 'empty';
    time.ms += ATTENTION_REPLY_SETTLE_MS;
    await batcher.flush(SESSION);

    // Assert
    should(unstamped(sends.sent)).deepEqual([{ message: 'one\n\ntwo', sendId: 'attention-session-1-A1-A2' }]);
    should(await batcher.delivery(SESSION)).deepEqual({ sending: ['A1', 'A2'] });
  });

  it('should hand the answers back to the owner once the composer has held text past its wait', async () => {
    // Arrange
    const { batcher, sends, outboxes, time, composer, undelivered, fire } = delivering();
    composer.state = 'occupied';
    await batcher.add(SESSION, 'A1', 'one');
    await batcher.add(SESSION, needsInfoReplyKey('A2', 1), 'discuss');
    await fire();

    // Act
    time.ms = Date.parse(AT) + ATTENTION_REPLY_CAP_MS + ATTENTION_REPLY_COMPOSER_WAIT_MS;
    await batcher.flush(SESSION);

    // Assert
    should(sends.sent).be.empty();
    should(undelivered.map(each => each.key)).deepEqual(['A1', 'A2~1']);
    should(undelivered[0]?.reason).match(/unsent text/);
    should(outboxes.files.get(SESSION)?.pending).be.empty();
    should(await batcher.delivery(SESSION)).be.undefined();
  });

  it('should put a batch the send path typed nothing for back to waiting, and send it under a fresh id', async () => {
    // Arrange — the composer read empty, but a person started typing before the keys went.
    const { batcher, sends, outboxes, time, timers, fire } = delivering();
    await batcher.add(SESSION, 'A1', 'one');
    sends.failure = new AttentionNotTyped('the composer holds unsent text');

    // Act
    await fire();
    const back = outboxes.files.get(SESSION);
    const recheck = timers.tasks.get(SESSION)?.delayMs;
    sends.failure = undefined;
    time.ms += ATTENTION_REPLY_RECHECK_MS;
    await batcher.flush(SESSION);

    // Assert
    should(back?.pending.map(each => each.id)).deepEqual(['A1']);
    should(back?.sending).be.empty();
    should(recheck).equal(ATTENTION_REPLY_RECHECK_MS);
    should(sends.sent).have.length(2);
    should(sends.sent[0]?.sendId).not.equal(sends.sent[1]?.sendId);
    should(unstamped(sends.sent).map(each => each.sendId)).deepEqual([
      'attention-session-1-A1',
      'attention-session-1-A1',
    ]);
  });
});

describe('the attention reply batcher on receipt', () => {
  it('should keep a sent batch "sending" until the transcript proves it, then never queue it again', async () => {
    // Arrange
    const { batcher, outboxes, receipts, timers, fire, lastSendId } = delivering();
    await batcher.add(SESSION, 'A1', 'one');
    await fire();

    // Act — no proof yet, then proof.
    await batcher.watch(SESSION);
    const waiting = outboxes.files.get(SESSION);
    const watchAgain = timers.tasks.get(`${SESSION}#receipt`)?.delayMs;
    receipts.set(lastSendId(), { state: 'delivered' });
    await batcher.watch(SESSION);
    await batcher.add(SESSION, 'A1', 'again');

    // Assert
    should(waiting?.sending[0]).containDeep({ ids: ['A1'], sentAt: '2026-10-28T17:00:10.000Z' });
    should(waiting?.delivered).be.empty();
    should(watchAgain).equal(ATTENTION_REPLY_RECHECK_MS);
    should(outboxes.files.get(SESSION)).containDeep({ pending: [], sending: [], delivered: ['A1'] });
    should(await batcher.delivery(SESSION)).be.undefined();
  });

  it('should hand every item of a batch the ledger proved absent back to the owner, and take it again', async () => {
    // Arrange
    const { batcher, sends, outboxes, receipts, undelivered, fire, lastSendId } = delivering();
    await batcher.add(SESSION, 'A1', 'one');
    await batcher.add(SESSION, needsInfoReplyKey('A2', 1), 'discuss');
    await fire();
    receipts.set(lastSendId(), { state: 'failed', reason: 'it never appeared in the ferret’s transcript' });

    // Act
    await batcher.watch(SESSION);
    await batcher.add(SESSION, 'A1', 'answered again');
    await fire();

    // Assert
    should(undelivered).deepEqual([
      { key: 'A1', reason: 'it never appeared in the ferret’s transcript' },
      { key: 'A2~1', reason: 'it never appeared in the ferret’s transcript' },
    ]);
    should(sends.sent.map(each => each.message)).deepEqual(['one\n\ndiscuss', 'answered again']);
    should(outboxes.files.get(SESSION)?.delivered).be.empty();
  });

  it('should hand a batch back when no proof arrives within the receipt wait', async () => {
    // Arrange
    const { batcher, time, undelivered, fire } = delivering();
    await batcher.add(SESSION, 'A1', 'one');
    await fire();

    // Act
    time.ms += ATTENTION_REPLY_RECEIPT_MS - 1;
    await batcher.watch(SESSION);
    const before = undelivered.length;
    time.ms += 1;
    await batcher.watch(SESSION);

    // Assert
    should(before).equal(0);
    should(undelivered.map(each => each.key)).deepEqual(['A1']);
    should(undelivered[0]?.reason).match(/never showed it arriving/);
  });

  it('should hand a batch the send path refused outright straight back to the owner', async () => {
    // Arrange
    const { batcher, sends, outboxes, undelivered, fire } = delivering();
    sends.failure = new Error('the ferret was removed');
    await batcher.add(SESSION, 'A1', 'one');

    // Act
    await fire();

    // Assert
    should(undelivered).deepEqual([{ key: 'A1', reason: 'the ferret was removed' }]);
    should(outboxes.files.get(SESSION)).containDeep({ pending: [], sending: [], delivered: [] });
  });

  it('should look for the proof of an accepted batch after a restart, and re-send one never accepted', async () => {
    // Arrange — one batch accepted before the restart, one written down but never handed over.
    const { batcher, sends, outboxes, timers } = delivering();
    await outboxes.write({
      ...emptyAttentionOutbox(SESSION),
      sending: [
        { sendId: 'attention-session-1-A1-x', ids: ['A1'], message: 'one', sentAt: AT },
        { sendId: 'attention-session-1-A2-y', ids: ['A2'], message: 'two' },
      ],
    });

    // Act
    await batcher.resume([SESSION]);

    // Assert
    should(sends.sent).deepEqual([{ message: 'two', sendId: 'attention-session-1-A2-y' }]);
    should(timers.tasks.has(`${SESSION}#receipt`)).be.true();
    should(outboxes.files.get(SESSION)?.sending.map(batch => batch.sentAt)).deepEqual([AT, AT]);
  });
});
