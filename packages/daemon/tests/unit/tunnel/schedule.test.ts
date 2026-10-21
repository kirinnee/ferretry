import { describe, it } from 'bun:test';
import should from 'should';
import { backoffDelayMs, secondsPhrase } from '../../../src/lib/tunnel/schedule.ts';

describe('tunnel backoff', () => {
  it('should double from the base to the cap, with half of each step fixed and half jittered', () => {
    // Arrange
    const policy = { baseMs: 1_000, capMs: 60_000 };

    // Act / Assert — the lowest roll is half the step, the highest is the whole step.
    should([0, 1, 2, 3].map(attempt => backoffDelayMs(policy, attempt, () => 0))).deepEqual([500, 1_000, 2_000, 4_000]);
    should([0, 1, 2, 3].map(attempt => backoffDelayMs(policy, attempt, () => 1))).deepEqual([
      1_000, 2_000, 4_000, 8_000,
    ]);
    should(backoffDelayMs(policy, 40, () => 1)).equal(60_000);
    should(backoffDelayMs(policy, 40, () => 0)).equal(30_000);
  });

  it('should say a wait in whole seconds, never zero', () => {
    should(secondsPhrase(0)).equal('1s');
    should(secondsPhrase(4_400)).equal('4s');
    should(secondsPhrase(86_400_000)).equal('86400s');
  });
});
