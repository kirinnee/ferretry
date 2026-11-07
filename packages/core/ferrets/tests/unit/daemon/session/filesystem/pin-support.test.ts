import { describe, it } from 'bun:test';
import type { BigIntStats } from 'node:fs';
import should from 'should';
import { componentIdentity } from '../../../../src/adapters/session/filesystem/pin-support.ts';

/**
 * A walked component's identity keeps everything the `bigint` stat recorded.
 *
 * The ABA check compares change times taken before and after Git answers. On a filesystem with fine-grained
 * timestamps two renames a fraction of a millisecond apart DO leave different ctimes, so rounding to the
 * millisecond would throw away the very evidence the kernel kept.
 */
describe('componentIdentity', () => {
  /** The fields an identity is made from, as a `bigint` `fstat` reports them. */
  const stats = (ctimeNs: bigint): BigIntStats =>
    ({ dev: 7n, ino: 42n, mode: 0o40755n, ctimeNs, ctimeMs: ctimeNs / 1_000_000n }) as unknown as BigIntStats;

  it('should tell apart two change times inside the same millisecond', () => {
    // Arrange: the moment a component was pinned, and the moment a round trip re-stamped it 1 ns later.
    const pinned = stats(1_700_000_000_000_000_000n);
    const restamped = stats(1_700_000_000_000_000_001n);

    // Act
    const before = componentIdentity(pinned);
    const after = componentIdentity(restamped);

    // Assert: compared as primitives, because `should`'s deep equality sees every bigint as an empty object.
    should(before.ctimeNs).not.equal(after.ctimeNs);
  });

  it('should keep the device, inode and mode exactly', () => {
    // Act
    const identity = componentIdentity(stats(5n));

    // Assert
    should(identity.dev).equal(7n);
    should(identity.ino).equal(42n);
    should(identity.ctimeNs).equal(5n);
    should(identity.mode).equal(0o40755);
  });
});
