import type { QueuedMessage, QueueWaitReason } from '../../seams/protocol.ts';
import type { ClockPort, SerialExecutor } from '../../seams/ports.ts';
import type { SessionId } from '../../seams/ferret-id.ts';
import type { SendScheduler } from '../../delivery/lib/tracker.ts';
import type { SendFate } from '../../delivery/lib/types.ts';
import { type DeliveryView, type HandOver, movesFrom, type OwnDraft, reasonForWaiting } from './delivery.ts';
import { foldQueue, type QueueEvent } from './model.ts';
import { deliveryOrder, planDelivery } from './policy.ts';
import type { SessionQueueStore } from './ports.ts';
import { defaultQueueCoalesceSettings, type QueueCoalesceSettings } from './settings.ts';

/**
 * THE ONE OWNER OF DELIVERY for a session's queue: it decides WHEN a message goes and IN WHAT ORDER, and
 * hands each one, under its own id, to the tracked send path that knows HOW to type into a harness and
 * keep the session's turn record straight.
 *
 * ONE AT A TIME. A message is marked `typing` on disk BEFORE it is handed over, and nothing else is handed
 * over while one is. A daemon that dies in between leaves a `typing` message, and the send ledger — keyed
 * by the same id — says on the next look whether a key ever went: no record means none did, and it waits
 * again; a record says where it went. Nothing is ever typed twice on a guess. A record still `accepted` long
 * after its hand-over is the send tracker's to settle, and the tracker is asked to look (`recheckMs`).
 *
 * EVENT-DRIVEN. A session is looked at when a message is enqueued, when its state document changes (a
 * turn moving, a dialog opening), and — while something in it is still waiting or unproven — again after
 * `lookMs`, since a person clearing a draft writes nothing the daemon hears. A session with nothing open
 * is not looked at at all.
 *
 * BOTH HARNESSES, ONE RULE. Claude Code holds text typed mid-turn in its own queue, which the pane shows,
 * so the hand-over is proven at once. Codex steers it straight into the running turn and shows nothing
 * (measured on 0.163), so the hand-over is unproven: the message stays `typing`, nothing else is typed
 * behind it, and Codex's transcript — through the send ledger — moves it on within seconds.
 */

/**
 * What one hand-over carries: ONE queued message, or several ferret messages delivered as one turn.
 *
 * `sendId` is the id the send ledger records the delivery under — the OLDEST member's own id, so the
 * ledger row, `fy send --wait` for that id and every consumer keyed by it work as they always did. A single
 * message is a delivery of one member whose `sendId` is its own id.
 */
export interface QueueDelivery {
  readonly sendId: string;
  /** Oldest first, in acceptance order. Never empty; two or more are all a ferret's. */
  readonly members: readonly QueuedMessage[];
}

/** The send path, as delivery uses it. */
export interface QueueTransport {
  /**
   * Hands one delivery to the pane under `delivery.sendId`; says what the pane proved.
   *
   * This is the ONE place queued messages become a delivery: the banner, the combined format, the
   * direct-or-turn-file rule (`isDirectSend`) and the landing proof all sit behind it. The outcome applies
   * to EVERY member.
   */
  handOver(id: SessionId, delivery: QueueDelivery): Promise<HandOver>;
  /** Where a message handed over before now stands, per the send ledger; `undefined` when it never got there. */
  fate(id: SessionId, messageId: string): Promise<SendFate | undefined>;
  /**
   * The composer holds text: finishes it when it is a send of this session's own left unsubmitted — one
   * verified, counted Enter — and says whose it is (`OwnDraft`).
   */
  clearOwnDraft(id: SessionId): Promise<OwnDraft>;
  /**
   * Has the send tracker look at this session's sends now: the one look that can prove where an `accepted`
   * hand-over went, and type it again once it is proven absent. The look keeps every rule it always has.
   */
  recheck(id: SessionId): Promise<void>;
}

export interface QueueDeliveryPorts {
  readonly store: SessionQueueStore;
  /** The queue's own per-session lock, never the send path's: the hand-over takes that one. */
  readonly serial: SerialExecutor;
  readonly clock: ClockPort;
  /** One pending look per session; scheduling again replaces it. */
  readonly scheduler: SendScheduler;
  /** The session as delivery reads it before typing. Throws when its pane cannot be read. */
  view(id: SessionId): Promise<DeliveryView>;
  readonly transport: QueueTransport;
  /** Every session this daemon holds, for the look a restart owes the messages it left open. */
  sessions(): readonly SessionId[];
  /** Waiting is a capability, not a decision: the composition root owns how this process sleeps. */
  sleep(milliseconds: number): Promise<void>;
}

