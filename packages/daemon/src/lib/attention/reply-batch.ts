import {
  type AttentionId,
  AttentionIdSchema,
  type AttentionReplies,
  InstantSchema,
  MAX_ATTENTION_RESOLUTIONS,
} from '@ferretry/protocol';
import { z } from 'zod';
import type { SerialExecutor } from '../ports.ts';

/**
 * THE OWNER'S ANSWERS, BATCHED PER FERRET (docs/attention.md § The loop).
 *
 * Answering wakes the ferret: the delivered message starts its next turn. One message per closed item
 * turned five quick answers into five turns, so the answers to one ferret are held in its OUTBOX for a
 * short settle window and delivered as ONE message listing every answer:
 *
 * - The window is `settleMs` after the last answer, capped at `capMs` after the first, so a steady
 *   stream of answers still reaches the ferret.
 * - EXACTLY ONCE PER ITEM. An item delivered (or being delivered) is never queued again, and a batch is
 *   sent under a send id made of its item ids, so a batch re-sent after a restart is one message.
 * - DURABLE. The outbox is a file beside the board, so a daemon restarted inside the window delivers
 *   what it held instead of forgetting the owner's answer.
 * - The owner can skip the wait ("Send now").
 */

/** How long the outbox waits after the last answer before delivering. */
export const ATTENTION_REPLY_SETTLE_MS = 8_000;
/** The longest the first answer in a batch can wait, however many follow it. */
export const ATTENTION_REPLY_CAP_MS = 30_000;
/** The most answers one batch holds: a board's whole resolution history. A full outbox is sent before it takes more. */
export const MAX_ATTENTION_PENDING_REPLIES = MAX_ATTENTION_RESOLUTIONS;
/** How many delivered item ids the outbox remembers, newest kept. Ids are never reused on a board. */
const MAX_DELIVERED_IDS = 256;

const PendingReplySchema = z.strictObject({
  id: AttentionIdSchema,
  message: z.string().min(1),
  at: InstantSchema,
});
export type PendingReply = z.infer<typeof PendingReplySchema>;

const SendingBatchSchema = z.strictObject({
  sendId: z.string().min(1),
  ids: z.array(AttentionIdSchema).min(1).max(MAX_ATTENTION_PENDING_REPLIES),
  message: z.string().min(1),
});
export type SendingBatch = z.infer<typeof SendingBatchSchema>;

export const AttentionOutboxSchema = z.strictObject({
  v: z.literal(1),
  sessionId: z.string().min(1),
  pending: z.array(PendingReplySchema).max(MAX_ATTENTION_PENDING_REPLIES),
  /** Batches handed to the send path and not yet confirmed; each re-sent under its own id on start. */
  sending: z.array(SendingBatchSchema).max(MAX_ATTENTION_PENDING_REPLIES),
  delivered: z.array(AttentionIdSchema).max(MAX_DELIVERED_IDS),
});
export type AttentionOutbox = z.infer<typeof AttentionOutboxSchema>;

export function emptyAttentionOutbox(sessionId: string): AttentionOutbox {
  return { v: 1, sessionId, pending: [], sending: [], delivered: [] };
}

/** The outbox with one more answer, or `null` when that item is already queued, sending or delivered. */
export function withPendingReply(outbox: AttentionOutbox, reply: PendingReply): AttentionOutbox | null {
  const known =
    outbox.delivered.includes(reply.id) ||
    outbox.pending.some(each => each.id === reply.id) ||
    outbox.sending.some(batch => batch.ids.includes(reply.id));
  return known ? null : { ...outbox, pending: [...outbox.pending, reply] };
}

/** When the held answers are due, in epoch milliseconds, or `undefined` when nothing is held. */
export function attentionReplyDueAt(
  outbox: AttentionOutbox,
  settleMs = ATTENTION_REPLY_SETTLE_MS,
  capMs = ATTENTION_REPLY_CAP_MS,
): number | undefined {
  const first = outbox.pending[0];
  const last = outbox.pending.at(-1);
  if (first === undefined || last === undefined) return undefined;
  return Math.min(Date.parse(last.at) + settleMs, Date.parse(first.at) + capMs);
}

