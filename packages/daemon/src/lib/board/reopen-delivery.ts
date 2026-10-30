/**
 * DELIVERING A REOPEN (`board-design.md` §2.9): the card's ferret is told `&F412 was reopened by the owner: …`
 * without anyone telling it separately. The ladder, first rung that takes it:
 *
 * 1. the card's assignee, if it is alive — the line is queued like any owner message;
 * 2. the assignee, if it is stopped or finished but resumable — it is resumed with the line (`fy resume`);
 * 3. the card's owner ferret (the lead), the same two ways;
 * 4. nobody: the card is left orphaned, which the board shows (U5).
 *
 * The ordinary send path makes the alive-or-resume decision, so a reopen and a person's own message to the
 * same ferret can never disagree about it. A send the relaunch refused is HELD for an explicit revive: the
 * ferret still gets it then, but nobody is working the card now, so the next rung is told as well.
 */
import { effectiveAssignee } from './authority.ts';
import type { ReopenNotice, ReopenNotifier } from './ports.ts';
import { reopenMessage } from './service.ts';

/** What one delivery attempt did. */
export type ReopenDelivery =
  /** Typed into, or queued behind, a live ferret's turn. */
  | 'delivered'
  /** The ferret was stopped or finished and was resumed with the line as its turn. */
  | 'resumed'
  /** Kept for an explicit revive: the ferret could not be resumed now. */
  | 'held'
  /** There is no such ferret, or the send was refused. */
  | 'absent';

/**
 * Sends one owner message to one ferret, as the ordinary send path would. Never rejects. `key` is the
 * idempotency key: the same reopen delivered twice is typed once.
 */
export interface ReopenMessenger {
  deliver(sessionId: string, message: string, key: string): Promise<ReopenDelivery>;
}

/** The idempotency key of one reopen: the card and the history event that reopened it. */
export const reopenKey = (notice: Pick<ReopenNotice, 'task'>): string =>
  `board-reopen-${notice.task.id}-${notice.task.history.at(-1)?.seq ?? 0}`;

/** Who ended up being told, for the diagnostics and the tests. */
export interface ReopenDelivered {
  readonly to: string | null;
  readonly how: ReopenDelivery | 'orphaned';
}

const reached = (how: ReopenDelivery): boolean => how === 'delivered' || how === 'resumed';

export class ReopenDeliveryLadder implements ReopenNotifier {
  constructor(
    private readonly messenger: ReopenMessenger,
    private readonly diagnostics: { warn(message: string): void },
  ) {}

  async reopened(notice: ReopenNotice): Promise<void> {
    await this.deliver(notice);
  }

  /** Walks the ladder and says where the line landed. */
  async deliver(notice: ReopenNotice): Promise<ReopenDelivered> {
    const message = reopenMessage(notice.task, notice.by, notice.reason);
    const assignee = effectiveAssignee(notice.task);
    const rungs = [...new Set([assignee, notice.task.owner])];
    let last: ReopenDelivered = { to: null, how: 'orphaned' };
    for (const sessionId of rungs) {
      const how = await this.messenger.deliver(sessionId, message, reopenKey(notice));
      if (reached(how)) return { to: sessionId, how };
      if (how === 'held' && last.to === null) last = { to: sessionId, how };
    }
    this.diagnostics.warn(
      last.to === null
        ? `${message} reached no ferret: the card's assignee and owner are gone, so it is orphaned`
        : `${message} is held for ${last.to}'s next revive: no ferret on the card could be resumed now`,
    );
    return last;
  }
}
