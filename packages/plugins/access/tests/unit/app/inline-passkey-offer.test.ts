import { describe, expect, it } from 'bun:test';
import {
  holdInlinePasskeyOffer,
  inlinePasskeyOffered,
  onInlinePasskeyOffer,
} from '../../../app/lib/inline-passkey-offer.ts';

describe('A555 r7 a card offering the first passkey in place holds its machine', () => {
  it('counts two holds on one machine, lets go only when both did, and a second release is a no-op', () => {
    let told = 0;
    const stop = onInlinePasskeyOffer(() => {
      told += 1;
    });
    const first = holdInlinePasskeyOffer('daemon-x');
    const second = holdInlinePasskeyOffer('daemon-x');
    expect(inlinePasskeyOffered('daemon-x')).toBe(true);
    first();
    expect(inlinePasskeyOffered('daemon-x')).toBe(true);
    first();
    expect(inlinePasskeyOffered('daemon-x')).toBe(true);
    second();
    expect(inlinePasskeyOffered('daemon-x')).toBe(false);
    expect(told).toBe(4);
    stop();
    holdInlinePasskeyOffer('daemon-x')();
    expect(told).toBe(4);
  });
});
