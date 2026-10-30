import type { QueuedMessage, QueueWaitReason } from '@ferretry/protocol';
import type { ClockPort, SerialExecutor } from '../../ports.ts';
import type { SessionId } from '../../session-id.ts';
import type { SendScheduler } from '../send/tracker.ts';
import type { SendFate } from '../send/types.ts';
import { type DeliveryView, type HandOver, movesFrom, waitReasonOf } from './delivery.ts';
import { foldQueue, type QueueEvent } from './model.ts';
import { deliveryOrder, nextToDeliver } from './policy.ts';
import type { SessionQueueStore } from './ports.ts';

/**
 * THE ONE OWNER OF DELIVERY for a session's queue: it decides WHEN a message goes and IN WHAT ORDER, and
 * hands each one, under its own id, to the tracked send path that knows HOW to type into a harness and
 * keep the session's turn record straight.
 *
 * ONE AT A TIME. A message is marked `typing` on disk BEFORE it is handed over, and nothing else is handed
 * over while one is. A daemon that dies in between leaves a `typing` message, and the send ledger — keyed
 * by the same id — says on the next look whether a key ever went: no record means none did, and it waits
 * again; a record says where it went. Nothing is ever typed twice on a guess.
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

/** The send path, as delivery uses it. */
export interface QueueTransport {
  /** Hands one message to the pane under its own id; says what the pane proved. */
  handOver(id: SessionId, message: QueuedMessage): Promise<HandOver>;
  /** Where a message handed over before now stands, per the send ledger; `undefined` when it never got there. */
  fate(id: SessionId, messageId: string): Promise<SendFate | undefined>;
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

export interface QueueDeliverySettings {
  /** How soon a session with a message waiting or unproven is looked at again. */
  readonly lookMs: number;
  /** How long a delivered message is watched for its read tick before the session stops being looked at. */
  readonly readWatchMs: number;
  /** Messages handed over in one look, so a long queue cannot hold the lock for ever. */
  readonly perLook: number;
  /** The longest a stopping daemon waits for the hand-overs already in flight. */
  readonly drainMs: number;
}

export const defaultQueueDeliverySettings: QueueDeliverySettings = {
  lookMs: 5_000,
  readWatchMs: 60 * 60_000,
  perLook: 8,
  drainMs: 15_000,
};

export class QueueDeliverer {
  /** Sessions with something open, the only ones a state change makes this look at. */
  private readonly open = new Set<SessionId>();
  /** The looks running now, which a stopping daemon waits out. */
  private readonly running = new Set<Promise<void>>();
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
    // than one look hands over.
    if (more || (await this.messages(id)).some(message => this.unsettled(message))) {
      this.open.add(id);
      this.ports.scheduler.schedule(id, this.settings.lookMs, () => void this.look(id).catch(() => undefined));
    } else this.open.delete(id);
  }

  /** Brings every message already handed over up to what the send ledger proves. */
  private async settle(id: SessionId): Promise<void> {
    for (const message of await this.messages(id)) {
      if (message.state !== 'typing' && message.state !== 'delivered' && message.state !== 'unconfirmed') continue;
      const fate = await this.ports.transport.fate(id, message.id);
      for (const move of movesFrom(message, fate)) await this.move(id, message.id, move.state, move.failure);
    }
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
    const next = nextToDeliver(messages, view.target.mode);
    if (next === undefined) return false;
    const reason = waitReasonOf(view);
    await this.waiting(id, deliveryOrder(messages, view.target.mode), reason);
    if (reason !== undefined) return false;
    await this.move(id, next.id, 'typing');
    const outcome = await this.ports.transport.handOver(id, next).catch(
      (error: unknown): HandOver => ({
        kind: 'failed',
        failure: error instanceof Error ? error.message : String(error),
      }),
    );
    switch (outcome.kind) {
      case 'landed':
        await this.move(id, next.id, 'delivered');
        return true;
      case 'unproven':
        return false;
      case 'refused':
        await this.move(id, next.id, 'queued');
        await this.waiting(id, deliveryOrder(await this.messages(id), view.target.mode), outcome.reason);
        return false;
      case 'failed':
        // A hand-over that threw may still have typed: when the ledger, keyed by this id, has a record of
        // it, it stays `typing` and the next look settles it. With no record nothing was typed, so it
        // fails and the next message may go.
        if ((await this.ports.transport.fate(id, next.id)) !== undefined) return false;
        await this.move(id, next.id, 'failed', outcome.failure);
        return true;
    }
  }

  /** Says why each waiting message is waiting, writing only what changed. */
  private async waiting(
    id: SessionId,
    messages: readonly QueuedMessage[],
    reason: QueueWaitReason | undefined,
  ): Promise<void> {
    for (const message of messages) {
      if (message.state !== 'queued' || message.waitReason === reason) continue;
      await this.append(id, {
        v: 1,
        kind: 'waiting',
        at: this.ports.clock.now(),
        id: message.id,
        ...(reason === undefined ? {} : { reason }),
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

  private async move(id: SessionId, messageId: string, state: QueuedMessage['state'], failure?: string): Promise<void> {
    await this.append(id, {
      v: 1,
      kind: 'moved',
      at: this.ports.clock.now(),
      id: messageId,
      state,
      ...(failure === undefined ? {} : { failure }),
    });
  }

  private async append(id: SessionId, event: QueueEvent): Promise<void> {
    await this.ports.store.append(id, event);
  }

  private async messages(id: SessionId): Promise<readonly QueuedMessage[]> {
    return foldQueue(await this.ports.store.read(id));
  }
}
