import {
  type AttentionDelivery,
  type AttentionId,
  AttentionIdSchema,
  type AttentionReplies,
  agendaBatchMessage,
  InstantSchema,
  MAX_ATTENTION_RESOLUTIONS,
} from '@ferretry/protocol';
import { z } from 'zod';
import type { SerialExecutor } from '../ports.ts';

/**
 * THE OWNER'S ANSWERS, BATCHED PER FERRET, DELIVERED ON PROOF (docs/attention.md § Delivery).
 *
 * Answering wakes the ferret: the delivered message starts its next turn, and every message is read again
 * on every later turn. One message per closed item turned five quick answers into five turns, so the
 * answers to one ferret are held in its OUTBOX — a queue of their own, apart from the owner's ordinary
 * sends — and delivered as ONE message listing every answer:
 *
 * - DEBOUNCED. The window is `settleMs` after the last card action (each further action restarts it), capped
 *   at `capMs` after the first, so a steady stream of answers still reaches the ferret.
 * - HELD WHILE THE FERRET IS MID-TURN. A batch that falls due while the ferret is working stays pending
 *   (later answers keep joining it) and is re-checked every `recheckMs`; it goes once the turn ends. The
 *   hold is bounded: `holdCeilingMs` past its due time it goes through the ordinary send path, which
 *   queues natively, so a ferret that never reports its turn over cannot hold an answer forever. A state
 *   that cannot be read is not busy.
 * - ONLY INTO AN EMPTY COMPOSER. A due batch is typed only once the ferret's composer is proven empty (a
 *   dim ghost suggestion is not text). A person's draft, or a screen that cannot be read, holds it and it
 *   is re-checked every `recheckMs`; the send path refuses the same way if a draft appears in between, and
 *   the batch simply goes back to waiting. Past `composerWaitMs` the wait gives up (below).
 * - DONE ONLY ON RECEIPT. A batch handed to the send path stays `sending` until the send ledger PROVES it
 *   in the ferret's transcript. A refusal, a proof of absence, an outcome nobody can prove, or no proof
 *   within `receiptMs` is UNDELIVERED: each item goes back to the owner as an open card saying so
 *   (`AttentionUndeliveredSink`), and the outbox forgets it, so answering it again sends it again.
 * - EXACTLY ONCE PER ITEM. An item delivered (or being delivered) is never queued again, and a batch is
 *   sent under one send id written down before it is sent, so a batch re-sent after a restart is one message.
 * - DURABLE. The outbox is a file beside the board, so a daemon restarted inside the window delivers what
 *   it held, and one restarted while a batch was in flight looks for its proof instead of forgetting it.
 * - The owner can skip the wait ("Send now"); it still never types into a non-empty composer.
 */

/** How long the outbox waits after the last answer before delivering. */
export const ATTENTION_REPLY_SETTLE_MS = 10_000;
/** The longest the first answer in a batch can wait, however many follow it. */
export const ATTENTION_REPLY_CAP_MS = 120_000;
/** How often a batch that is due but held (a working ferret, a non-empty composer, no receipt yet) looks again. */
export const ATTENTION_REPLY_RECHECK_MS = 5_000;
/** The longest a due batch is held for a working ferret before it is sent anyway. */
export const ATTENTION_REPLY_HOLD_CEILING_MS = 15 * 60_000;
/** The longest a due batch waits for the ferret's composer to be empty before it is reported undelivered. */
export const ATTENTION_REPLY_COMPOSER_WAIT_MS = 10 * 60_000;
/** The longest a sent batch waits for the transcript's proof before it is reported undelivered. */
export const ATTENTION_REPLY_RECEIPT_MS = 15 * 60_000;
/** The most answers one batch holds: a board's whole resolution history. A full outbox is sent before it takes more. */
export const MAX_ATTENTION_PENDING_REPLIES = MAX_ATTENTION_RESOLUTIONS;
/** How many delivered item ids the outbox remembers, newest kept. Ids are never reused on a board. */
const MAX_DELIVERED_IDS = 256;