/**
 * The one message a batch is delivered as: each answer in the form every ferret is taught
 * (`[answer to !A3 «ask»] …`), in the order the owner gave them, a blank line apart. One answer reads
 * exactly as it did before batching.
 */
export function attentionBatchMessage(pending: readonly PendingReply[]): string {
  return pending.map(each => each.message).join('\n\n');
}

/**
 * The send id of a batch: the item ids it carries. A batch of one keeps the id a single answer always
 * had (`attention-<session>-<id>`), so an answer sent before batching existed is not sent again.
 */
export function attentionBatchSendId(sessionId: string, ids: readonly AttentionId[]): string {
  return `attention-${sessionId}-${ids.join('-')}`;
}

/** Moves every held answer into one batch to send, or `undefined` when nothing is held. */
export function beginAttentionBatch(
  outbox: AttentionOutbox,
): { readonly outbox: AttentionOutbox; readonly batch: SendingBatch } | undefined {
  if (outbox.pending.length === 0) return undefined;
  const ids = outbox.pending.map(each => each.id);
  const batch = {
    sendId: attentionBatchSendId(outbox.sessionId, ids),
    ids,
    message: attentionBatchMessage(outbox.pending),
  };
  return {
    outbox: { ...outbox, pending: [], sending: [...outbox.sending, batch].slice(-MAX_ATTENTION_PENDING_REPLIES) },
    batch,
  };
}

/** Records a batch as delivered: its items are never queued again. */
export function finishAttentionBatch(outbox: AttentionOutbox, batch: SendingBatch): AttentionOutbox {
  const delivered = [...outbox.delivered.filter(id => !batch.ids.includes(id)), ...batch.ids];
  return {
    ...outbox,
    sending: outbox.sending.filter(each => each.sendId !== batch.sendId),
    delivered: delivered.slice(-MAX_DELIVERED_IDS),
  };
}

/** Where each ferret's outbox is kept. */
export interface AttentionOutboxRepository {
  read(sessionId: string): Promise<AttentionOutbox | null>;
  write(outbox: AttentionOutbox): Promise<void>;
}

/** A queued, non-interrupting message to a ferret, idempotent under its send id. */
export interface AttentionMessenger {
  send(sessionId: string, message: string, sendId: string): Promise<void>;
}

/** One pending delivery per key; scheduling a key again replaces it. */
export interface AttentionReplyTimers {
  schedule(key: string, delayMs: number, task: () => void): void;
  cancel(key: string): void;
}

/** Where an answer to a ferret's item is handed to be delivered. */
export interface AttentionReplyQueue {
  add(sessionId: string, id: AttentionId, message: string): Promise<void>;
}

/** The outbox's state for the owner's screen, and the owner skipping the wait. */
export interface AttentionRepliesSubsystem {
  /** The answers held for this ferret and when they go, or `undefined` when nothing is held. */
  pending(sessionId: string): Promise<AttentionReplies | undefined>;
  /** Delivers what is held now. Returns once the batch is taken; the send itself is detached. */
  sendNow(sessionId: string): Promise<void>;
}

/**
 * Holds each ferret's answers for the settle window and delivers them as one message.
 *
 * The send is awaited OUTSIDE the session's lock: it may wait for a launch or revive a stopped ferret,
 * and the owner's next answer must not wait on that. The batch is written down as `sending` before it
 * is sent and cleared after, so a restart in between re-sends it under the same send id — which the
 * send ledger keeps as one message. A send that fails is recorded as delivered all the same: the send
 * ledger is where its fate is told, and repeating an answer is worse than the ledger's account of it.
 */
