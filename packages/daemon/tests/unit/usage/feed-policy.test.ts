import { describe, it } from 'bun:test';
import should from 'should';
import {
  cachedAccounts,
  decideUsageRead,
  emptyUsageCache,
  parseUsageAccounts,
  recordUsageRefresh,
  USAGE_REFRESH_MS,
  type UsageCacheState,
  usageRefreshMs,
} from '../../../src/lib/usage/index.ts';

const cached = (at: number, retryAfter = 0): UsageCacheState => ({
  snapshot: { at, accounts: [{ agent: 'writer' }] },
  retryAfter,
});

describe('decideUsageRead', () => {
  it('should refresh when nothing has ever been collected', () => {
    // Arrange / Act
    const decision = decideUsageRead(emptyUsageCache, 1_000, USAGE_REFRESH_MS);

    // Assert
    should(decision.kind).equal('refresh');
  });

  it('should serve a snapshot that is still within the refresh interval', () => {
    // Arrange
    const state = cached(1_000);

    // Act
    const decision = decideUsageRead(state, 1_000 + USAGE_REFRESH_MS - 1, USAGE_REFRESH_MS);

    // Assert
    should(decision).deepEqual({ kind: 'serve', accounts: [{ agent: 'writer' }] });
  });

  it('should refresh once the interval has elapsed exactly', () => {
    // Arrange
    const state = cached(1_000);

    // Act
    const decision = decideUsageRead(state, 1_000 + USAGE_REFRESH_MS, USAGE_REFRESH_MS);

    // Assert
    should(decision.kind).equal('refresh');
  });

  it('should treat a snapshot stamped in the future as expired rather than fresh', () => {
    // Arrange — the clock moved backwards after the snapshot was taken
    const state = cached(10_000);

    // Act
    const decision = decideUsageRead(state, 1_000, USAGE_REFRESH_MS);

    // Assert
    should(decision.kind).equal('refresh');
  });

  it('should serve the stale snapshot while the failure backoff is still running', () => {
    // Arrange
    const state = cached(0, 90_000);

    // Act
    const decision = decideUsageRead(state, 80_000, 10_000);

    // Assert
    should(decision).deepEqual({ kind: 'serve', accounts: [{ agent: 'writer' }] });
  });

  it('should serve nothing rather than invent accounts when backing off before any success', () => {
    // Arrange
    const state: UsageCacheState = { retryAfter: 90_000 };

    // Act
    const decision = decideUsageRead(state, 80_000, 10_000);

    // Assert
    should(decision).deepEqual({ kind: 'serve', accounts: [] });
  });
});

describe('recordUsageRefresh', () => {
  it('should keep the last good snapshot when a refresh produced nothing', () => {
    // Arrange
    const state = cached(1_000);

    // Act
    const next = recordUsageRefresh(state, undefined, 5_000, 10_000);

    // Assert
    should(next.snapshot).deepEqual(state.snapshot);
    should(next.retryAfter).equal(15_000);
  });

  it('should replace the snapshot and clear the backoff on success', () => {
    // Arrange
    const state = cached(1_000, 99_000);

    // Act
    const next = recordUsageRefresh(state, [{ agent: 'reader' }], 5_000, 10_000);

    // Assert
    should(next).deepEqual({ snapshot: { at: 5_000, accounts: [{ agent: 'reader' }] }, retryAfter: 0 });
  });

  it('should record a genuinely empty fleet as a success', () => {
    // Arrange / Act
    const next = recordUsageRefresh(cached(1_000), [], 5_000, 10_000);

    // Assert
    should(next.snapshot).deepEqual({ at: 5_000, accounts: [] });
  });
});

describe('cachedAccounts', () => {
  it('should be empty before the first successful collection', () => {
    // Arrange / Act / Assert
    should(cachedAccounts(emptyUsageCache)).deepEqual([]);
  });

  it('should expose the snapshot accounts once one exists', () => {
    // Arrange / Act / Assert
    should(cachedAccounts(cached(1_000))).deepEqual([{ agent: 'writer' }]);
  });
});

describe('parseUsageAccounts', () => {
  it.each([
    { label: 'a string', payload: 'nope' },
    { label: 'null', payload: null },
    { label: 'an object without accounts', payload: { at: 1 } },
    { label: 'an accounts field that is not a list', payload: { accounts: 'nope' } },
  ])('should reject $label as not an account payload at all', ({ payload }) => {
    // Arrange / Act / Assert
    should(parseUsageAccounts(payload)).be.undefined();
  });

  it('should accept a bare array of rows', () => {
    // Arrange / Act
    const accounts = parseUsageAccounts([{ agent: 'writer', fiveHourPercent: 10 }]);

    // Assert
    should(accounts).deepEqual([{ agent: 'writer', fiveHourPercent: 10 }]);
  });

  it('should accept the collector envelope', () => {
    // Arrange / Act
    const accounts = parseUsageAccounts({ at: 5, accounts: [{ agent: 'reader' }] });

    // Assert
    should(accounts).deepEqual([{ agent: 'reader' }]);
  });

  it('should drop a row with no usable identity', () => {
    // Arrange / Act
    const accounts = parseUsageAccounts([{ agent: 7 }, 'nonsense', { agent: 'reader' }]);

    // Assert
    should(accounts).deepEqual([{ agent: 'reader' }]);
  });

  it('should drop only the malformed field and keep the rest of the row', () => {
    // Arrange — the source trusted every field once the identity was a string
    const payload = [{ agent: 'writer', fiveHourPercent: 900, weeklyPercent: 30, availability: 'available' }];

    // Act
    const accounts = parseUsageAccounts(payload);

    // Assert
    should(accounts).deepEqual([{ agent: 'writer', weeklyPercent: 30, availability: 'available' }]);
  });

  it('should discard an unrecognised availability without losing the account', () => {
    // Arrange / Act
    const accounts = parseUsageAccounts([{ agent: 'writer', availability: 'maybe', authOk: true }]);

    // Assert
    should(accounts).deepEqual([{ agent: 'writer', authOk: true }]);
  });

  it('should read an empty fleet as an empty list, not as a failure', () => {
    // Arrange / Act / Assert
    should(parseUsageAccounts({ accounts: [] })).deepEqual([]);
  });
});

describe('usageRefreshMs', () => {
  it('should serve a snapshot for the interval the fleet declared', () => {
    // Arrange / Act / Assert — one name for one cadence; the daemon no longer carries a second.
    should(usageRefreshMs(900)).equal(900_000);
  });

  it('should keep the default when no fleet configuration declares one', () => {
    // Arrange / Act / Assert — an unprovisioned host has not asked for a cadence.
    should(usageRefreshMs(undefined)).equal(USAGE_REFRESH_MS);
  });
});
