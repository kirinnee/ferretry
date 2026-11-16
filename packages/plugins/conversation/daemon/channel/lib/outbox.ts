import type { ChannelMessage } from '../../../contract/wire-channel.ts';

/**
 * The messages waiting to go through a ferret's Claude channel, and whether anything is there to take them.
 *
 * The MCP server of a Claude ferret (`fy mcp serve`) POLLS: it holds `channel_poll` open and, for each message that comes
 * back, CLAIMS it (`channel_claim`) before writing the notification. This is the daemon's side of that conversation,
 * with no clock of its own (one is handed in) and nothing durable: a daemon restart forgets what was waiting, and the
 * send's own ledger row — which the tracker keeps looking at — is what falls back to typing.
 *
 * TWO-PHASE HAND-OUT. A poll only OFFERS candidates. The server asks to CLAIM each one right before it writes it, and the
 * claim is granted only if the message is still ours to push (not withdrawn) and the caller is the CURRENT subscriber
 * (its generation). So a poll response that is delayed in transit can never push a message the fallback already typed:
 * the late claim is refused. A claimed message is NEVER withdrawn — it may be on its way to Claude — and is resolved only
 * by the transcript's receipt, or by the receipt window running out, which marks the channel broken.
 *
 * A server's claim is never proof of arrival. Only the transcript proves that; {@link received} records it, and a ferret
 * is {@link proven} after its first.
 *
 * CONNECTED means a poll is open right now, or one ended within {@link CHANNEL_GRACE_MS}, and the channel has not been
 * marked broken. A BROKEN channel (a claimed message that Claude never enqueued: the flag was dropped, or an
 * organisation policy refused channels) routes nothing until the ferret is relaunched (a new subscriber generation, or
 * {@link forget}).
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
  /** Offered to the current subscriber in a poll answer and not yet claimed, by send id. */
  offered: Map<string, ChannelMessage>;
  /** Claimed: the server was told to write it. Send id to the instant of the claim. */
  claimed: Map<string, number>;
  /** The current subscriber (the last generation that polled). */
  generation: string | undefined;
  poller: Poller | undefined;
  /** When a poll last started or ended, in epoch milliseconds. */
  lastSeenMs: number | undefined;
  /** A claimed message showed no receipt: nothing is routed through the channel until a new subscriber. */
  broken: boolean;
  /** At least one message was received by Claude (the transcript's enqueue line). */
  proven: boolean;
}

/** What {@link ChannelOutbox.withdraw} found. */
export type Withdrawal = 'withdrawn' | 'claimed';

export class ChannelOutbox {
  private readonly lanes = new Map<string, Lane>();

  constructor(private readonly clock: OutboxClock) {}

  private lane(ferret: string): Lane {
    let lane = this.lanes.get(ferret);
    if (lane === undefined) {
      lane = {
        pending: [],
        offered: new Map(),
        claimed: new Map(),
        generation: undefined,
        poller: undefined,
        lastSeenMs: undefined,
        broken: false,
        proven: false,
      };
      this.lanes.set(ferret, lane);
    }
    return lane;
  }

  /** Whether this ferret's server is listening now, and its channel has not been marked broken. */
  connected(ferret: string): boolean {
    const lane = this.lanes.get(ferret);
    if (lane === undefined || lane.broken) return false;
    if (lane.poller !== undefined) return true;
    return lane.lastSeenMs !== undefined && this.clock.nowMs() - lane.lastSeenMs <= CHANNEL_GRACE_MS;
  }

  /** Whether the channel was marked broken (a claimed message showed no receipt) and has not had a new subscriber since. */
  broken(ferret: string): boolean {
    return this.lanes.get(ferret)?.broken === true;
  }

  /** Whether Claude has received at least one message through this ferret's channel. */
  proven(ferret: string): boolean {
    return this.lanes.get(ferret)?.proven === true;
  }

  /** Queues one message for the next poll, waking a poll that is waiting. A send id already held is kept once. */
  push(ferret: string, message: ChannelMessage): void {
    const lane = this.lane(ferret);
    if (
      lane.claimed.has(message.sendId) ||
      lane.offered.has(message.sendId) ||
      lane.pending.some(held => held.sendId === message.sendId)
    )
      return;
    lane.pending.push(message);
    this.release(lane);
  }

