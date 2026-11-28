/**
 * R2 (M-1): a profile's derived scope (`profileScope`, `layersScope`) folds a base reached by many paths once, so a
 * 20-deep diamond (2^20 paths) is answered at once. What the fold answers is tests/unit/lib/account-scope-memo.test.ts,
 * on a 4-deep one; this file holds only the time.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { layersScope, profileScope } from '../../../daemon/lib/account/scope.ts';
import { catalogueOf, diamond } from '../../support/scope-diamond.ts';

describe('R2 the scope fold answers a 20-deep diamond at once', () => {
  it('R2 should fold a draft that edits the diamond’s bottom to name its top (a loop cut under every path) inside the deadline', () => {
    // a0 reaches the Claude leaf; every path of a0 ends back at b20, which is on the chain, so a fold that remembers
    // nothing below a cut walks all 2^20 of them.
    const started = performance.now();
    const actual = layersScope(catalogueOf(diamond(20)), ['profile/a0', 'mcp/cx'], 'b20');
    const took = performance.now() - started;

    should(actual).deepEqual({
      kind: 'mixed',
      layers: [
        { harness: 'claude', layer: 'profile/a0' },
        { harness: 'codex', layer: 'mcp/cx' },
      ],
    });
    should(took).be.below(1000);
  });

  it('R2 should fold a 20-deep diamond (2^20 paths) inside the deadline, keeping a Claude leaf at the bottom', () => {
    const started = performance.now();
    const actual = profileScope(catalogueOf(diamond(20)), 'a0');
    const took = performance.now() - started;

    should(actual).deepEqual({ kind: 'scoped', scope: 'claude' });
    should(took).be.below(1000);
  });
});
