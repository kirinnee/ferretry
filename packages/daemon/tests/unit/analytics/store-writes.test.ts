import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AnalyticsStoredSession,
  type AnalyticsStoreWrites,
  hasAnalyticsWrites,
  mergeAnalyticsWrites,
  NO_ANALYTICS_WRITES,
} from '../../../src/lib/index.ts';

const row = (id: string, tokens = 1): AnalyticsStoredSession =>
  ({ raw: { id, tokens }, signature: `${id}-${String(tokens)}` }) as unknown as AnalyticsStoredSession;

const writes = (overrides: Partial<AnalyticsStoreWrites>): AnalyticsStoreWrites => ({
  ...NO_ANALYTICS_WRITES,
  ...overrides,
});

describe('hasAnalyticsWrites', () => {
  it('should say whether a batch would change the file', () => {
    should(hasAnalyticsWrites(NO_ANALYTICS_WRITES)).be.false();
    should(hasAnalyticsWrites(writes({ drop: true }))).be.true();
    should(hasAnalyticsWrites(writes({ upserts: [row('a')] }))).be.true();
    should(hasAnalyticsWrites(writes({ forgets: ['a'] }))).be.true();
  });
});

describe('mergeAnalyticsWrites', () => {
  it('should keep only the last write that named a session', () => {
    // Arrange
    const earlier = writes({ upserts: [row('a', 1), row('b', 1)], forgets: ['c', 'd'] });
    const later = writes({ upserts: [row('a', 2), row('c', 2)], forgets: ['b'] });

    // Act
    const merged = mergeAnalyticsWrites(earlier, later);

    // Assert — a re-written, b forgotten after its write, c written after its forget, d untouched.
    should(merged).deepEqual(writes({ upserts: [row('a', 2), row('c', 2)], forgets: ['d', 'b'] }));
  });

  it('should let a drop supersede everything before it, and survive what follows it', () => {
    // Arrange
    const earlier = writes({ upserts: [row('a')], forgets: ['b'] });

    // Act
    const dropped = mergeAnalyticsWrites(earlier, writes({ drop: true }));
    const after = mergeAnalyticsWrites(dropped, writes({ upserts: [row('a', 2)] }));

    // Assert
    should(dropped).deepEqual(writes({ drop: true }));
    should(after).deepEqual(writes({ drop: true, upserts: [row('a', 2)] }));
  });

  it('should be the identity for an empty batch on either side', () => {
    // Arrange
    const batch = writes({ upserts: [row('a')], forgets: ['b'] });

    // Act and assert
    should(mergeAnalyticsWrites(NO_ANALYTICS_WRITES, batch)).deepEqual(batch);
    should(mergeAnalyticsWrites(batch, NO_ANALYTICS_WRITES)).deepEqual(batch);
  });
});