  /**
   * The candidates waiting, or — when there are none — the next ones to arrive, up to `waitMs`. A poll from a NEW
   * generation makes it the current subscriber: what the old one was offered goes back to waiting (the old one's claims
   * are now refused), and a broken channel is given another chance. A second poll for the same generation ends the first
   * (answering it empty).
   */
  async poll(ferret: string, generation: string, waitMs: number): Promise<readonly ChannelMessage[]> {
    const lane = this.lane(ferret);
    lane.lastSeenMs = this.clock.nowMs();
    if (lane.generation !== generation) {
      lane.generation = generation;
      lane.broken = false;
      lane.pending = [...lane.offered.values(), ...lane.pending];
      lane.offered.clear();
    }
    lane.poller?.finish([]);
    // A broken channel still holds the poll open (the server must not spin) but offers nothing.
    if (waitMs <= 0 || (!lane.broken && lane.pending.length > 0)) return lane.broken ? [] : this.offer(lane);
    return await new Promise<readonly ChannelMessage[]>(resolve => {
      const stop = this.clock.after(waitMs, () => poller.finish([]));
      const poller: Poller = {
        finish: messages => {
          stop();
          if (lane.poller === poller) lane.poller = undefined;
          lane.lastSeenMs = this.clock.nowMs();
          resolve(messages);
        },
      };
      lane.poller = poller;
    });
  }

  /**
   * Grants the right to write one polled message to Claude. Refused when the caller is not the current subscriber (a
   * restarted server, a daemon that restarted and forgot the lane), when the message was withdrawn or never offered to it,
   * or when the channel is broken. A grant marks it claimed, so it can never be withdrawn.
   */
  claim(ferret: string, generation: string, sendId: string): boolean {
    const lane = this.lanes.get(ferret);
    if (lane === undefined || lane.broken || lane.generation !== generation || !lane.offered.has(sendId)) return false;
    lane.offered.delete(sendId);
    lane.claimed.set(sendId, this.clock.nowMs());
    return true;
  }

  /** When the server claimed this send, in epoch milliseconds; none when it did not (or the daemon forgot). */
  claimedAt(ferret: string, sendId: string): number | undefined {
    return this.lanes.get(ferret)?.claimed.get(sendId);
  }

  /**
   * Takes a message back, unless it was claimed: a claimed message may already be on its way to Claude and is resolved
   * only by {@link received} or {@link markBroken}. Unclaimed, it can never be pushed afterwards (the claim is refused).
   * A send the outbox never held (a daemon that restarted) is `withdrawn`: its claim, when it comes, is refused.
   */
  withdraw(ferret: string, sendId: string): Withdrawal {
    const lane = this.lanes.get(ferret);
    if (lane === undefined) return 'withdrawn';
    if (lane.claimed.has(sendId)) return 'claimed';
    lane.pending = lane.pending.filter(held => held.sendId !== sendId);
    lane.offered.delete(sendId);
    return 'withdrawn';
  }

  /** The transcript showed Claude received this send: the channel works for this ferret. */
  received(ferret: string, sendId: string): void {
    const lane = this.lanes.get(ferret);
    if (lane === undefined) return;
    lane.claimed.delete(sendId);
    lane.proven = true;
  }

  /**
   * A claimed message was never received within the window: Claude is not taking channel messages (the launch flag was
   * dropped, or an organisation policy refuses them). Nothing more is routed through it until a new subscriber, and what
   * was waiting is dropped (each such send's own ledger row falls back to typing).
   */
  markBroken(ferret: string): void {
    const lane = this.lane(ferret);
    lane.broken = true;
    lane.pending = [];
    lane.offered.clear();
    lane.claimed.clear();
    lane.poller?.finish([]);
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

  private offer(lane: Lane): readonly ChannelMessage[] {
    const taken = lane.pending;
    lane.pending = [];
    for (const message of taken) lane.offered.set(message.sendId, message);
    return taken;
  }

  private release(lane: Lane): void {
    if (lane.poller === undefined || lane.broken) return;
    lane.poller.finish(this.offer(lane));
  }
}
