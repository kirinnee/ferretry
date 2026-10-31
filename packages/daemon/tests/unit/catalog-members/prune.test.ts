import { describe, it } from 'bun:test';
import should from 'should';
import { SHARE_KEEP_MS, pruneShares } from '../../../src/lib/catalog-members/prune.ts';
import { DAY, iso, sharesDoc, shareId, storedShare, T0 } from './support.ts';

describe('pruneShares', () => {
  it('should keep thirty days', () => {
    // Arrange / Act / Assert
    should(SHARE_KEEP_MS).equal(30 * DAY);
  });

  it('should drop a share that has been over for more than thirty days', () => {
    // Arrange
    const document = sharesDoc(
      storedShare(1, { state: 'ended', expiresAt: iso(T0 - 31 * DAY) }),
      storedShare(2, { state: 'spent', expiresAt: iso(T0 - 29 * DAY) }),
    );

    // Act
    const pruned = pruneShares(document, T0);

    // Assert
    should(pruned.shares.map(share => share.shareId)).eql([shareId(2)]);
  });

  it('should drop a share that expired long ago', () => {
    // Arrange
    const document = sharesDoc(storedShare(1, { expiresAt: iso(T0 - 40 * DAY) }));

    // Act / Assert
    should(pruneShares(document, T0).shares).eql([]);
  });

  it('should keep a live share however old it is', () => {
    // Arrange
    const document = sharesDoc(storedShare(1, { createdAt: iso(T0 - 90 * DAY), expiresAt: iso(T0 + DAY) }));

    // Act / Assert
    should(pruneShares(document, T0)).equal(document);
  });

  it('should hand back the same document when nothing is forgotten', () => {
    // Arrange
    const document = sharesDoc(storedShare(1), storedShare(2, { state: 'ended' }));

    // Act / Assert
    should(pruneShares(document, T0)).equal(document);
  });
});
