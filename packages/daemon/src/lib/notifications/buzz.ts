import type { AttentionItem, AttentionSnapshot } from '@ferretry/protocol';
import {
  type AttentionBoardChange,
  type AttentionChangeObserver,
  type AttentionLedgerRepository,
  type AttentionRaisedObserver,
  attentionSnapshot,
  emptyAttentionLedger,
  ownerTurnItems,
  type SessionStops,
} from '../attention/index.ts';

/** What a buzz reaches the owner's phone through: each call is at most one push, deduped by the ledger. */
export interface BuzzSink {
  stopped(sessionId: string, stoppedAt: string, snapshot: AttentionSnapshot): Promise<void>;
  deadline(sessionId: string, item: AttentionItem, snapshot: AttentionSnapshot): Promise<void>;
  /** A notice was raised: it buzzes only when it asked to (`--ping`). */
  raised(sessionId: string, item: AttentionItem, snapshot: AttentionSnapshot): Promise<void>;
}

/** The deadline an item's `neededBy` is warned at: this long before it, by default (`attention.deadlineWarnHours`). */
export const DEFAULT_DEADLINE_WARN_HOURS = 3;

/**
 * WHEN THE PHONE BUZZES — the only three times, and nothing else is a push (docs/notifications.md):
 *
 *  1. the ferret is STOPPED on the owner: idle with an agenda item on the owner's turn — ONE grouped push
 *     per stop;
 *  2. an item's `neededBy` is within the warning window — ONE push per item;
 *  3. a notice with `ping`.
 *
 * Everything else — a new item while the ferret works, an edit, a change of whose turn it is, a notice
 * without `ping` — only moves the Inbox badge. This replaces the push every raise used to make.
 *
 * It decides from the board as it stands, never from the event that woke it, so the order its triggers
 * arrive in does not matter: each one re-reads the board and the idle state, and the ledger under the sink
 * makes a repeat a no-op. Total: a trigger that cannot read or push says nothing.
 */
export class AttentionBuzz implements AttentionRaisedObserver, AttentionChangeObserver {
  constructor(
    private readonly boards: Pick<AttentionLedgerRepository, 'read'>,
    private readonly stops: SessionStops,
    private readonly sink: BuzzSink,
    private readonly clock: { now(): string },
    private readonly warnHours: number = DEFAULT_DEADLINE_WARN_HOURS,
  ) {}

  async raised(sessionId: string, item: AttentionItem, snapshot: AttentionSnapshot): Promise<void> {
    if (item.notice === true) {
      await this.sink.raised(sessionId, item, snapshot).catch(() => undefined);
      return;
    }
    if (item.raisedBy !== 'human') await this.settle(sessionId, true);
  }

  /** The owner's own moves never buzz their own phone: only a ferret's, the warden's or a source's can. */
  async changed(sessionId: string, change: AttentionBoardChange): Promise<void> {
    if (change.actor.kind !== 'human') await this.settle(sessionId, true);
  }

  /** The session's turn moved: if it just went idle on the owner, this is the stop. */
  async turnChanged(sessionId: string): Promise<void> {
    await this.settle(sessionId, true);
  }

  /**
   * The deadline sweep: every named session's board, one at a time, none able to stop the rest. It looks at
   * deadlines ONLY: a ferret that was already idle when this daemon started is not newly stopped.
   */
  async sweep(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) await this.settle(sessionId, false);
  }

  private async settle(sessionId: string, stop: boolean): Promise<void> {
    try {
      const ledger = (await this.boards.read(sessionId)) ?? emptyAttentionLedger(sessionId, this.clock.now());
      const snapshot = attentionSnapshot(ledger);
      const owner = ownerTurnItems(snapshot.items);
      if (owner.length === 0) return;
      const horizon = Date.parse(this.clock.now()) + this.warnHours * 3_600_000;
      for (const item of owner) {
        if (item.neededBy !== undefined && Date.parse(item.neededBy) <= horizon)
          await this.sink.deadline(sessionId, item, snapshot).catch(() => undefined);
      }
      if (!stop) return;
      const stopId = await this.stops.current(sessionId);
      if (stopId !== undefined) await this.sink.stopped(sessionId, stopId, snapshot);
    } catch {
      // A trigger that cannot read says nothing; the next one reads again.
    }
  }
}
