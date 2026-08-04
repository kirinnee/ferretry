/**
 * A browser that is already paired is asked nothing.
 *
 * The interesting answer is the MIDDLE one. Pairings that exist with no usable
 * selection are not an empty state, and both benign readings are wrong: guessing
 * "probably the first daemon" opens somebody else's fleet, and falling through to
 * onboarding tells a reader with a working setup that they have never set
 * anything up. The picker is the honest answer, and it is a screen they can act on.
 */

import { describe, expect, it } from 'bun:test';

import { firstRunEntry } from '../../../src/features/onboarding/first-run-entry.ts';

describe('firstRunEntry', () => {
  it('goes straight to the fleet for a browser that holds a selected pairing', () => {
    expect(
      firstRunEntry({ pairedDaemonIds: ['studio', 'server'], selectedDaemonId: 'server', setupJourney: false }),
    ).toEqual({ kind: 'fleet', daemonId: 'server' });
  });

  it('shows the guide only when there is genuinely nothing', () => {
    expect(firstRunEntry({ pairedDaemonIds: [], selectedDaemonId: null, setupJourney: false })).toEqual({
      kind: 'onboarding',
    });
  });

  it('never yanks a reader out of a journey they are in the middle of', () => {
    // Pairing adds a connection synchronously, so the render right after it has
    // both a fleet AND a reader one stage from the screen that says it worked.
    expect(firstRunEntry({ pairedDaemonIds: ['studio'], selectedDaemonId: 'studio', setupJourney: true })).toEqual({
      kind: 'onboarding',
    });
  });

  it('refuses to guess which daemon an ambiguous browser meant', () => {
    // Pairings exist but nothing is selected…
    expect(firstRunEntry({ pairedDaemonIds: ['studio'], selectedDaemonId: null, setupJourney: false })).toEqual({
      kind: 'picker',
    });
    // …or the selection names a daemon this browser no longer holds. Damaged
    // state is not empty state, and it is not a destination either.
    expect(firstRunEntry({ pairedDaemonIds: ['studio'], selectedDaemonId: 'removed', setupJourney: false })).toEqual({
      kind: 'picker',
    });
  });
});