export interface QueueDeliverySettings extends QueueCoalesceSettings {
  /** How soon a session with a message waiting or unproven is looked at again. */
  readonly lookMs: number;
  /** How long a delivered message is watched for its read tick before the session stops being looked at. */
  readonly readWatchMs: number;
  /** Messages handed over in one look, so a long queue cannot hold the lock for ever. */
  readonly perLook: number;
  /** The longest a stopping daemon waits for the hand-overs already in flight. */
  readonly drainMs: number;
  /**
   * How long a message may sit `typing` behind an `accepted` send before the tracker is asked to look at it,
   * and how often it is asked again while it stays there (&B153).
   */
  readonly recheckMs: number;
}

export const defaultQueueDeliverySettings: QueueDeliverySettings = {
  ...defaultQueueCoalesceSettings,
  lookMs: 5_000,
  readWatchMs: 60 * 60_000,
  perLook: 8,
  drainMs: 15_000,
  recheckMs: 60_000,
};

export class QueueDeliverer {
  /** Sessions with something open, the only ones a state change makes this look at. */
  private readonly open = new Set<SessionId>();
  /** The looks running now, which a stopping daemon waits out. */
  private readonly running = new Set<Promise<void>>();
  /** When each session's tracker was last asked to look at a hand-over stuck `accepted`. */
  private readonly rechecked = new Map<SessionId, number>();
  /**
   * Sessions whose last hand-over found no prompt: when, the reason the queue waits on meanwhile, and whether
   * the record's own readiness flag was already true at the refusal (`staleReady`) — a flag that still
   * says "ready" for a pane that showed none is the very thing that was refused, not a new prompt.
   */
  private readonly promptless = new Map<
    SessionId,
    { readonly at: number; readonly reason: QueueWaitReason; staleReady: boolean }
  >();
  private stopped = false;

  constructor(
    private readonly ports: QueueDeliveryPorts,
    private readonly settings: QueueDeliverySettings = defaultQueueDeliverySettings,
  ) {}

  /** Looks at every session once, so what a restart left open moves again. */
  async arm(): Promise<void> {
    for (const id of this.ports.sessions()) await this.look(id).catch(() => undefined);
  }

  /**
   * Starts no look again, and waits — up to `drainMs` — for the ones running to finish.
   *
   * A send now answers once its message is on disk and the deliverer types it a moment later, so a
   * daemon stopped right after a send was cutting the hand-over in half: the send ledger had the message
   * accepted and the pane never had it. A look that has begun is let finish, so what was being typed is
   * typed; one scheduled for later is the next daemon's.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.ports.scheduler.cancelAll();
    if (this.running.size === 0) return;
    await Promise.race([Promise.allSettled([...this.running]), this.ports.sleep(this.settings.drainMs)]);
  }

  /** A message was just enqueued for this session: look now. */
  async enqueued(id: SessionId): Promise<void> {
    this.open.add(id);
    await this.look(id);
  }

  /** Something about this session changed. Looked at only when it has something open. */
  async changed(id: SessionId): Promise<void> {
    if (this.open.has(id)) await this.look(id);
  }

  /** One look at a session's queue: settle what was handed over, then hand over what may go. */
  async look(id: SessionId): Promise<void> {
    if (this.stopped) return;
    const running = this.ports.serial.run(id, async () => await this.lookLocked(id));
    this.running.add(running);
    try {
      await running;
    } finally {
      this.running.delete(running);
    }
  }

  private async lookLocked(id: SessionId): Promise<void> {
    await this.settle(id);
    let more = true;
    for (let handed = 0; more && handed < this.settings.perLook; handed += 1)
      more = await this.handOverNext(id, await this.messages(id));
    // Looked at again only for what can still move without anybody enqueueing: a message waiting for a
    // reason, one handed over and not yet proven, one delivered and not yet read — or a queue longer
    // than one look hands over — and, for a message held to combine with others, the moment its hold ends.
    // The scheduler keeps ONE pending look per session, so the soonest of the two reasons is the one asked for.
    const remaining = await this.messages(id);
    const now = Date.parse(this.ports.clock.now());
    const polls = more || remaining.some(message => this.unsettled(message));
    const holdEndsIn = this.earliestHold(remaining, now);
    if (polls || holdEndsIn !== undefined) {
      this.open.add(id);
      const delay = polls
        ? Math.min(this.settings.lookMs, holdEndsIn ?? Infinity)
        : (holdEndsIn ?? this.settings.lookMs);
      this.ports.scheduler.schedule(id, delay, () => void this.look(id).catch(() => undefined));
    } else this.open.delete(id);
  }

