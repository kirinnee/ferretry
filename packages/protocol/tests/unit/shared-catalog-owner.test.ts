import { describe, it } from 'bun:test';
import should from 'should';
import {
  AddCatalogItemRequestSchema,
  OwnedSharedItemListSchema,
  QuickAddAnswerSchema,
  QuickAddRequestSchema,
  QuickAddUndoneSchema,
  QuickAddUndoRequestSchema,
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

const CATALOG = `cat_${'A'.repeat(22)}`;
const TOKEN = `cqu_${'u'.repeat(22)}`;
const AT = '2026-01-01T00:00:00.000Z';

describe('the quick add request', () => {
  it('should take a source or an item id, and nothing that claims it is clean', () => {
    should(QuickAddRequestSchema.safeParse({ source: { kind: 'skill', skill: 'demo' } }).success).equal(true);
    should(QuickAddRequestSchema.safeParse({ itemId: ITEM }).success).equal(true);
    should(QuickAddRequestSchema.safeParse({ itemId: ITEM, clean: true }).success).equal(false);
    should(QuickAddRequestSchema.safeParse({ source: { kind: 'skill', skill: 'demo' }, itemId: ITEM }).success).equal(
      false,
    );
    should(QuickAddRequestSchema.safeParse({}).success).equal(false);
  });
});

describe('the quick add answers', () => {
  const added = {
    outcome: 'added',
    catalog: { catalogId: CATALOG, name: "studio's skills", revision: 2, created: true },
    itemId: ITEM,
    itemVersion: 1,
    digest: DIGEST,
    newItem: true,
    sourceChanged: false,
    undo: { token: TOKEN, expiresAt: AT },
  };

  it('should take each outcome and refuse one it does not know', () => {
    should(QuickAddAnswerSchema.safeParse(added).success).equal(true);
    should(
      QuickAddAnswerSchema.safeParse({ outcome: 'already', catalogId: CATALOG, itemId: ITEM, itemVersion: 1 }).success,
    ).equal(true);
    should(QuickAddAnswerSchema.safeParse({ outcome: 'review', reasons: ['needs-summary'] }).success).equal(true);
    should(QuickAddAnswerSchema.safeParse({ outcome: 'review', reasons: [] }).success).equal(false);
    should(QuickAddAnswerSchema.safeParse({ outcome: 'review', reasons: ['bored'] }).success).equal(false);
    should(QuickAddAnswerSchema.safeParse({ ...added, extra: 1 }).success).equal(false);
  });

  it('should hold the token to its shape, in the answer and in an Undo request', () => {
    should(QuickAddAnswerSchema.safeParse({ ...added, undo: { token: 'cqu_short', expiresAt: AT } }).success).equal(
      false,
    );
    should(QuickAddUndoRequestSchema.safeParse({ token: TOKEN }).success).equal(true);
    should(QuickAddUndoRequestSchema.safeParse({ token: 'cqu_short' }).success).equal(false);
    should(QuickAddUndoRequestSchema.safeParse({ token: TOKEN, extra: 1 }).success).equal(false);
  });

  it('should say how an Undo went, in one of two modes', () => {
    const done = { catalogId: CATALOG, itemId: ITEM, mode: 'retracted', revision: 3, itemRemoved: true };
    should(QuickAddUndoneSchema.safeParse(done).success).equal(true);
    should(QuickAddUndoneSchema.safeParse({ ...done, mode: 'withdrawn' }).success).equal(true);
    should(QuickAddUndoneSchema.safeParse({ ...done, mode: 'erased' }).success).equal(false);
  });
});