/**
 * What the outbox remembers a delivery by: the item's id for an answer (`A3`), the id plus the request
 * counter for a request for more information or to discuss (`A3~2`), and `instructions~<digest>` for the
 * note that the always-on instructions changed — which belongs to no item. An item is answered once, but
 * may be asked about again after the ferret replied, and each ask is its own delivery.
 */
const ReplyKeySchema = z.string().regex(/^(A[1-9][0-9]*(~[1-9][0-9]*)?|instructions~[0-9a-f]{14})$/u);
export type ReplyKey = z.infer<typeof ReplyKeySchema>;

/** The key of one request for more information, or to discuss, on an item. */
export const needsInfoReplyKey = (id: AttentionId, request: number): ReplyKey => `${id}~${request}`;

/** The key of the note that the instructions changed to the words with this digest. */
export const instructionsReplyKey = (digest: string): ReplyKey => `instructions~${digest}`;

/** The item a key belongs to, or `undefined` for a key that is not about one. */
export const itemOfKey = (key: ReplyKey): AttentionId | undefined =>
  AttentionIdSchema.safeParse(key.split('~')[0]).data;

const PendingReplySchema = z.strictObject({
  /** A reply key (an item id for an answer); the field keeps its name so an outbox written before is read. */
  id: ReplyKeySchema,
  message: z.string().min(1),
  at: InstantSchema,
});
export type PendingReply = z.infer<typeof PendingReplySchema>;

const SendingBatchSchema = z.strictObject({
  sendId: z.string().min(1),
  ids: z.array(ReplyKeySchema).min(1).max(MAX_ATTENTION_PENDING_REPLIES),
  message: z.string().min(1),
  /** The answers it was made of, so a batch the composer refused goes back to waiting exactly as it was. */
  replies: z.array(PendingReplySchema).max(MAX_ATTENTION_PENDING_REPLIES).optional(),
  /** When the send path accepted it; from then on only the transcript's proof finishes it. */
  sentAt: InstantSchema.optional(),
});
export type SendingBatch = z.infer<typeof SendingBatchSchema>;

export const AttentionOutboxSchema = z.strictObject({
  v: z.literal(1),
  sessionId: z.string().min(1),
  pending: z.array(PendingReplySchema).max(MAX_ATTENTION_PENDING_REPLIES),
  /** Batches handed to the send path and not yet confirmed; each re-sent under its own id on start. */
  sending: z.array(SendingBatchSchema).max(MAX_ATTENTION_PENDING_REPLIES),
  delivered: z.array(ReplyKeySchema).max(MAX_DELIVERED_IDS),
});
export type AttentionOutbox = z.infer<typeof AttentionOutboxSchema>;

export function emptyAttentionOutbox(sessionId: string): AttentionOutbox {
  return { v: 1, sessionId, pending: [], sending: [], delivered: [] };
}

/** The outbox with one more delivery, or `null` when that key is already queued, sending or delivered. */
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
  return agendaBatchMessage(pending.map(each => each.message));
}

/**
 * The send id of a batch: the item ids it carries, and when it was begun. The time keeps an item answered
 * AGAIN after an undelivered first answer from reusing the send id the ledger already settled; one batch
 * keeps one id for life, because it is written down before it is sent.
 */
export function attentionBatchSendId(sessionId: string, ids: readonly ReplyKey[], begunAt?: string): string {
  const stamp = begunAt === undefined ? '' : `-${Date.parse(begunAt).toString(36)}`;
  return `attention-${sessionId}-${ids.join('-')}${stamp}`;
}

/** Moves every held answer into one batch to send, or `undefined` when nothing is held. */
export function beginAttentionBatch(
  outbox: AttentionOutbox,
  begunAt?: string,
): { readonly outbox: AttentionOutbox; readonly batch: SendingBatch } | undefined {
  if (outbox.pending.length === 0) return undefined;
  const ids = outbox.pending.map(each => each.id);
  const batch = {
    sendId: attentionBatchSendId(outbox.sessionId, ids, begunAt),
    ids,
    message: attentionBatchMessage(outbox.pending),
    replies: outbox.pending,
  };
  return {
    outbox: { ...outbox, pending: [], sending: [...outbox.sending, batch].slice(-MAX_ATTENTION_PENDING_REPLIES) },
    batch,
  };
}

