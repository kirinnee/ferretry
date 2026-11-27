/**
 * THE RECEIPTS OF THE ANSWERS THIS DEVICE HAS GIVEN, held above any one Inbox: what is waiting out its undo window, what
 * is on its way to the machine, and what the machine refused. One receipt per SEND (never per task), so a second answer
 * to the same task while the first is in flight keeps its own receipt when the first settles.
 *
 * They live here and not on the mounted Inbox so they outlive it: a refusal that lands after the Inbox went away (a route
 * change, `pagehide`) is still there when the owner comes back, and the item's conversation in the chat — which mounts no
 * Inbox — reads the same receipts the Inbox page does. The app has one (`answerReceipts`); a `DeferredAgendaActions`
 * built without one holds a private one, which is what a test of the actions alone wants.
 */

import type { DeferredAgendaState } from './agenda-inbox.ts';

type Listener = () => void;

export class AnswerReceipts {
  #state: DeferredAgendaState = { pending: [], sending: [], failed: [] };
  #sequence = 0;
  readonly #listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): DeferredAgendaState => this.#state;

  /** A send's identity: unique across every `DeferredAgendaActions` that shares these receipts. */
  nextId(): string {
    this.#sequence += 1;
    return `send-${String(this.#sequence)}`;
  }

  /** Replaces the state with `change` of it, and tells everyone who is watching. */
  update(change: (state: DeferredAgendaState) => DeferredAgendaState): void {
    this.#state = change(this.#state);
    for (const listener of [...this.#listeners]) listener();
  }
}

/** The app's one: every Inbox and every chat line reads and writes this one. */
export const answerReceipts = new AnswerReceipts();
