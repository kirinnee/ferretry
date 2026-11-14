import { describe, expect, test } from 'bun:test';
import { HIDDEN_FRAGMENT, hideCredentialFragments } from '../../daemon/address-rule.ts';

/**
 * FAKE material only. A pairing code the codec accepts may carry whitespace INSIDE it (`FA KE FA KE` reads as
 * FAKE-FAKE), so the redacted span must end where the parser stops reading the code, not at the first unpunctuated
 * word. Every case asserts that no piece of the code survives and that ordinary text after the fragment does.
 */
const PIECES = ['FA', 'KE', 'fa', 'ke', 'FAKE', 'fake', 'Fa', 'Ke'];
const FINGERPRINT = `fy_daemon_${'A'.repeat(43)}`;

function leaks(text: string): readonly string[] {
  return PIECES.filter(piece => text.includes(piece));
}

describe('a pairing code with whitespace inside it is hidden to the end of the code', () => {
  test('spaces between the pieces of the code (the reviewer’s reproducer)', () => {
    const hidden = hideCredentialFragments(
      `Pair #v1;url=https%3A%2F%2Fexample.test;code=FA KE FA KE;fp=${FINGERPRINT}`,
    );
    expect(hidden).toBe(`Pair ${HIDDEN_FRAGMENT}`);
  });

  test('tabs, mixed case, runs of spaces and a dash', () => {
    for (const code of ['FA\tKE\tFA\tKE', 'fA kE  Fa   kE', 'FA \t KE\tFA  KE', 'FA KE-FA KE', 'FAKE\t-\tFAKE']) {
      const hidden = hideCredentialFragments(`Pair #v1;url=x;code=${code};fp=${FINGERPRINT}`);
      expect(leaks(hidden)).toEqual([]);
      expect(hidden).toBe(`Pair ${HIDDEN_FRAGMENT}`);
    }
  });

  test('the other credential part names and a leading separator space', () => {
    for (const text of [
      `see #v1;c=FA KE FA KE;fp=${FINGERPRINT}`,
      `see #v1; c = FA KE FA KE ;fp=${FINGERPRINT}`,
      `see #CODE=FA KE FA KE;fp=${FINGERPRINT}`,
      `see #v1;url=x;Code= FA KE FA KE;fp=${FINGERPRINT}`,
    ]) {
      const hidden = hideCredentialFragments(text);
      expect(leaks(hidden)).toEqual([]);
      expect(hidden).toBe(`see ${HIDDEN_FRAGMENT}`);
    }
  });

  test('a spaced code at the very end of the input, with and without a trailing space', () => {
    for (const text of [
      'Pair #v1;url=x;code=FA KE FA KE',
      'Pair #v1;url=x;code=FA KE FA KE ',
      'Pair #code=FA\tKE FA\tKE',
    ]) {
      const hidden = hideCredentialFragments(text);
      expect(leaks(hidden)).toEqual([]);
      expect(hidden.startsWith(`Pair ${HIDDEN_FRAGMENT}`)).toBe(true);
    }
  });

  test('ordinary text after the fragment stays', () => {
    expect(hideCredentialFragments(`Pair #v1;url=x;code=FA KE FA KE;fp=${FINGERPRINT} then go home`)).toBe(
      `Pair ${HIDDEN_FRAGMENT} then go home`,
    );
    expect(hideCredentialFragments('Pair #v1;url=x;code=FA KE FA KE then go home')).toBe(
      `Pair ${HIDDEN_FRAGMENT} then go home`,
    );
    expect(hideCredentialFragments('Pair #v1;c=FAKEFAKE then go home')).toBe(`Pair ${HIDDEN_FRAGMENT} then go home`);
  });

  test('a value the parse cannot bound as a code hides to the end of its line, never less', () => {
    for (const value of ['FA KE F@ KE', 'FAKEFAKE9', 'FA KE FA KE9']) {
      const hidden = hideCredentialFragments(`Pair #v1;url=x;code=${value} and more\nnext line stays`);
      expect(hidden).toBe(`Pair ${HIDDEN_FRAGMENT}\nnext line stays`);
    }
  });

  test('a code the parse completes ends there: what follows it is ordinary text, not part of the code', () => {
    expect(hideCredentialFragments('Pair #v1;url=x;code=FA KE FA KE and more\nnext line stays')).toBe(
      `Pair ${HIDDEN_FRAGMENT} and more\nnext line stays`,
    );
  });

  test('encoded whitespace and an encoded separator end the code the same way', () => {
    expect(hideCredentialFragments('x #v1%3Bcode%3DFA%20KE%20FA%20KE%3Bfp%3D00 end')).toBe(`x ${HIDDEN_FRAGMENT} end`);
    expect(hideCredentialFragments('x #v1;code=FA%09KE FA KE;fp=00 end')).toBe(`x ${HIDDEN_FRAGMENT} end`);
  });
});

describe('ordinary fragments are not swept up by the code reader', () => {
  test('words after a harmless fragment stay', () => {
    expect(hideCredentialFragments('see #section then a=b')).toBe('see #section then a=b');
    expect(hideCredentialFragments('Issue #42 is open')).toBe('Issue #42 is open');
    expect(hideCredentialFragments('go to #/route/3 now')).toBe('go to #/route/3 now');
  });
});
