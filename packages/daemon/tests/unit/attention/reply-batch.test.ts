import { describe, it } from 'bun:test';
import should from 'should';
import {
  ATTENTION_REPLY_CAP_MS,
  ATTENTION_REPLY_SETTLE_MS,
  type AttentionOutbox,
  type AttentionOutboxRepository,
  AttentionReplyBatcher,
  type AttentionReplyTimers,
  attentionBatchSendId,
  attentionReplyDueAt,
  beginAttentionBatch,
  emptyAttentionOutbox,
  finishAttentionBatch,
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
    should(attentionReplyDueAt(outbox(0, 27))).equal(Date.parse(AT) + ATTENTION_REPLY_CAP_MS);
  });

  it('should keep a single answer’s send id, and name every item in a batch’s', () => {
    // Act + Assert
    should(attentionBatchSendId(SESSION, ['A3'])).equal('attention-session-1-A3');
    should(attentionBatchSendId(SESSION, ['A3', 'A7'])).equal('attention-session-1-A3-A7');
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
    should(sends.sent).deepEqual([{ message: 'one', sendId: 'attention-session-1-A1' }]);
  });

  it('should count a failed send as delivered, so an answer is never repeated', async () => {
    // Arrange
    const { batcher, sends, outboxes } = world();
    sends.failure = new Error('the ferret was removed');
    await batcher.add(SESSION, 'A1', 'one');

    // Act
    await batcher.flush(SESSION);
    await batcher.add(SESSION, 'A1', 'one again');
    await batcher.flush(SESSION);

    // Assert
    should(sends.sent).have.length(1);
    should(outboxes.files.get(SESSION)).containDeep({ pending: [], sending: [], delivered: ['A1'] });
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
    should(sends.sent).deepEqual([{ message: 'Reached you', sendId: 'attention-session-1-A6' }]);
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
    should(sends.sent[0]?.sendId.endsWith(`-A${MAX_ATTENTION_PENDING_REPLIES}`)).be.true();
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

    // Assert
    should(first).equal('A3~1');
    should(sends.sent).deepEqual([
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
