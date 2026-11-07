import { describe, expect, test } from 'bun:test';
import type { BigIntStats } from 'node:fs';
import { componentIdentity } from '../../../host/adapters/pinned/pin-support.ts';

/**
 * A walked component's identity keeps everything the `bigint` stat recorded (today's pin-support test, ported).
 *
 * The ABA check compares change times taken before and after Git answers. On a filesystem with fine-grained
 * timestamps two renames a fraction of a millisecond apart DO leave different ctimes, so rounding to the
 * millisecond would throw away the very evidence the kernel kept.
 */
describe('componentIdentity', () => {
  /** The fields an identity is made from, as a `bigint` `fstat` reports them. */
  const stats = (ctimeNs: bigint): BigIntStats =>
    ({ dev: 7n, ino: 42n, mode: 0o40755n, ctimeNs, ctimeMs: ctimeNs / 1_000_000n }) as unknown as BigIntStats;

  test('should tell apart two change times inside the same millisecond', () => {
    // Arrange: the moment a component was pinned, and the moment a round trip re-stamped it 1 ns later.
    const before = componentIdentity(stats(1_700_000_000_000_000_000n));
    const after = componentIdentity(stats(1_700_000_000_000_000_001n));
    // Assert: compared as primitives.
    expect(before.ctimeNs).not.toBe(after.ctimeNs);
  });

  test('should keep the device, inode and mode exactly', () => {
    const identity = componentIdentity(stats(5n));
    expect(identity.dev).toBe(7n);
    expect(identity.ino).toBe(42n);
    expect(identity.ctimeNs).toBe(5n);
    expect(identity.mode).toBe(0o40755);
  });
});
