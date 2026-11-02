import { describe, it } from 'bun:test';
import { CATALOG_SHARE_REFUSALS } from '@ferretry/protocol';
import should from 'should';
import {
  CATALOG_MEMBER_REFUSALS,
  CATALOG_MEMBER_STATUS,
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

describe('CATALOG_MEMBER_STATUS', () => {
  it('should answer every refusal there is, and only with a status a person can act on', () => {
    // Arrange / Act / Assert
    should(Object.keys(CATALOG_MEMBER_STATUS).sort()).eql([...CATALOG_MEMBER_REFUSALS].sort());
    should(CATALOG_MEMBER_STATUS).eql({
      share_refused: 409,
      share_other_member: 409,
      share_new_member: 409,
      member_exists: 409,
      members_full: 409,
      member_unknown: 404,
      member_key_unknown: 404,
      catalog_unknown: 404,
      share_unknown: 404,
      shares_full: 409,
      catalogs_full: 409,
      share_link_unavailable: 503,
      store_damaged: 500,
    });
  });
});
