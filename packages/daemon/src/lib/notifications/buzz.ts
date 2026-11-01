import type { AgendaItem, AgendaSnapshot } from '@ferretry/protocol';
import {
  type AgendaBoardChange,
  type AgendaChangeObserver,
  type AgendaLedgerRepository,
  type AgendaRaisedObserver,
  agendaSnapshot,
  emptyAgendaLedger,
  ownerTurnItems,
  type SessionStops,
} from '../agenda/index.ts';

/** What a buzz reaches the owner's phone through: each call is at most one push, deduped by the ledger. */
export interface BuzzSink {
  stopped(sessionId: string, stoppedAt: string, snapshot: AgendaSnapshot): Promise<void>;
  deadline(sessionId: string, item: AgendaItem, snapshot: AgendaSnapshot): Promise<void>;
  /** A notice was raised: it buzzes only when it asked to (`--ping`). */
  raised(sessionId: string, item: AgendaItem, snapshot: AgendaSnapshot): Promise<void>;
  /** A snoozed item woke and it blocks the ferret or has a deadline: its one push for this wake. */
  woke(sessionId: string, item: AgendaItem, snapshot: AgendaSnapshot): Promise<void>;
}

/** The deadline an item's `neededBy` is warned at: this long before it, by default (`attention.deadlineWarnHours`). */
export const DEFAULT_DEADLINE_WARN_HOURS = 3;

/**
 * Whether an item's deadline push is due by `horizon`. An INPUT card (the input bridge's own, `item.input`) always
 * is: its deadline is its request's expiry, minutes away, and the owner must hear about it the moment it is raised
 * whatever `deadlineWarnHours` says. It is still the one deadline push per card (the same ledger key).
 */
const deadlineDue = (item: AgendaItem, horizon: number): boolean =>
  item.input !== undefined || (item.neededBy !== undefined && Date.parse(item.neededBy) <= horizon);

/**
 * WHEN THE PHONE BUZZES — the only three times, and nothing else is a push (docs/notifications.md):
 *
 *  1. the ferret is STOPPED on the owner: idle with an agenda item on the owner's turn — ONE grouped push
 *     per stop;
 *  2. an item's `neededBy` is within the warning window — ONE push per item (an input card always is, so it
 *     pushes the moment it is raised, unless it is being filled under a task plan or a paste rule: QUIET);
 *  3. a notice with `ping`;
 *  4. a SNOOZED item woke and it blocks the ferret or has a deadline — ONE push per wake (an item already
 *     inside its deadline's window gets the deadline's push instead, never both).
 *
 * Everything else — a new item while the ferret works, an edit, a change of whose turn it is, a notice
 * without `ping` — only moves the Inbox badge. This replaces the push every raise used to make.
 *
 * It decides from the board as it stands, never from the event that woke it, so the order its triggers
 * arrive in does not matter: each one re-reads the board and the idle state, and the ledger under the sink
 * makes a repeat a no-op. Total: a trigger that cannot read or push says nothing.
 */
export class AgendaBuzz implements AgendaRaisedObserver, AgendaChangeObserver {
  constructor(
    private readonly boards: Pick<AgendaLedgerRepository, 'read'>,
    private readonly stops: SessionStops,
    private readonly sink: BuzzSink,
    private readonly clock: { now(): string },
    private readonly warnHours: number = DEFAULT_DEADLINE_WARN_HOURS,
    /**
     * Whether an input card is being filled under a task-plan line or a pre-approval rule right now
     * (`InputRequestService.quietCard`): it is raised and closed at once, so it buzzes nothing. Absent: none is.
     */
    private readonly quiet: (sessionId: string, requestId: string) => boolean = () => false,
  ) {}

  async raised(sessionId: string, item: AgendaItem, snapshot: AgendaSnapshot): Promise<void> {
    if (item.notice === true) {
      await this.sink.raised(sessionId, item, snapshot).catch(() => undefined);
      return;
    }
    if (item.raisedBy !== 'human') await this.settle(sessionId, true);
  }

  /** The owner's own moves never buzz their own phone: only a ferret's, the warden's or a source's can. */
  async changed(sessionId: string, change: AgendaBoardChange): Promise<void> {
    if (change.change === 'woke' && change.item !== undefined) await this.woke(sessionId, change.item, change.snapshot);
    if (change.actor.kind !== 'human') await this.settle(sessionId, true);
  }

  /** A woken item buzzes only when it blocks or has a deadline, and not when the deadline's own push will. */
  private async woke(sessionId: string, item: AgendaItem, snapshot: AgendaSnapshot): Promise<void> {
    const horizon = Date.parse(this.clock.now()) + this.warnHours * 3_600_000;
    if (deadlineDue(item, horizon)) return;
    if (item.blockingNow !== true && item.neededBy === undefined) return;
    await this.sink.woke(sessionId, item, snapshot).catch(() => undefined);
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
      const ledger = (await this.boards.read(sessionId)) ?? emptyAgendaLedger(sessionId, this.clock.now());
      const snapshot = agendaSnapshot(ledger);
      // A card being filled in advance is not the owner's to answer: it neither pushes its deadline nor makes a stop.
      const owner = ownerTurnItems(snapshot.items).filter(
        item => item.input === undefined || !this.quiet(sessionId, item.input.requestId),
      );
      if (owner.length === 0) return;
      const horizon = Date.parse(this.clock.now()) + this.warnHours * 3_600_000;
      for (const item of owner) {
        if (deadlineDue(item, horizon)) await this.sink.deadline(sessionId, item, snapshot).catch(() => undefined);
      }
      if (!stop) return;
      const stopId = await this.stops.current(sessionId);
      if (stopId !== undefined) await this.sink.stopped(sessionId, stopId, snapshot);
    } catch {
      // A trigger that cannot read says nothing; the next one reads again.
    }
  }
}
