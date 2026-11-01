/**
 * The version 1 catalogs document: what `state/catalogs/catalogs.json` was before the shared item table.
 *
 * It is kept ONLY so the migration (`migrate.ts`) can read it and the file store can tell a v1 file from a
 * v2 one. Nothing writes this shape any more. An older daemon holds exactly this schema, with
 * `schemaVersion` the literal 1, which is why it refuses a v2 file instead of misreading it.
 */
import {
  CatalogDescriptionSchema,
  CatalogDigestSchema,
  CatalogHarnessSchema,
  CatalogLabelSchema,
  CatalogSourceReferenceSchema,
  CatalogSummarySchema,
  CatalogItemNameSchema,
  InstantSchema,
  SharedCatalogIdSchema,
  SharedCatalogItemIdSchema,
} from '@ferretry/protocol';
import { z } from 'zod';

export const CATALOGS_SCHEMA_VERSION_V1 = 1;

const StoredVersionV1Schema = z.strictObject({
  version: z.number().int().min(1),
  /** The digest the signed manifest lists: it covers the item's identity as well as its content. */
  digest: CatalogDigestSchema,
  contentDigest: CatalogDigestSchema,
  size: z.number().int().min(1),
  publishedAt: InstantSchema,
  summary: CatalogSummarySchema,
  source: CatalogSourceReferenceSchema,
});

const StoredItemV1Schema = z.strictObject({
  itemId: SharedCatalogItemIdSchema,
  kind: z.enum(['skill', 'mcp']),
  name: CatalogItemNameSchema,
  harness: CatalogHarnessSchema.optional(),
  ownSummary: z.boolean(),
  withdrawnAt: InstantSchema.optional(),
  versions: z.array(StoredVersionV1Schema).min(1),
});

const StoredCatalogV1Schema = z.strictObject({
  id: SharedCatalogIdSchema,
  name: CatalogLabelSchema,
  description: CatalogDescriptionSchema,
  publisherName: CatalogLabelSchema,
  visibility: z.literal('members'),
  revision: z.number().int().min(1),
  issuedAt: InstantSchema,
  createdAt: InstantSchema,
  items: z.array(StoredItemV1Schema),
});

export const CatalogsDocumentV1Schema = z
  .strictObject({
    schemaVersion: z.literal(CATALOGS_SCHEMA_VERSION_V1),
    catalogs: z.array(StoredCatalogV1Schema),
  })
  .check(ctx => {
    const issue = (message: string): void => {
      ctx.issues.push({ code: 'custom', message, input: ctx.value, path: ['catalogs'] });
    };
    const catalogIds = new Set<string>();
    const itemIds = new Set<string>();
    for (const catalog of ctx.value.catalogs) {
      if (catalogIds.has(catalog.id)) {
        issue(`${catalog.id} is listed twice`);
        return;
      }
      catalogIds.add(catalog.id);
      for (const item of catalog.items) {
        if (itemIds.has(item.itemId)) {
          issue(`${item.itemId} is listed twice`);
          return;
        }
        itemIds.add(item.itemId);
        if (item.versions.some((version, index) => version.version !== index + 1)) {
          issue(`${item.itemId} does not have versions 1, 2, 3 in order`);
          return;
        }
      }
    }
  });
export type CatalogsDocumentV1 = z.infer<typeof CatalogsDocumentV1Schema>;
