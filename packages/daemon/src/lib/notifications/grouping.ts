import { type AttentionItem, type AttentionSnapshot, attentionInDiscussion } from '@ferretry/protocol';
import type { AttentionRaisedObserver } from '../attention/index.ts';

/** How long a ferret's raises are gathered into one push: long enough for one turn's burst of asks. */
export const ATTENTION_GROUP_WINDOW_MS = 3_000;

/** One timer per key; scheduling a key that is already pending replaces it. */
export interface NotificationTimers {
  schedule(key: string, delayMs: number, task: () => void): void;
  cancel(key: string): void;
}

/** What a gathered burst is announced through. */
export interface GroupedRaiseSink extends AttentionRaisedObserver {
  groupRaised(
    sessionId: string,
    items: readonly [AttentionItem, ...AttentionItem[]],
    snapshot: AttentionSnapshot,
  ): Promise<void>;
}

interface Pending {
  readonly items: AttentionItem[];
  snapshot: AttentionSnapshot;
}

/**
 * ONE PUSH PER FERRET TURN. A ferret that needs three things raises three asks, each starting in discussion in
 * its chat; the owner is told once — "<ferret> needs 3 things: …" — not three times. Raises by one session
 * within `windowMs` of the first are gathered and announced together; a lone ask is announced as itself.
 *
 * An item that does not start in discussion (a warden's, a system's, or one a ferret raised with `--surface`)
 * is announced at once, as before: it is a card on the queue and nobody is talking about it.
 *
 * The gathered asks live in memory only: a daemon that stops inside the window sends no push for them. They
 * are on their boards either way, and the ferret's chat shows them.
 */
export class GroupedAttentionRaises implements AttentionRaisedObserver {
  readonly #pending = new Map<string, Pending>();

  constructor(
    private readonly sink: GroupedRaiseSink,
    private readonly timers: NotificationTimers,
    private readonly windowMs: number = ATTENTION_GROUP_WINDOW_MS,
  ) {}

  async raised(sessionId: string, item: AttentionItem, snapshot: AttentionSnapshot): Promise<void> {
    if (!attentionInDiscussion(item)) {
      await this.sink.raised(sessionId, item, snapshot);
      return;
    }
    const pending = this.#pending.get(sessionId);
    if (pending !== undefined) {
      pending.items.push(item);
      pending.snapshot = snapshot;
      return;
    }
    this.#pending.set(sessionId, { items: [item], snapshot });
    this.timers.schedule(`attention-group:${sessionId}`, this.windowMs, () => {
      void this.flush(sessionId);
    });
  }

  /** Announces what one session has gathered so far. Total. */
  async flush(sessionId: string): Promise<void> {
    const pending = this.#pending.get(sessionId);
    this.#pending.delete(sessionId);
    const [first, ...rest] = pending?.items ?? [];
    if (pending === undefined || first === undefined) return;
    await this.sink.groupRaised(sessionId, [first, ...rest], pending.snapshot).catch(() => undefined);
  }
}
