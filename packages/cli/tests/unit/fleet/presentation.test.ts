/**
 * Laying text out for a terminal nobody has measured yet.
 *
 * These are the two primitives every fleet report is built from, and both exist because the TERMINAL
 * does this badly: it wraps at its own width with no indent, so half a sentence starts hard against
 * the left margin and reads as the next top-level row, and it counts escape codes as characters, so
 * a coloured line breaks in the wrong place or in the middle of an escape sequence.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  FALLBACK_TERMINAL_WIDTH,
  NARROWEST_USABLE_WIDTH,
  PLAIN_FLEET_PALETTE,
  PLAIN_FLEET_PRESENTATION,
  packFragments,
  softWrap,
} from '../../../src/lib/fleet/presentation';

describe('the plain presentation', () => {
  it('should change nothing at all, because that is what NO_COLOR and a pipe produce', () => {
    // Every role is the identity function: a redirected report has to be the same words, with no
    // control characters in the file somebody redirected it into.
    for (const ink of Object.values(PLAIN_FLEET_PALETTE)) should(ink('NEEDS LOGIN')).equal('NEEDS LOGIN');
    should(PLAIN_FLEET_PRESENTATION.width).equal(FALLBACK_TERMINAL_WIDTH);
    should(NARROWEST_USABLE_WIDTH).be.below(FALLBACK_TERMINAL_WIDTH);
  });
});

describe('soft wrapping', () => {
  it('should give the first line and the continuations different budgets', () => {
    // The first line starts partway across a row — after a glyph, a name and a verdict — while a
    // continuation starts at its own indent. One budget would either overflow the row or waste most
    // of every continuation.
    should(softWrap('the access token expired and there is nothing to renew it with', 20, 40)).eql([
      'the access token',
      'expired and there is nothing to renew it',
      'with',
    ]);
  });

  it('should never split a word, even one that cannot fit', () => {
    // The long tokens in this output are account ids inside a command somebody is about to copy, and
    // a break in the middle of one produces something that looks copyable and is not.
    should(softWrap('run fy-fleet-login-0000000000000000000000 now', 10, 10)).eql([
      'run',
      'fy-fleet-login-0000000000000000000000',
      'now',
    ]);
  });

  it('should survive a width no terminal could honour', () => {
    // A zero or negative budget is arithmetic, not a caller error: a name and a verdict can consume
    // a narrow terminal entirely. It degrades to one word per line rather than looping or throwing.
    should(softWrap('one two', 0, -5)).eql(['one', 'two']);
  });

  it('should report one empty line for text with nothing in it', () => {
    // A row still has to be emitted: a verdict with no clause after it is a row, not an absence.
    should(softWrap('', 40, 40)).eql(['']);
    should(softWrap('   ', 40, 40)).eql(['']);
  });
});

describe('packing painted fragments', () => {
  const fragment = (plain: string) => ({ plain, painted: `<${plain}>` });

  it('should measure the plain text and emit the painted text', () => {
    // Escape codes have width zero on screen and non-zero in a string. Measuring the painted form is
    // how a coloured line ends up broken in the wrong place, or cut inside an escape sequence.
    should(packFragments([fragment('4 accounts'), fragment('2 need sign-in')], ' · ', 80, 78)).eql([
      '<4 accounts> · <2 need sign-in>',
    ]);
  });

  it('should fold onto continuations that have their own budget', () => {
    should(packFragments([fragment('aaaa'), fragment('bbbb'), fragment('cccc')], ' · ', 11, 4)).eql([
      '<aaaa> · <bbbb>',
      '<cccc>',
    ]);
  });

  it('should keep a fragment whole even when it cannot fit its budget', () => {
    // A count is a unit of meaning: "1 needs a credential" broken across two lines reads as two
    // different claims.
    should(packFragments([fragment('a'), fragment('1 needs a credential')], ' · ', 4, 4)).eql([
      '<a>',
      '<1 needs a credential>',
    ]);
  });

  it('should produce no lines at all when there is nothing to say', () => {
    should(packFragments([], ' · ', 80, 78)).eql([]);
  });
});
