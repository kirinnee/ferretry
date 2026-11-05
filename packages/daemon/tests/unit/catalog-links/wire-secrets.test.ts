import { describe, it } from 'bun:test';
import {
  CatalogLinkPreviewSchema,
  CatalogLinkStoreStatusSchema,
  CatalogLinkUrlSchema,
  CreatedCatalogLinkSchema,
  OwnedCatalogLinkListSchema,
  OwnedCatalogLinkSchema,
} from '@ferretry/protocol';
import should from 'should';
import { z } from 'zod';
import { AUDITED_ROUTES } from '../../../src/lib/audit/routes.ts';

const names = (node: unknown, found: Set<string> = new Set()): Set<string> => {
  if (Array.isArray(node)) for (const child of node) names(child, found);
  else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && value !== null && typeof value === 'object')
        for (const property of Object.keys(value)) found.add(property);
      names(value, found);
    }
  }
  return found;
};

const SECRETISH = /url|key|token|bundle|secret|fragment/iu;
const fieldsOf = (schema: z.ZodType): string[] => [...names(z.toJSONSchema(schema))];

describe('the owner wire for links', () => {
  it("should hold a url in the mint's answer and Copy's alone", () => {
    should(fieldsOf(CreatedCatalogLinkSchema)).containEql('url');
    should(fieldsOf(CatalogLinkUrlSchema)).deepEqual(['url']);
  });

  it('should hold no url, key, token or bundle name in any other answer', () => {
    for (const schema of [
      OwnedCatalogLinkSchema,
      OwnedCatalogLinkListSchema,
      CatalogLinkStoreStatusSchema,
      CatalogLinkPreviewSchema,
    ])
      should(fieldsOf(schema).filter(name => SECRETISH.test(name))).deepEqual([]);
  });

  it('should name no field of the audit that could hold one', () => {
    const rules = AUDITED_ROUTES.filter(rule => rule.path.startsWith('/v1/catalog-links'));
    should(rules).have.length(5);
    for (const rule of rules) {
      const paths = Object.values(rule.responseFields ?? {}).flat();
      should(paths.filter(name => SECRETISH.test(name))).deepEqual([]);
      should(JSON.stringify(rule)).not.match(/bundle/iu);
    }
  });
});
