import { describe, it } from 'bun:test';
import should from 'should';
import { parseSessionId } from '../../../../src/lib/index.ts';
import {
  defaultSessionResumeSettings,
  planRetry,
  retryDelayMs,
  type ResumePolicy,
  type ResumeTarget,
} from '../../../../src/lib/session/resume/index.ts';

const SETTINGS = defaultSessionResumeSettings;
const AUTOMATIC_RETRY: ResumePolicy = {
  automatic: true,
  dedupeSharedRecoveryScope: true,
  expectedStatus: 'retrying',
};

function target(overrides: Partial<ResumeTarget> = {}): ResumeTarget {
  return {
    id: parseSessionId('session-1'),
    status: 'retrying',
    mode: 'auto',
    cwd: '/workspace/project',
    turn: 1,
    transientRetryBudget: 3,
    ...overrides,
  };
}

describe('retry backoff', () => {
  it('should double from the base for each attempt', () => {
    // Act
    const actual = [1, 2, 3, 4].map(attempt => retryDelayMs(attempt, SETTINGS));

    // Assert
    should(actual).deepEqual([2_000, 4_000, 8_000, 16_000]);
  });

  it('should clamp at the ceiling rather than doubling into days', () => {
    // Arrange — uncapped doubling reaches days by the twentieth attempt, which parks the session
    // in `retrying` forever without ever reporting it failed.
    const attempts = [20, 200, 5_000];

    // Act
    const actual = attempts.map(attempt => retryDelayMs(attempt, SETTINGS));

    // Assert
    should(actual).deepEqual([SETTINGS.retryBackoffMaxMs, SETTINGS.retryBackoffMaxMs, SETTINGS.retryBackoffMaxMs]);
    should(actual.every(delay => Number.isFinite(delay))).be.true();
  });

  it('should fall back to the base for a non-positive attempt', () => {
    // Act
    const actual = [0, -3].map(attempt => retryDelayMs(attempt, SETTINGS));

    // Assert
    should(actual).deepEqual([SETTINGS.retryBackoffBaseMs, SETTINGS.retryBackoffBaseMs]);
  });
});

describe('retry planning', () => {
  it('should schedule the next attempt while budget remains', () => {
    // Act
    const actual = planRetry(target({ retryAttempt: 1 }), AUTOMATIC_RETRY, SETTINGS);

    // Assert
    should(actual).deepEqual({ kind: 'retry', attempt: 2, delayMs: 4_000 });
  });

  it('should treat an absent counter as the first attempt', () => {
    // Act
    const actual = planRetry(target(), AUTOMATIC_RETRY, SETTINGS);

    // Assert
    should(actual).deepEqual({ kind: 'retry', attempt: 1, delayMs: 2_000 });
  });

  it('should stop once the budget is exhausted', () => {
    // Act
    const actual = planRetry(target({ retryAttempt: 3 }), AUTOMATIC_RETRY, SETTINGS);

    // Assert
    should(actual).deepEqual({ kind: 'fail', reason: 'budget-exhausted' });
  });

  it('should treat an unset budget as no automatic retries at all', () => {
    // Act
    const actual = planRetry(target({ transientRetryBudget: undefined }), AUTOMATIC_RETRY, SETTINGS);

    // Assert
    should(actual).deepEqual({ kind: 'fail', reason: 'budget-exhausted' });
  });

  it('should never reschedule behind an operator who is watching the failure', () => {
    // Arrange
    const explicit: ResumePolicy = { automatic: false, dedupeSharedRecoveryScope: false };

    // Act
    const actual = planRetry(target({ retryAttempt: 0 }), explicit, SETTINGS);

    // Assert
    should(actual).deepEqual({ kind: 'fail', reason: 'not-automatic' });
  });

  it('should not consume the budget for an automatic revive that was not a scheduled retry', () => {
    // Arrange
    const automaticRevive: ResumePolicy = { automatic: true, dedupeSharedRecoveryScope: true };

    // Act
    const actual = planRetry(target(), automaticRevive, SETTINGS);

    // Assert
    should(actual).deepEqual({ kind: 'fail', reason: 'not-automatic' });
  });
});
