/**
 * THE OWNER'S "ANSWERED" SET for ferrets' standing-rule suggestions (R1, C2). A suggestion's card sits on the ferret's
 * own agenda and stays there, unchanged, until it expires, whatever the owner does: so the app never closes it. What
 * takes it out of the owner's Inbox is this set, filled from the owner's side only: a Dismiss or an approved rule made
 * here, and any suggestion the daemon's owner list (`GET /v1/sign-in-rules/suggestions`, a person route) no longer
 * holds. Nothing here is sent anywhere.
 */

import type { DaemonId } from './daemon-connection.ts';

const keyOf = (daemonId: DaemonId, suggestion: string): string => JSON.stringify([daemonId, suggestion]);

export class AnsweredSuggestions {
  #answered: ReadonlySet<string> = new Set();
  readonly #listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): ReadonlySet<string> => this.#answered;

  /** The owner answered these on this machine: they leave the Inbox. */
  mark(daemonId: DaemonId, suggestions: readonly string[]): void {
    const fresh = suggestions.map(each => keyOf(daemonId, each)).filter(key => !this.#answered.has(key));
    if (fresh.length === 0) return;
    this.#answered = new Set([...this.#answered, ...fresh]);
    for (const listener of this.#listeners) listener();
  }

  has(answered: ReadonlySet<string>, daemonId: DaemonId, suggestion: string): boolean {
    return answered.has(keyOf(daemonId, suggestion));
  }
}

/** The app's one set: the suggestion card and the Inbox share it. */
export const answeredSuggestions = new AnsweredSuggestions();
