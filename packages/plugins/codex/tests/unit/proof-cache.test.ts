/** The memory of which rollout is a ferret's: reused for a short while, pruned of what can no longer be reused. */
import { describe, expect, test } from 'bun:test';
import { ProofCache } from '../../daemon/lib/transcript/proof-cache.ts';

describe('ProofCache', () => {
  test('a proof is answered while it is younger than the reuse window, and never once it is as old as it', () => {
    const cache = new ProofCache<string, string>(5_000);
    cache.remember('f1', 'rollout-1', 1_000);

    expect(cache.fresh('f1', 1_000)).toBe('rollout-1');
    expect(cache.fresh('f1', 5_999)).toBe('rollout-1');
    expect(cache.fresh('f1', 6_000)).toBeUndefined();
    expect(cache.fresh('f2', 1_000)).toBeUndefined();
  });

  test('BG-042 remembering another ferret drops every proof too old to reuse, so the cache holds only the recent', () => {
    const cache = new ProofCache<string, string>(5_000);
    for (const [ferret, at] of [
      ['a', 0],
      ['b', 100],
      ['c', 1_000],
      ['d', 2_000],
    ] as const)
      cache.remember(ferret, `rollout-${ferret}`, at);
    expect(cache.size).toBe(4);

    // 5.4 s on, one more ferret is proved: the two proofs that can no longer be reused are dead weight and go with it.
    cache.remember('e', 'rollout-e', 5_400);

    expect(cache.size).toBe(3);
    expect(cache.fresh('e', 5_400)).toBe('rollout-e');
    expect(cache.fresh('d', 5_400)).toBe('rollout-d');
    expect(cache.fresh('a', 5_400)).toBeUndefined();
  });

  test('BG-042 forget drops one ferret’s proof and no other', () => {
    const cache = new ProofCache<string, string>(5_000);
    cache.remember('a', 'rollout-a', 0);
    cache.remember('b', 'rollout-b', 0);

    cache.forget('a');
    cache.forget('missing');

    expect(cache.size).toBe(1);
    expect(cache.fresh('b', 0)).toBe('rollout-b');
  });
});
