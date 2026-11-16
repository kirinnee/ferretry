/**
 * WHAT A BROWSER THAT IS ALREADY PAIRED SHOULD SEE: its fleet, immediately (moved here from Onboarding, S14: it is the
 * SHELL that decides where the app's home sends a visitor; Onboarding draws what is there).
 *
 * A reader who has done the setup has answered every question this app can ask them. Showing them a chooser, a picker,
 * or anything with the word "setup" on it is asking again.
 *
 * THE THREE ANSWERS ARE NOT INTERCHANGEABLE, AND THE MIDDLE ONE IS THE POINT.
 *
 * - `fleet`: there is a selected pairing and it is real. Go there. No screen.
 * - `onboarding`: there is nothing at all. That is a true empty state.
 * - `picker`: there ARE pairings, but which one this browser meant is not established: nothing is selected, or the
 *   selection names a daemon that is no longer in the list. DAMAGED STATE IS NOT EMPTY STATE. Guessing "probably the
 *   first one" would open somebody else's daemon; falling through to onboarding would tell a reader with a working
 *   fleet that they have never set anything up.
 *
 * It is a pure function of the evidence so the rule can be proved without a router, a store or a browser.
 */

/** The key of Onboarding's daemon-less first-run screen: `<plugin>.<screen>`. */
export const ONBOARDING_SCREEN = 'onboarding.onboarding';

/** Everything the decision is allowed to look at. */
export interface FirstRunEvidence<Id extends string> {
  /** The daemon ids this browser holds a pairing for. */
  readonly pairedDaemonIds: readonly Id[];
  /** The one this browser last chose, if it chose one. */
  readonly selectedDaemonId: Id | null;
  /**
   * Whether a setup journey is in progress RIGHT NOW: held for the length of the journey, not re-decided per render
   * (pairing adds a connection synchronously, and re-deciding then would teleport the reader out of the stage that
   * tells them it worked). The shell has no journey of its own, so it always passes `false`.
   */
  readonly setupJourney: boolean;
}

export type FirstRunEntry<Id extends string> =
  | { readonly kind: 'fleet'; readonly daemonId: Id }
  | { readonly kind: 'picker' }
  | { readonly kind: 'onboarding' };

/** Where a visit to the app's home should land. */
export const firstRunEntry = <Id extends string>({
  pairedDaemonIds,
  selectedDaemonId,
  setupJourney,
}: FirstRunEvidence<Id>): FirstRunEntry<Id> => {
  if (setupJourney) return { kind: 'onboarding' };
  if (pairedDaemonIds.length === 0) return { kind: 'onboarding' };
  if (selectedDaemonId !== null && pairedDaemonIds.includes(selectedDaemonId)) {
    return { kind: 'fleet', daemonId: selectedDaemonId };
  }
  return { kind: 'picker' };
};
