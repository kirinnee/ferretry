/**
 * WHAT A BROWSER THAT IS ALREADY PAIRED SHOULD SEE: its fleet, immediately.
 *
 * A reader who has done the setup has answered every question this app can ask
 * them. Showing them a chooser, a picker, or anything with the word "setup" on it
 * is asking again — and worse, it is asking on the screen they open every single
 * day. `/` already skips straight to the app on a storage marker and fails open
 * if the marker cannot be read; the same shortcut was missing one layer in, so
 * the redirect landed on a picker that then asked the question anyway.
 *
 * THE THREE ANSWERS ARE NOT INTERCHANGEABLE, AND THE MIDDLE ONE IS THE POINT.
 *
 * - `fleet` — there is a selected pairing and it is real. Go there. No screen.
 * - `onboarding` — there is nothing at all. That is a true empty state.
 * - `picker` — there ARE pairings, but which one this browser meant is not
 *   established: nothing is selected, or the selection names a daemon that is no
 *   longer in the list. DAMAGED STATE IS NOT EMPTY STATE. Guessing "probably the
 *   first one" would open somebody else's daemon; falling through to onboarding
 *   would tell a reader with a working fleet that they have never set anything
 *   up. The honest answer is the one screen that asks which, and it is a screen
 *   they can act on.
 *
 * It is a pure function of the evidence so the shortcut can be proved without a
 * router, a store or a browser — the three things that made the original
 * redirect impossible to test and therefore easy to get wrong.
 */

/** Everything the decision is allowed to look at. */
export interface FirstRunEvidence<Id extends string> {
  /** The daemon ids this browser holds a pairing for. */
  readonly pairedDaemonIds: readonly Id[];
  /** The one this browser last chose, if it chose one. */
  readonly selectedDaemonId: Id | null;
  /**
   * Whether a setup journey is in progress RIGHT NOW.
   *
   * Held for the length of the journey rather than re-decided per render:
   * pairing adds a connection synchronously, and re-deciding on that render
   * would teleport the reader out of the stage that tells them it worked.
   */
  readonly setupJourney: boolean;
}

export type FirstRunEntry<Id extends string> =
  | { readonly kind: 'fleet'; readonly daemonId: Id }
  | { readonly kind: 'picker' }
  | { readonly kind: 'onboarding' };

/** Where a visit to the app's root should actually land. */
export const firstRunEntry = <Id extends string>({
  pairedDaemonIds,
  selectedDaemonId,
  setupJourney,
}: FirstRunEvidence<Id>): FirstRunEntry<Id> => {
  /* A journey in progress outranks everything: the reader is mid-flow by their own choice. */
  if (setupJourney) return { kind: 'onboarding' };
  if (pairedDaemonIds.length === 0) return { kind: 'onboarding' };
  /* A selection that names a daemon this browser no longer holds is not a destination. */
  if (selectedDaemonId !== null && pairedDaemonIds.includes(selectedDaemonId)) {
    return { kind: 'fleet', daemonId: selectedDaemonId };
  }
  return { kind: 'picker' };
};
