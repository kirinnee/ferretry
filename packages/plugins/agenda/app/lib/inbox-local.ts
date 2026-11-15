/**
 * WHAT THIS DEVICE HAS DONE TO THE INBOX THAT NO DAEMON HAS HEARD YET: the answers still inside their undo window or in
 * flight (they leave the deck at once) and the replies just sent (parked now, or back after an Undo). They live in the
 * mounted Inbox's own state; the Inbox publishes them here, so the Agenda nav count — built where no page is — counts
 * the same deck the page deals (`inbox-count.ts`) instead of waiting for the boards to agree.
 *
 * The keys name their machine (`inboxCardKey`), so one set serves every machine; the owner that publishes is the Inbox
 * that mounted, and leaving the page withdraws what it published (an answer inside its window is sent when it goes).
 */

import type { RepliedState } from './agenda-replied.ts';

/** The local changes one Inbox holds. */
export interface InboxLocalState {
  readonly hidden: ReadonlySet<string>;
  readonly replied: RepliedState;
}

const NOTHING: InboxLocalState = { hidden: new Set(), replied: { entries: [], notice: null, restores: [] } };

export class InboxLocal {
  readonly #by = new Map<object, InboxLocalState>();
  readonly #listeners = new Set<() => void>();
  #merged: InboxLocalState = NOTHING;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Identity-stable between publishes. */
  getSnapshot = (): InboxLocalState => this.#merged;

  /** `owner` now holds `state`; `null` withdraws it. */
  publish(owner: object, state: InboxLocalState | null): void {
    if (state === null) {
      if (!this.#by.delete(owner)) return;
    } else {
      const known = this.#by.get(owner);
      if (known?.hidden === state.hidden && known.replied === state.replied) return;
      this.#by.set(owner, state);
    }
    this.#merged = this.#merge();
    for (const listener of [...this.#listeners]) listener();
  }

  #merge(): InboxLocalState {
    const all = [...this.#by.values()];
    const [only] = all;
    if (only === undefined) return NOTHING;
    if (all.length === 1) return only;
    return {
      hidden: new Set(all.flatMap(each => [...each.hidden])),
      replied: {
        entries: all.flatMap(each => each.replied.entries),
        notice: all.find(each => each.replied.notice !== null)?.replied.notice ?? null,
        restores: all.flatMap(each => each.replied.restores),
      },
    };
  }
}

/** The app's one: the mounted Inbox publishes into it and the nav count reads it, as with the answered suggestions. */
export const inboxLocal = new InboxLocal();
