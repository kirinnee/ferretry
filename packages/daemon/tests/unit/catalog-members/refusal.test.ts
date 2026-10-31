import { describe, it } from 'bun:test';
import { CATALOG_SHARE_REFUSALS } from '@ferretry/protocol';
import should from 'should';
import {
  CATALOG_MEMBER_REFUSALS,
  CatalogMemberRefusal,
  isShareRefusal,
} from '../../../src/lib/catalog-members/refusal.ts';

describe('CatalogMemberRefusal', () => {
  it('should carry the code and the sentence a person reads', () => {
    // Arrange / Act
    const refusal = new CatalogMemberRefusal('shares_full', 'End one first.');

    // Assert
    should(refusal).be.instanceOf(Error);
    should(refusal.refusal).equal('shares_full');
    should(refusal.message).equal('End one first.');
    should(refusal.name).equal('CatalogMemberRefusal');
  });

  it("should list every protocol refusal and this machine's own four", () => {
    // Arrange / Act / Assert
    should([...CATALOG_MEMBER_REFUSALS]).eql([
      ...CATALOG_SHARE_REFUSALS,
      'shares_full',
      'catalogs_full',
      'share_link_unavailable',
      'store_damaged',
    ]);
  });
});

describe('isShareRefusal', () => {
  it('should be true for each refusal the wire knows', () => {
    // Arrange / Act / Assert
    for (const code of CATALOG_SHARE_REFUSALS) should(isShareRefusal(code)).be.true();
  });

  it('should be false for the refusals only this machine makes', () => {
    // Arrange / Act / Assert
    for (const code of ['shares_full', 'catalogs_full', 'share_link_unavailable', 'store_damaged'] as const)
      should(isShareRefusal(code)).be.false();
  });
});