export class AttentionReplyBatcher implements AttentionReplyQueue, AttentionRepliesSubsystem {
  constructor(
    private readonly outboxes: AttentionOutboxRepository,
    private readonly messenger: AttentionMessenger,
    private readonly timers: AttentionReplyTimers,
    private readonly serial: Pick<SerialExecutor, 'run'>,
    private readonly clock: { now(): string },
    private readonly window: { readonly settleMs: number; readonly capMs: number } = {
      settleMs: ATTENTION_REPLY_SETTLE_MS,
      capMs: ATTENTION_REPLY_CAP_MS,
    },
  ) {}

  async add(sessionId: string, id: AttentionId, message: string): Promise<void> {
    const { due, full } = await this.locked(sessionId, async current => {
      // A full outbox is sent first, so the answer that would overflow it is never the one lost.
      const begun = current.pending.length >= MAX_ATTENTION_PENDING_REPLIES ? beginAttentionBatch(current) : undefined;
      const outbox = begun?.outbox ?? current;
      const next = withPendingReply(outbox, { id, message, at: this.clock.now() });
      if (next !== null || begun !== undefined) await this.outboxes.write(next ?? outbox);
      return { due: this.dueAt(next ?? outbox), full: begun?.batch };
    });
    if (full !== undefined) void this.deliver(sessionId, full);
    this.schedule(sessionId, due);
  }

  async pending(sessionId: string): Promise<AttentionReplies | undefined> {
    const outbox = (await this.outboxes.read(sessionId)) ?? emptyAttentionOutbox(sessionId);
    const due = this.dueAt(outbox);
    if (due === undefined) return undefined;
    return { pending: outbox.pending.map(each => each.id), dueAt: new Date(due).toISOString() };
  }

  async sendNow(sessionId: string): Promise<void> {
    this.timers.cancel(sessionId);
    const batch = await this.begin(sessionId);
    if (batch !== undefined) void this.deliver(sessionId, batch);
  }

  /** Delivers what is held for one ferret; what the timer runs. */
  async flush(sessionId: string): Promise<void> {
    const batch = await this.begin(sessionId);
    if (batch !== undefined) await this.deliver(sessionId, batch);
  }

  /**
   * At start: re-sends any batch a restart interrupted, and re-arms each held window — delivering at
   * once what fell due while the daemon was down. Each ferret on its own.
   */
  async resume(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      await (async () => {
        const outbox = await this.outboxes.read(sessionId);
        if (outbox === null) return;
        for (const batch of outbox.sending) await this.deliver(sessionId, batch);
        this.schedule(sessionId, this.dueAt(outbox));
      })().catch(() => undefined);
    }
  }

  private async begin(sessionId: string): Promise<SendingBatch | undefined> {
    return await this.locked(sessionId, async outbox => {
      const begun = beginAttentionBatch(outbox);
      if (begun === undefined) return undefined;
      await this.outboxes.write(begun.outbox);
      return begun.batch;
    });
  }

  private async deliver(sessionId: string, batch: SendingBatch): Promise<void> {
    await this.messenger.send(sessionId, batch.message, batch.sendId).catch(() => undefined);
    await this.locked(sessionId, async outbox => {
      await this.outboxes.write(finishAttentionBatch(outbox, batch));
    });
  }

  private schedule(sessionId: string, due: number | undefined): void {
    if (due === undefined) return;
    const delay = Math.max(0, due - Date.parse(this.clock.now()));
    this.timers.schedule(sessionId, delay, () => void this.flush(sessionId).catch(() => undefined));
  }

  private dueAt(outbox: AttentionOutbox): number | undefined {
    return attentionReplyDueAt(outbox, this.window.settleMs, this.window.capMs);
  }

  private async locked<T>(sessionId: string, work: (outbox: AttentionOutbox) => Promise<T>): Promise<T> {
    return await this.serial.run(`attention-replies:${sessionId}`, async () =>
      work((await this.outboxes.read(sessionId)) ?? emptyAttentionOutbox(sessionId)),
    );
  }
}
