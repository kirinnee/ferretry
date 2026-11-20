/**
 * The first-run page's address words, and where it sends the person when the daemon answers (r10 O5). Plain values: the
 * app's own links ("Pair a device", "Set up a new daemon") and the hand-off all say the same words.
 */
import { describe, expect, it } from 'bun:test';

import { entryFromHref, flowHrefAfterPairing } from '../../../app/onboarding-entry.ts';

describe('entryFromHref', () => {
  it('reads the three journeys by the words the setup flow itself uses', () => {
    expect(entryFromHref('https://f.invalid/onboarding?journey=pair')).toEqual({ route: 'add-client', step: 'scan' });
    expect(entryFromHref('https://f.invalid/onboarding?journey=add-daemon')).toEqual({
      route: 'add-daemon',
      step: 'install',
    });
    expect(entryFromHref('https://f.invalid/onboarding?journey=first-time')).toEqual({
      route: 'first-time',
      step: 'install',
    });
  });

  it('takes no answer from a word it does not know, a missing word, or an address it cannot read', () => {
    expect(entryFromHref('https://f.invalid/onboarding')).toBeUndefined();
    expect(entryFromHref('https://f.invalid/onboarding?journey=')).toBeUndefined();
    expect(entryFromHref('https://f.invalid/onboarding?journey=add-client')).toBeUndefined();
    // Names every object has must never read as a journey.
    for (const word of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(entryFromHref(`https://f.invalid/onboarding?journey=${word}`)).toBeUndefined();
    }
    expect(entryFromHref('not an address')).toBeUndefined();
  });

  it("is not a pairing link: it never reads a code, and a fragment is the hand-off's business", () => {
    expect(entryFromHref('https://f.invalid/onboarding#journey=pair')).toBeUndefined();
  });
});

describe('flowHrefAfterPairing', () => {
  it("opens the machine's own steps after First time and Set up a new daemon", () => {
    expect(flowHrefAfterPairing('d1', 'first-time')).toBe('/d/d1/onboarding/setup?phase=daemon&journey=first-time');
    expect(flowHrefAfterPairing('d1', 'add-daemon')).toBe('/d/d1/onboarding/setup?phase=daemon&journey=add-daemon');
  });

  it("opens only this device's steps after a Pair: the machine it paired with is already set up", () => {
    expect(flowHrefAfterPairing('d1', 'add-client')).toBe('/d/d1/onboarding/setup?phase=client&journey=pair');
  });
});
