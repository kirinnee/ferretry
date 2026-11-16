/**
 * R2 (M-1): the one expansion of a profile's bases (`flattenProfile`, `resolveProfile`) answers a 20-deep diamond (2^20
 * paths) at once. What it answers is tests/unit/lib/account-layering-expansion.test.ts, on a 4-deep one; this file holds
 * only the time.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { expandStack, type StackLayer } from '../../../contract/index.ts';
import { flattenProfile, resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { catalogueOf, lattice, latticeItems } from '../../support/layering-lattice.ts';

/** The deadline: a pure answer on a 20-deep diamond is milliseconds; reading every path is minutes. */
const DEADLINE_MS = 1000;

describe('R2 flattenProfile — a 20-deep diamond (2^20 paths) answers at once', () => {
  it('R2 should flatten it inside the deadline, the newest item last', () => {
    const catalogue = catalogueOf(lattice(20), latticeItems(20));

    const started = performance.now();
    const actual = flattenProfile(catalogue, 'a0');
    const took = performance.now() - started;

    if (!actual.ok) throw new Error('expected layers');
    should(actual.layers.length).equal(41);
    should(new Set(actual.layers.map(layer => layer.reference)).size).equal(41);
    should(actual.layers.at(-1)?.reference).equal('mcp/a0');
    should(took).be.below(DEADLINE_MS);
  });

  it('R2 should read each layer text of each profile once, however many paths lead to it', () => {
    // Arrange
    const graph = lattice(20);
    let reads = 0;

    // Act
    const stack = expandStack<string, never>(
      name => graph[name],
      (text): StackLayer<string, never> => {
        reads++;
        return text.startsWith('profile/')
          ? { kind: 'base', name: text.slice('profile/'.length) }
          : { kind: 'leaf', key: text, item: text };
      },
      'a0',
    );

    // Assert — 41 profiles are reachable; the 39 above the last level hold 3 texts each, the two on it 1 each.
    should(stack.ok).be.true();
    should(reads).equal(39 * 3 + 2);
  });

  it('R2 should resolve a profile through the diamond inside the deadline (what every apply does)', () => {
    const model = catalogueOf(lattice(20), latticeItems(20));

    const started = performance.now();
    const actual = resolveProfile({ model, profile: 'a0', harness: 'claude' });
    const took = performance.now() - started;

    should(actual.ok).be.true();
    should(took).be.below(DEADLINE_MS);
  });
});
