import { describe, it } from 'bun:test';
import should from 'should';
import {
  AddCatalogItemRequestSchema,
  OwnedSharedItemListSchema,
  UpdateCatalogRequestSchema,
} from '../../src/lib/index.ts';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const ITEM = `itm_${'B'.repeat(22)}`;
const PUBLISHER = `fy_daemon_${'P'.repeat(43)}`;

describe('the add-to-catalog request', () => {
  it('should take a new source with its digest', () => {
    should(
      AddCatalogItemRequestSchema.safeParse({ source: { kind: 'skill', skill: 'demo' }, digest: DIGEST }).success,
    ).equal(true);
  });

  it('should take an item this machine keeps, at a version', () => {
    should(AddCatalogItemRequestSchema.safeParse({ itemId: ITEM, version: 2 }).success).equal(true);
  });

  it('should refuse a body that mixes the two arms, or a version below one', () => {
    should(
      AddCatalogItemRequestSchema.safeParse({
        source: { kind: 'skill', skill: 'demo' },
        digest: DIGEST,
        itemId: ITEM,
        version: 1,
      }).success,
    ).equal(false);
    should(AddCatalogItemRequestSchema.safeParse({ itemId: ITEM, version: 1, digest: DIGEST }).success).equal(false);
    should(AddCatalogItemRequestSchema.safeParse({ itemId: ITEM, version: 0 }).success).equal(false);
  });
});

describe('the catalog update request', () => {
  it('should take the default role and refuse any other', () => {
    should(UpdateCatalogRequestSchema.safeParse({ role: 'default' }).success).equal(true);
    should(UpdateCatalogRequestSchema.safeParse({ role: 'collection' }).success).equal(false);
  });
});

describe('the shared item list', () => {
  it('should be strict about keys it does not know', () => {
    should(OwnedSharedItemListSchema.safeParse({ publisher: PUBLISHER, items: [] }).success).equal(true);
    should(OwnedSharedItemListSchema.safeParse({ publisher: PUBLISHER, items: [], extra: 1 }).success).equal(false);
  });
});