/** Records a batch as handed to the send path: from now on only a receipt (or its absence) settles it. */
export function sentAttentionBatch(outbox: AttentionOutbox, sendId: string, at: string): AttentionOutbox {
  return {
    ...outbox,
    sending: outbox.sending.map(batch => (batch.sendId === sendId ? { ...batch, sentAt: at } : batch)),
  };
}

/**
 * Puts a batch nothing was typed for back to waiting, ahead of anything held since, keeping each answer's
 * own time so the window it already waited out is not waited again.
 */
export function returnAttentionBatch(outbox: AttentionOutbox, batch: SendingBatch): AttentionOutbox {
  const back = (batch.replies ?? []).filter(reply => !outbox.pending.some(each => each.id === reply.id));
  return {
    ...outbox,
    sending: outbox.sending.filter(each => each.sendId !== batch.sendId),
    pending: [...back, ...outbox.pending].slice(0, MAX_ATTENTION_PENDING_REPLIES),
  };
}

/** Forgets a batch that did not arrive: its items may be queued again when the owner answers again. */
export function dropAttentionBatch(outbox: AttentionOutbox, batch: SendingBatch): AttentionOutbox {
  return { ...outbox, sending: outbox.sending.filter(each => each.sendId !== batch.sendId) };
}

/** Forgets held answers that did not arrive, by key. */
export function dropPendingReplies(outbox: AttentionOutbox, keys: readonly ReplyKey[]): AttentionOutbox {
  return { ...outbox, pending: outbox.pending.filter(each => !keys.includes(each.id)) };
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

/**
 * Thrown by a messenger when NOTHING was typed and the same batch may simply be tried again later: the
 * composer held a person's draft, could not be read, or the ferret is still starting.
 */
export class AttentionNotTyped extends Error {
  override readonly name = 'AttentionNotTyped';
}

/** A queued, non-interrupting message to a ferret, idempotent under its send id. */
export interface AttentionMessenger {
  /**
   * Resolves once the send path has ACCEPTED the message — not once it arrived. Rejects with
   * `AttentionNotTyped` when nothing was typed and it may be tried again, and with any other error when the
   * send was refused outright.
   */
  send(sessionId: string, message: string, sendId: string): Promise<void>;
}

/** What the ferret's composer holds: nothing (a dim ghost suggestion is nothing), text, or no reading. */
export type AttentionComposerState = 'empty' | 'occupied' | 'unreadable';

/** Reads the ferret's composer before anything is typed into it. */
export interface AttentionComposer {
  state(sessionId: string): Promise<AttentionComposerState>;
}

/** What the send ledger can prove about a batch it accepted. */
export type AttentionReceipt =
  | { readonly state: 'delivered' }
  | { readonly state: 'pending' }
  | { readonly state: 'failed'; readonly reason: string };

/** The send ledger's account of one send: delivered only when the transcript holds it. */
export interface AttentionReceipts {
  receipt(sessionId: string, sendId: string): Promise<AttentionReceipt>;
}

/** Hands an answer that never arrived back to the owner, as an open card that says so. Total. */
export interface AttentionUndeliveredSink {
  undelivered(sessionId: string, key: ReplyKey, reason: string): Promise<void>;
}

/** One pending delivery per key; scheduling a key again replaces it. */
export interface AttentionReplyTimers {
  schedule(key: string, delayMs: number, task: () => void): void;
  cancel(key: string): void;
}

/** Where an answer to a ferret's item is handed to be delivered. */
export interface AttentionReplyQueue {
  add(sessionId: string, key: ReplyKey, message: string): Promise<void>;
}

/** Whether a ferret is mid-turn, so a batch is not dropped into the turn it would be re-read on. */
export interface AttentionFerretActivity {
  /** `true` while the ferret is working; `false` for anything else, including a state that cannot be read. */
  busy(sessionId: string): Promise<boolean>;
}

/** How long the outbox waits, and how it holds a due batch. */
export interface AttentionReplyWindow {
  readonly settleMs: number;
  readonly capMs: number;
  readonly recheckMs?: number;
  readonly holdCeilingMs?: number;
  readonly composerWaitMs?: number;
  readonly receiptMs?: number;
}

/** How a batch reaches the ferret on proof: the composer it waits on, the receipts it reads, where failures go. */
export interface AttentionDeliveryPorts {
  readonly composer: AttentionComposer;
  readonly receipts: AttentionReceipts;
  readonly undelivered: AttentionUndeliveredSink;
}

/** The outbox's state for the owner's screen, and the owner skipping the wait. */
export interface AttentionRepliesSubsystem {
  /** The answers held for this ferret and when they go, or `undefined` when nothing is held. */
  pending(sessionId: string): Promise<AttentionReplies | undefined>;
  /** The answers on their way and not yet proven to arrive, or `undefined` when there are none. */
  delivery(sessionId: string): Promise<AttentionDelivery | undefined>;
  /** Delivers what is held now. Returns once the batch is taken; the send itself is detached. */
  sendNow(sessionId: string): Promise<void>;
}

/** Ports that never hold anything back: an empty composer, every send delivered, nothing to report. */
const TRUSTING_DELIVERY: AttentionDeliveryPorts = {
  composer: { state: async () => 'empty' },
  receipts: { receipt: async () => ({ state: 'delivered' }) },
  undelivered: { undelivered: async () => undefined },
};

/** The words an undelivered card carries, by why it failed. */
const COMPOSER_REASON: Readonly<Record<Exclude<AttentionComposerState, 'empty'>, string>> = {
  occupied: 'the ferret’s message box held unsent text the whole time',
  unreadable: 'the ferret’s screen could not be read to prove its message box empty',
};

/**
 * Holds each ferret's answers for the settle window, delivers them as one message into an empty composer,
 * and counts them delivered only on the transcript's proof.
 *
 * The send is awaited OUTSIDE the session's lock: it may wait for a launch or revive a stopped ferret,
 * and the owner's next answer must not wait on that. The batch is written down as `sending` before it
 * is sent and marked `sentAt` once accepted, so a restart in between re-sends it under the same send id
 * — which the send ledger keeps as one message — and a restart after looks for its receipt.
 */
export class AttentionReplyBatcher implements AttentionReplyQueue, AttentionRepliesSubsystem {
  /** Ferrets whose due answers are waiting for an empty composer, for the owner's screen. */
  readonly #heldForComposer = new Set<string>();

  constructor(
    private readonly outboxes: AttentionOutboxRepository,
    private readonly messenger: AttentionMessenger,
    private readonly timers: AttentionReplyTimers,
    private readonly serial: Pick<SerialExecutor, 'run'>,
    private readonly clock: { now(): string },
    private readonly window: AttentionReplyWindow = {
      settleMs: ATTENTION_REPLY_SETTLE_MS,
      capMs: ATTENTION_REPLY_CAP_MS,
    },
    private readonly activity: AttentionFerretActivity = { busy: async () => false },
    private readonly ports: AttentionDeliveryPorts = TRUSTING_DELIVERY,
  ) {}

  async add(sessionId: string, key: ReplyKey, message: string): Promise<void> {
    const { due, full } = await this.locked(sessionId, async current => {
      // A full outbox is sent first, so the answer that would overflow it is never the one lost.
      const begun =
        current.pending.length >= MAX_ATTENTION_PENDING_REPLIES
          ? beginAttentionBatch(current, this.clock.now())
          : undefined;
      const outbox = begun?.outbox ?? current;
      const next = withPendingReply(outbox, { id: key, message, at: this.clock.now() });
      if (next !== null || begun !== undefined) await this.outboxes.write(next ?? outbox);
      return { due: this.dueAt(next ?? outbox), full: begun?.batch };
    });
    if (full !== undefined) void this.deliver(sessionId, full);
    this.schedule(sessionId, due);
  }

  async pending(sessionId: string): Promise<AttentionReplies | undefined> {
    const outbox = (await this.outboxes.read(sessionId)) ?? emptyAttentionOutbox(sessionId);
    const due = this.dueAt(outbox);
    const items = itemsOf(outbox.pending.map(each => each.id));
    if (due === undefined || items.length === 0) return undefined;
    return {
      pending: items,
      dueAt: new Date(due).toISOString(),
      ...((await this.heldForTurn(sessionId, outbox)) ? { heldForTurn: true as const } : {}),
    };
  }

  async delivery(sessionId: string): Promise<AttentionDelivery | undefined> {
    const outbox = (await this.outboxes.read(sessionId)) ?? emptyAttentionOutbox(sessionId);
    const sending = itemsOf(outbox.sending.flatMap(batch => batch.ids));
    const held = this.#heldForComposer.has(sessionId) && outbox.pending.length > 0;
    if (sending.length === 0 && !held) return undefined;
    return { sending, ...(held ? { heldForComposer: true as const } : {}) };
  }

  async sendNow(sessionId: string): Promise<void> {
    this.timers.cancel(sessionId);
    const batch = await this.begin(sessionId);
    if (batch !== undefined) void this.deliver(sessionId, batch);
  }

  /**
   * Delivers what is held for one ferret, unless it is mid-turn or its composer is not empty; what the timer
   * runs once the window closes (each key has one timer, so an answer that restarted the window replaced it).
   */
  async flush(sessionId: string): Promise<void> {
    const outbox = await this.outboxes.read(sessionId);
    if (outbox === null || outbox.pending.length === 0) return;
    const now = Date.parse(this.clock.now());
    if (await this.heldForTurn(sessionId, outbox)) return this.recheck(sessionId);
    const composer = await this.ports.composer.state(sessionId).catch(() => 'unreadable' as const);
    if (composer !== 'empty') {
      if (now < this.composerDeadline(outbox)) {
        this.#heldForComposer.add(sessionId);
        return this.recheck(sessionId);
      }
      this.#heldForComposer.delete(sessionId);
      return await this.giveUp(sessionId, COMPOSER_REASON[composer]);
    }
    this.#heldForComposer.delete(sessionId);
    const batch = await this.begin(sessionId);
    if (batch !== undefined) await this.deliver(sessionId, batch);
  }

  /**
   * Looks for the proof of every batch this ferret has in flight: delivered finishes it, a failure or no
   * proof in time hands its items back to the owner, anything else is looked at again shortly.
   */
  async watch(sessionId: string): Promise<void> {
    const outbox = await this.outboxes.read(sessionId);
    if (outbox === null) return;
    let waiting = false;
    for (const batch of outbox.sending) {
      if (batch.sentAt === undefined) continue;
      const receipt = await this.ports.receipts
        .receipt(sessionId, batch.sendId)
        .catch((): AttentionReceipt => ({ state: 'pending' }));
      if (receipt.state === 'delivered') {
        await this.locked(sessionId, async current => await this.outboxes.write(finishAttentionBatch(current, batch)));
      } else if (receipt.state === 'failed') {
        await this.fail(sessionId, batch, receipt.reason);
      } else if (Date.parse(this.clock.now()) >= Date.parse(batch.sentAt) + this.receiptMs()) {
        await this.fail(sessionId, batch, 'the ferret’s transcript never showed it arriving');
      } else {
        waiting = true;
      }
    }
    if (waiting) this.watchLater(sessionId);
  }

  /**
   * At start: re-sends any batch a restart interrupted before it was accepted, looks for the proof of every
   * batch already accepted, and re-arms each held window — delivering at once what fell due while the
   * daemon was down. Each ferret on its own.
   */
  async resume(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      await (async () => {
        const outbox = await this.outboxes.read(sessionId);
        if (outbox === null) return;
        for (const batch of outbox.sending) if (batch.sentAt === undefined) await this.deliver(sessionId, batch);
        if (outbox.sending.some(batch => batch.sentAt !== undefined)) this.watchLater(sessionId, 0);
        this.schedule(sessionId, this.dueAt(outbox));
      })().catch(() => undefined);
    }
  }

  private async begin(sessionId: string): Promise<SendingBatch | undefined> {
    return await this.locked(sessionId, async outbox => {
      const begun = beginAttentionBatch(outbox, this.clock.now());
      if (begun === undefined) return undefined;
      await this.outboxes.write(begun.outbox);
      return begun.batch;
    });
  }

  private async deliver(sessionId: string, batch: SendingBatch): Promise<void> {
    try {
      await this.messenger.send(sessionId, batch.message, batch.sendId);
    } catch (error) {
      if (error instanceof AttentionNotTyped && batch.replies !== undefined) {
        // Nothing was typed: the batch goes back to waiting for an empty composer, under a fresh id next time.
        await this.locked(sessionId, async outbox => await this.outboxes.write(returnAttentionBatch(outbox, batch)));
        return this.recheck(sessionId);
      }
      return await this.fail(sessionId, batch, error instanceof Error ? error.message : 'the send was refused');
    }
    await this.locked(sessionId, async outbox => {
      await this.outboxes.write(sentAttentionBatch(outbox, batch.sendId, this.clock.now()));
    });
    this.watchLater(sessionId);
  }

  /** Forgets a batch that did not arrive, then tells the board each of its items is the owner's again. */
  private async fail(sessionId: string, batch: SendingBatch, reason: string): Promise<void> {
    await this.locked(sessionId, async outbox => await this.outboxes.write(dropAttentionBatch(outbox, batch)));
    await this.report(sessionId, batch.ids, reason);
  }

  /** The composer never emptied in time: every held answer goes back to the owner. */
  private async giveUp(sessionId: string, reason: string): Promise<void> {
    const keys = await this.locked(sessionId, async outbox => {
      const held = outbox.pending.map(each => each.id);
      await this.outboxes.write(dropPendingReplies(outbox, held));
      return held;
    });
    await this.report(sessionId, keys, reason);
  }

  private async report(sessionId: string, keys: readonly ReplyKey[], reason: string): Promise<void> {
    for (const key of keys) await this.ports.undelivered.undelivered(sessionId, key, reason).catch(() => undefined);
  }

  private schedule(sessionId: string, due: number | undefined): void {
    if (due === undefined) return;
    const delay = Math.max(0, due - Date.parse(this.clock.now()));
    this.timers.schedule(sessionId, delay, () => void this.flush(sessionId).catch(() => undefined));
  }

  private recheck(sessionId: string): void {
    this.timers.schedule(sessionId, this.recheckMs(), () => void this.flush(sessionId).catch(() => undefined));
  }

  private watchLater(sessionId: string, delayMs = this.recheckMs()): void {
    this.timers.schedule(receiptTimer(sessionId), delayMs, () => void this.watch(sessionId).catch(() => undefined));
  }

  /** Due, still inside the hold's ceiling, and the ferret is working: the batch waits for the turn to end. */
  private async heldForTurn(sessionId: string, outbox: AttentionOutbox): Promise<boolean> {
    const due = this.dueAt(outbox);
    if (due === undefined) return false;
    const now = Date.parse(this.clock.now());
    if (now < due || now >= due + (this.window.holdCeilingMs ?? ATTENTION_REPLY_HOLD_CEILING_MS)) return false;
    return await this.activity.busy(sessionId).catch(() => false);
  }

  /**
   * When waiting for an empty composer gives up: `composerWaitMs` past the latest the batch could have been
   * due (its first answer plus the cap), so a burst of answers does not shorten it.
   */
  private composerDeadline(outbox: AttentionOutbox): number {
    const first = outbox.pending[0];
    const start = first === undefined ? Date.parse(this.clock.now()) : Date.parse(first.at) + this.window.capMs;
    return start + (this.window.composerWaitMs ?? ATTENTION_REPLY_COMPOSER_WAIT_MS);
  }

  private recheckMs(): number {
    return this.window.recheckMs ?? ATTENTION_REPLY_RECHECK_MS;
  }

  private receiptMs(): number {
    return this.window.receiptMs ?? ATTENTION_REPLY_RECEIPT_MS;
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

/** The timer key a ferret's receipt watch runs under, apart from its window's. */
const receiptTimer = (sessionId: string): string => `${sessionId}#receipt`;

/** The distinct items a list of reply keys is about, in order. */
const itemsOf = (keys: readonly ReplyKey[]): AttentionId[] => [...new Set(keys.flatMap(key => itemOfKey(key) ?? []))];