  /** Milliseconds until the soonest hold on a still-waiting ferret message ends; `undefined` when none is held. */
  private earliestHold(messages: readonly QueuedMessage[], now: number): number | undefined {
    // A hold already over is not a reason to wake: that message is waiting on something else, which has its own.
    const ends = messages
      .flatMap(message =>
        message.state === 'queued' && message.sender === 'agent' && message.holdUntil !== undefined
          ? [Date.parse(message.holdUntil) - now]
          : [],
      )
      .filter(remaining => remaining > 0);
    return ends.length === 0 ? undefined : Math.min(...ends);
  }

  /** Brings every message already handed over up to what the send ledger proves. */
  private async settle(id: SessionId): Promise<void> {
    let stalled = false;
    const now = Date.parse(this.ports.clock.now());
    for (const message of await this.messages(id)) {
      if (message.state !== 'typing' && message.state !== 'delivered' && message.state !== 'unconfirmed') continue;
      // A member of a combined turn is proven by the ONE ledger record the turn was sent under.
      const fate = await this.ports.transport.fate(id, message.deliveredAs ?? message.id);
      for (const move of movesFrom(message, fate)) await this.move(id, message.id, move.state, move.failure);
      if (
        message.state === 'typing' &&
        fate === 'accepted' &&
        now - Date.parse(message.stateAt) >= this.settings.recheckMs
      )
        stalled = true;
    }
    if (stalled) this.recheck(id, now);
    else this.rechecked.delete(id);
  }

  /**
   * Asks the tracker to look at a hand-over that has sat `accepted` too long, at most once per `recheckMs`.
   *
   * Only the tracker moves an `accepted` send, and it moves one only when a look is scheduled for it. A
   * hand-over that threw used to schedule none, so its message sat `typing` and every message behind it
   * waited, with no reason given, until a restart or a `fy send --wait` happened to make the tracker look
   * (&B153). The look is the tracker's own: transcript proof wins, and only a send proven absent is typed
   * again. Not awaited: the tracker's look takes the send path's lock, and this look holds the queue's.
   */
  private recheck(id: SessionId, now: number): void {
    // A stopping daemon starts no tracker look: one begun now could type after the tracker was disarmed.
    if (this.stopped) return;
    const last = this.rechecked.get(id);
    if (last !== undefined && now - last < this.settings.recheckMs) return;
    this.rechecked.set(id, now);
    void this.ports.transport.recheck(id).catch(() => undefined);
  }

  /**
   * Hands over the next message when it may go; answers whether to try another in this look.
   * Holding — for a reason, or behind a message still unproven — answers `false`.
   */
  private async handOverNext(id: SessionId, messages: readonly QueuedMessage[]): Promise<boolean> {
    let view: DeliveryView;
    try {
      view = await this.ports.view(id);
    } catch {
      await this.waiting(id, messages, 'unreadable');
      return false;
    }
    const plan = planDelivery(messages, view, this.ports.clock.now(), this.settings);
    if (plan === undefined) return false;
    if (plan.kind === 'hold') {
      // Held to combine, or an FYI kept from reviving a stopped ferret: the only reason on show is the
      // second; a hold's own end time is on the message (`holdUntil`) and in the send's answer.
      await this.waiting(id, deliveryOrder(messages, view.target.mode), plan.reason);
      return false;
    }
    const members = plan.kind === 'single' ? [plan.message] : plan.members;
    const delivery: QueueDelivery = { sendId: members[0]?.id ?? '', members };
    let reason = reasonForWaiting(view);
    let behind: string | undefined;
    // NEVER QUEUE BEHIND A GHOST (B144). A "draft" that is a send of this session's own, typed by the daemon
    // and never submitted, is nobody's to clear: it is finished here and the box read again. One that will
    // not leave is named, so the sender is told exactly what its message is waiting behind.
    if (reason === 'draft') {
      const own = await this.ports.transport.clearOwnDraft(id).catch((): OwnDraft => ({ kind: 'foreign' }));
      if (own.kind === 'stuck') behind = own.sendId;
      if (own.kind === 'clear') {
        try {
          view = await this.ports.view(id);
        } catch {
          await this.waiting(id, messages, 'unreadable');
          return false;
        }
        reason = reasonForWaiting(view);
      }
    }
    // A pane that never came to a prompt is not handed the message again until one shows, or `recheckMs` has
    // passed (&B153). Each hand-over holds both locks through a readiness wait of about half a minute, and the
    // queue looked again every `lookMs`: a pane that drew neither a prompt nor work looped for as long.
    if (reason === undefined) reason = this.awaitingPrompt(id, view);
    await this.waiting(id, deliveryOrder(messages, view.target.mode), reason, behind);
    if (reason !== undefined) return false;
    // Every member is `typing` under the delivery's id BEFORE anything is handed over, so a daemon that
    // dies in between leaves them all to be settled from the one ledger record — or, with none, all back.
    for (const member of members)
      await this.move(id, member.id, 'typing', undefined, members.length > 1 ? delivery.sendId : undefined);
    const outcome = await this.ports.transport.handOver(id, delivery).catch(
      (error: unknown): HandOver => ({
        kind: 'failed',
        failure: error instanceof Error ? error.message : String(error),
      }),
    );
    if (outcome.kind === 'refused' && outcome.untilPrompt === true)
      this.promptless.set(id, {
        at: Date.parse(this.ports.clock.now()),
        reason: outcome.reason,
        staleReady: view.target.promptReady === true,
      });
    else this.promptless.delete(id);
    switch (outcome.kind) {
      case 'landed':
        for (const member of members) await this.move(id, member.id, 'delivered');
        return true;
      case 'unproven':
        return false;
      case 'refused':
        for (const member of members) await this.move(id, member.id, 'queued');
        await this.waiting(id, deliveryOrder(await this.messages(id), view.target.mode), outcome.reason);
        return false;
      case 'failed':
        // A hand-over that threw may still have typed: when the ledger, keyed by this id, has a record of
        // it, it stays `typing` and the next look settles it — the send path told the tracker, and a record
        // still `accepted` after `recheckMs` is put to it again. With no record nothing was typed, so it
        // fails and the next message may go.
        if ((await this.ports.transport.fate(id, delivery.sendId)) !== undefined) return false;
        for (const member of members) await this.move(id, member.id, 'failed', outcome.failure);
        return true;
    }
  }

