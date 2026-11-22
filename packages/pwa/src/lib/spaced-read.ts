/**
 * A read that rides on another read, at most once per spacing.
 *
 * WHY. The open chat re-read the session's COMPLETE agenda board alongside every transcript read, and a
 * transcript read follows every transcript change — so a busy ferret's page downloaded its board back to
 * back for as long as it was open. On 2026-11-22 the owner's daemon logged 9,811 board reads (8.6 GB) in two
 * days, sessions that pulled `GET …/agenda` 119 times in 87 s at about 1.4 MB each, and the browser closing
 * sessions because "the daemon did not answer a request in time". Every board change is already announced
 * (`agenda.changed` / `attention.changed`, on the fleet feed and on the session's own stream), so the
 * piggy-backed read is only the safety net for an announcement that never arrived, and a safety net needs a
 * beat, not a reflex.
 *
 * {@link SpacedRead.take} says whether this ride may read; {@link SpacedRead.reset} makes the next one read,
 * for the moment something announced a change. {@link SpacedRead.takeWhy} also says WHY it may read: a read
 * owed to an announcement must reflect a state newer than the announcement, so it may not join a read that
 * was already on the wire when the announcement arrived (its response is older than the change).
 */
export type SpacedReadReason = 'announced' | 'spaced';

export class SpacedRead {
  #lastAt: number | undefined;
  #announced = false;

  constructor(
    private readonly spacingMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Whether to read now — none yet, a reset since, or the last one at least the spacing ago — counting it as read. */
  take(): boolean {
    return this.takeWhy() !== undefined;
  }

  /** {@link take}, naming the reason: `announced` when a reset is what allowed it, `spaced` when only the spacing did. */
  takeWhy(): SpacedReadReason | undefined {
    const now = this.now();
    const announced = this.#announced;
    if (!announced && this.#lastAt !== undefined && now - this.#lastAt < this.spacingMs) return undefined;
    this.#lastAt = now;
    this.#announced = false;
    return announced ? 'announced' : 'spaced';
  }

  /** Something announced a change: the next {@link take} reads, and that read must start after this moment. */
  reset(): void {
    this.#lastAt = undefined;
    this.#announced = true;
  }
}

/** The beat of the chat's safety-net agenda read: the durable queue's fallback beat (`QUEUE_FALLBACK_MS`). */
export const AGENDA_SAFETY_NET_MS = 30_000;

/** The events that say a session's agenda board changed. */
export const changesTheAgenda = (event: { readonly type: string }): boolean =>
  event.type === 'agenda.changed' || event.type === 'attention.changed';
