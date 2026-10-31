import { describe, it } from 'bun:test';
import should from 'should';
import * as barrel from '../../../src/lib/catalog-members/index.ts';
import * as document from '../../../src/lib/catalog-members/document.ts';
import { shareLinkTarget } from '../../../src/lib/catalog-members/link-target.ts';
import * as refusal from '../../../src/lib/catalog-members/refusal.ts';
import { CatalogMemberService } from '../../../src/lib/catalog-members/service.ts';

describe('the catalog-members barrel', () => {
  it('should export the documents and their schemas from document.ts', () => {
    // Arrange / Act / Assert
    should(barrel.CATALOG_MEMBERS_SCHEMA_VERSION).equal(document.CATALOG_MEMBERS_SCHEMA_VERSION);
    should(barrel.CATALOG_SHARES_SCHEMA_VERSION).equal(document.CATALOG_SHARES_SCHEMA_VERSION);
    should(barrel.EMPTY_MEMBERS_DOCUMENT).equal(document.EMPTY_MEMBERS_DOCUMENT);
    should(barrel.EMPTY_SHARES_DOCUMENT).equal(document.EMPTY_SHARES_DOCUMENT);
    should(barrel.MembersDocumentSchema).equal(document.MembersDocumentSchema);
    should(barrel.SharesDocumentSchema).equal(document.SharesDocumentSchema);
  });

  it('should export the refusal, the link target and the service', () => {
    // Arrange / Act / Assert
    should(barrel.CatalogMemberRefusal).equal(refusal.CatalogMemberRefusal);
    should(barrel.CATALOG_MEMBER_REFUSALS).equal(refusal.CATALOG_MEMBER_REFUSALS);
    should(barrel.shareLinkTarget).equal(shareLinkTarget);
    should(barrel.CatalogMemberService).equal(CatalogMemberService);
  });
});