  /** The reason a session whose last hand-over found no prompt still waits, or `undefined` once it may go. */
  private awaitingPrompt(id: SessionId, view: DeliveryView): QueueWaitReason | undefined {
    const last = this.promptless.get(id);
    if (last === undefined) return undefined;
    const { target, pane } = view;
    // The record's flag counts only as a CHANGE since the refusal: one already true then, and true still, is
    // the stale reading that was refused, and would end the backoff on the very next look. Seeing it false
    // re-arms it, so a later true is a real readiness change.
    if (target.promptReady !== true) last.staleReady = false;
    const recordReady = target.promptReady === true && !last.staleReady;
    const prompt = pane.promptReady || recordReady || !pane.alive || pane.dead;
    if (prompt || Date.parse(this.ports.clock.now()) - last.at >= this.settings.recheckMs) {
      this.promptless.delete(id);
      return undefined;
    }
    return last.reason;
  }

  /** Says why each waiting message is waiting, writing only what changed. */
  private async waiting(
    id: SessionId,
    messages: readonly QueuedMessage[],
    reason: QueueWaitReason | undefined,
    behind?: string,
  ): Promise<void> {
    for (const message of messages) {
      if (message.state !== 'queued' || (message.waitReason === reason && message.waitBehind === behind)) continue;
      await this.append(id, {
        v: 1,
        kind: 'waiting',
        at: this.ports.clock.now(),
        id: message.id,
        ...(reason === undefined ? {} : { reason }),
        ...(reason === undefined || behind === undefined ? {} : { behind }),
      });
    }
  }

  /** Whether a message can still move without anybody enqueueing, so its session is looked at again. */
  private unsettled(message: QueuedMessage): boolean {
    if (message.state === 'typing') return true;
    if (message.state === 'queued') return message.waitReason !== undefined;
    if (message.state !== 'delivered' && message.state !== 'unconfirmed') return false;
    return Date.parse(this.ports.clock.now()) - Date.parse(message.stateAt) < this.settings.readWatchMs;
  }

  private async move(
    id: SessionId,
    messageId: string,
    state: QueuedMessage['state'],
    failure?: string,
    batch?: string,
  ): Promise<void> {
    await this.append(id, {
      v: 1,
      kind: 'moved',
      at: this.ports.clock.now(),
      id: messageId,
      state,
      ...(failure === undefined ? {} : { failure }),
      ...(batch === undefined ? {} : { batch }),
    });
  }

  private async append(id: SessionId, event: QueueEvent): Promise<void> {
    await this.ports.store.append(id, event);
  }

  private async messages(id: SessionId): Promise<readonly QueuedMessage[]> {
    return foldQueue(await this.ports.store.read(id));
  }
}
