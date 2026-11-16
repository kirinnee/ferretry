import type { ChannelMessage } from '../../../contract/wire-channel.ts';

/**
 * The messages waiting to go through a ferret's Claude channel, and whether anything is there to take them.
 *
 * The MCP server of a Claude ferret (`fy mcp serve`) POLLS: it holds `channel_poll` open, forwards what comes back as a
 * channel notification, and says so (`channel_ack`). This is the daemon's side of that conversation, with no clock of its
 * own (one is handed in) and nothing durable: a daemon restart forgets what was waiting, and the send's own ledger row —
 * which the tracker keeps looking at — is what falls back to typing.
 *
 * CONNECTED means a poll is open right now, or one ended within {@link CHANNEL_GRACE_MS}: the server asks again at once,
 * so a gap longer than that is a server that is gone. A server that died mid-poll still reads connected until that poll's
 * own wait ends (at most the poll limit); a message sent to it is never acked, which is what sends the tracker to the
 * composer.
 */

/** How long after a poll ended the server still counts as listening: it asks again at once. */
export const CHANNEL_GRACE_MS = 5_000;

/** The clock the outbox needs: the time, and a one-shot timer that can be cancelled. */
export interface OutboxClock {
  nowMs(): number;
  after(delayMs: number, run: () => void): () => void;
}

/** One open poll: ends it with what it answers (and stops its timer). */
interface Poller {
  finish(messages: readonly ChannelMessage[]): void;
}

interface Lane {
  /** Waiting to be polled, oldest first. */
  pending: ChannelMessage[];
  /** Polled and not yet acked, by send id. */
  delivering: Map<string, ChannelMessage>;
  /** Acked: the server forwarded it. */
  acked: Set<string>;
  poller: Poller | undefined;
  /** When a poll last started or ended, in epoch milliseconds. */
  lastSeenMs: number | undefined;
}

export class ChannelOutbox {
  private readonly lanes = new Map<string, Lane>();

  constructor(private readonly clock: OutboxClock) {}

  private lane(ferret: string): Lane {
    let lane = this.lanes.get(ferret);
    if (lane === undefined) {
      lane = { pending: [], delivering: new Map(), acked: new Set(), poller: undefined, lastSeenMs: undefined };
      this.lanes.set(ferret, lane);
    }
    return lane;
  }

  /** Whether this ferret's server is listening now. */
  connected(ferret: string): boolean {
    const lane = this.lanes.get(ferret);
    if (lane === undefined) return false;
    if (lane.poller !== undefined) return true;
    return lane.lastSeenMs !== undefined && this.clock.nowMs() - lane.lastSeenMs <= CHANNEL_GRACE_MS;
  }

  /** Queues one message for the next poll, waking a poll that is waiting. A send id already queued or forwarded is kept once. */
  push(ferret: string, message: ChannelMessage): void {
    const lane = this.lane(ferret);
    if (
      lane.acked.has(message.sendId) ||
      lane.delivering.has(message.sendId) ||
      lane.pending.some(held => held.sendId === message.sendId)
    )
      return;
    lane.pending.push(message);
    this.release(lane);
  }

  /**
   * The messages waiting, or — when there are none — the next ones to arrive, up to `waitMs`. A second poll for the same
   * ferret ends the first (answering it empty): a server that restarted must not leave its old poll holding messages.
   */
  async poll(ferret: string, waitMs: number): Promise<readonly ChannelMessage[]> {
    const lane = this.lane(ferret);
    lane.lastSeenMs = this.clock.nowMs();
    lane.poller?.finish([]);
    if (lane.pending.length > 0 || waitMs <= 0) return this.take(lane);
    return await new Promise<readonly ChannelMessage[]>(resolve => {
      const stop = this.clock.after(waitMs, () => poller.finish([]));
      const poller: Poller = {
        finish: messages => {
          stop();
          lane.poller = undefined;
          lane.lastSeenMs = this.clock.nowMs();
          resolve(messages);
        },
      };
      lane.poller = poller;
    });
  }

  /** Marks messages forwarded. Answers how many of them this ferret was holding. */
  ack(ferret: string, sendIds: readonly string[]): number {
    const lane = this.lanes.get(ferret);
    if (lane === undefined) return 0;
    let acked = 0;
    for (const sendId of sendIds) {
      if (lane.delivering.delete(sendId) || lane.acked.has(sendId)) {
        lane.acked.add(sendId);
        acked += 1;
      }
    }
    return acked;
  }

  /** Whether the server said it forwarded this message. */
  wasAcked(ferret: string, sendId: string): boolean {
    return this.lanes.get(ferret)?.acked.has(sendId) === true;
  }

  /**
   * Takes a message back that nothing forwarded (still waiting, or polled and never acked), so it can never arrive after it
   * was typed instead. Answers whether it was still ours to take back (false: already acked, or never here).
   */
  withdraw(ferret: string, sendId: string): boolean {
    const lane = this.lanes.get(ferret);
    if (lane === undefined || lane.acked.has(sendId)) return false;
    const before = lane.pending.length;
    lane.pending = lane.pending.filter(held => held.sendId !== sendId);
    const wasDelivering = lane.delivering.delete(sendId);
    return lane.pending.length !== before || wasDelivering;
  }

  /** A ferret that stopped or is gone: nothing of it is kept. */
  forget(ferret: string): void {
    const lane = this.lanes.get(ferret);
    lane?.poller?.finish([]);
    this.lanes.delete(ferret);
  }

  /** Ends every open poll: the daemon is stopping. */
  stop(): void {
    for (const lane of this.lanes.values()) lane.poller?.finish([]);
    this.lanes.clear();
  }

  private take(lane: Lane): readonly ChannelMessage[] {
    const taken = lane.pending;
    lane.pending = [];
    for (const message of taken) lane.delivering.set(message.sendId, message);
    return taken;
  }

  private release(lane: Lane): void {
    lane.poller?.finish(this.take(lane));
  }
}
