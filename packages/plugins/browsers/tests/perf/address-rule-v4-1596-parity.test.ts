import { describe, expect, test } from 'bun:test';
import { HIDDEN_FRAGMENT, hideCredentialFragments } from '../../daemon/address-rule.ts';

/**
 * The speed half of the v4 #1596 parity cases (the correctness half is `tests/unit/address-rule-v4-1596-parity.test.ts`,
 * at a small size): the address rule stays linear on the long runs a hostile page could plant after a fragment.
 */
describe('v4 #1596 parity: the address rule stays linear', () => {
  test('takes linear time on a long run of punctuation after a fragment', () => {
    const started = performance.now();
    const hidden = hideCredentialFragments(`#v1;${';'.repeat(200_000)}x`);
    expect(hidden).toBe(HIDDEN_FRAGMENT);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test('hides a long run of quote characters after a fragment in under 2 s', () => {
    const started = performance.now();
    const hidden = hideCredentialFragments(`#v1;'${"'".repeat(200_000)}x`);
    expect(hidden).toBe(HIDDEN_FRAGMENT);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test('hides many short quote-bearing words after a fragment in under 2 s', () => {
    const started = performance.now();
    const hidden = hideCredentialFragments(`#v1;${";x'y ".repeat(40_000)}`);
    expect(hidden).toContain(HIDDEN_FRAGMENT);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
