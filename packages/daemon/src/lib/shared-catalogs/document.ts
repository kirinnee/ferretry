/**
 * What this machine keeps about the catalogs it publishes (`state/catalogs/catalogs.json`), and the pure
 * rules that change it (docs/catalogs.md § The publisher side).
 *
 * The frozen item versions are NOT here: each is a content-addressed blob, written once and never
 * touched. This document lists them — digest, size, when, from where — so a damaged blob is found by
 * hashing it against the line here.
 *
 * ## One rule for the revision
 *
 * A catalog's `revision` goes up by exactly one on every change to what its manifest says — an item
 * added, a new version, a withdrawal, a rename, a new description — and never otherwise. `issuedAt` is
 * the instant of that change. An export signs both, so two exports with nothing between them are the
 * same bytes (Ed25519 is deterministic), and a reader that saw revision 7 refuses a signed 6.
 */
import {
  CATALOG_MAX_ITEMS,
  CATALOG_MAX_WITHDRAWN,
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
import { CatalogRefusal } from './refusal.ts';

export const CATALOGS_SCHEMA_VERSION = 1;

const StoredVersionSchema = z.strictObject({
  version: z.number().int().min(1),
  /** The digest the signed manifest lists: it covers the item's identity as well as its content. */
  digest: CatalogDigestSchema,
  /** The digest of the content alone, which is what a preview binds and what "same as before" compares. */
  contentDigest: CatalogDigestSchema,
  size: z.number().int().min(1),
  publishedAt: InstantSchema,
  summary: CatalogSummarySchema,
  source: CatalogSourceReferenceSchema,
});
export type StoredVersion = z.infer<typeof StoredVersionSchema>;

const StoredItemSchema = z.strictObject({
  itemId: SharedCatalogItemIdSchema,
  kind: z.enum(['skill', 'mcp']),
  name: CatalogItemNameSchema,
  harness: CatalogHarnessSchema.optional(),
  /** The person wrote the summary, so a new version keeps it instead of reading the source's again. */
  ownSummary: z.boolean(),
  withdrawnAt: InstantSchema.optional(),
  versions: z.array(StoredVersionSchema).min(1),
});
export type StoredItem = z.infer<typeof StoredItemSchema>;

const StoredCatalogSchema = z.strictObject({
  id: SharedCatalogIdSchema,
  name: CatalogLabelSchema,
  description: CatalogDescriptionSchema,
  visibility: z.literal('members'),
  revision: z.number().int().min(1),
  issuedAt: InstantSchema,
  createdAt: InstantSchema,
  items: z.array(StoredItemSchema),
});
export type StoredCatalog = z.infer<typeof StoredCatalogSchema>;

export const CatalogsDocumentSchema = z
  .strictObject({
    schemaVersion: z.literal(CATALOGS_SCHEMA_VERSION),
    catalogs: z.array(StoredCatalogSchema),
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
export type CatalogsDocument = z.infer<typeof CatalogsDocumentSchema>;

export const EMPTY_CATALOGS_DOCUMENT: CatalogsDocument = { schemaVersion: CATALOGS_SCHEMA_VERSION, catalogs: [] };

/** The latest version of an item. Every item has at least one. */
export const latestVersion = (item: StoredItem): StoredVersion =>
  item.versions[item.versions.length - 1] as StoredVersion;

export const liveItems = (catalog: StoredCatalog): readonly StoredItem[] =>
  catalog.items.filter(item => item.withdrawnAt === undefined);

/** Looks a catalog up by its id. */
export function findCatalog(document: CatalogsDocument, id: string): StoredCatalog {
  const catalog = document.catalogs.find(candidate => candidate.id === id);
  if (catalog === undefined) throw new CatalogRefusal('catalog_unknown', `There is no catalog ${id} on this machine.`);
  return catalog;
}

export function findItem(catalog: StoredCatalog, itemId: string): StoredItem {
  const item = catalog.items.find(candidate => candidate.itemId === itemId);
  if (item === undefined) throw new CatalogRefusal('item_unknown', `${catalog.name} has no item ${itemId}.`);
  return item;
}

/** The change a manifest sees: a new revision, made at `now` (never earlier than the one before). */
function bumped(catalog: StoredCatalog, now: string): StoredCatalog {
  return { ...catalog, revision: catalog.revision + 1, issuedAt: now > catalog.issuedAt ? now : catalog.issuedAt };
}

const replaceCatalog = (document: CatalogsDocument, next: StoredCatalog): CatalogsDocument => ({
  ...document,
  catalogs: document.catalogs.map(catalog => (catalog.id === next.id ? next : catalog)),
});

const replaceItem = (catalog: StoredCatalog, next: StoredItem): StoredCatalog => ({
  ...catalog,
  items: catalog.items.map(item => (item.itemId === next.itemId ? next : item)),
});

export interface NewCatalog {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly now: string;
}

export function withCatalog(document: CatalogsDocument, created: NewCatalog): CatalogsDocument {
  if (document.catalogs.some(catalog => catalog.name === created.name))
    throw new CatalogRefusal('name_taken', `You already have a catalog called ${created.name}.`);
  const catalog: StoredCatalog = {
    id: created.id,
    name: created.name,
    description: created.description,
    visibility: 'members',
    revision: 1,
    issuedAt: created.now,
    createdAt: created.now,
    items: [],
  };
  return { ...document, catalogs: [...document.catalogs, catalog] };
}

export function withoutCatalog(document: CatalogsDocument, id: string): CatalogsDocument {
  findCatalog(document, id);
  return { ...document, catalogs: document.catalogs.filter(catalog => catalog.id !== id) };
}

export interface CatalogPatch {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
}

/** A rename or a new description. Saying what it already is changes nothing, so the revision stays. */
export function withCatalogPatch(
  document: CatalogsDocument,
  id: string,
  patch: CatalogPatch,
  now: string,
): CatalogsDocument {
  const catalog = findCatalog(document, id);
  const name = patch.name ?? catalog.name;
  const description = patch.description ?? catalog.description;
  if (name === catalog.name && description === catalog.description) return document;
  if (name !== catalog.name && document.catalogs.some(other => other.id !== id && other.name === name))
    throw new CatalogRefusal('name_taken', `You already have a catalog called ${name}.`);
  return replaceCatalog(document, bumped({ ...catalog, name, description }, now));
}

/** Whether a live item of this kind already has this name: the manifest would refuse two. */
function nameTaken(catalog: StoredCatalog, kind: string, name: string, except?: string): boolean {
  return liveItems(catalog).some(item => item.kind === kind && item.name === name && item.itemId !== except);
}

export function withNewItem(
  document: CatalogsDocument,
  catalogId: string,
  item: StoredItem,
  now: string,
): CatalogsDocument {
  const catalog = findCatalog(document, catalogId);
  if (liveItems(catalog).length >= CATALOG_MAX_ITEMS)
    throw new CatalogRefusal('catalog_full', `A catalog holds at most ${CATALOG_MAX_ITEMS} items. Withdraw one first.`);
  if (nameTaken(catalog, item.kind, item.name))
    throw new CatalogRefusal(
      'name_taken',
      `${catalog.name} already has a ${item.kind === 'skill' ? 'skill' : 'MCP setup'} called ${item.name}. Publish a new version of it instead, or withdraw it first.`,
    );
  return replaceCatalog(document, bumped({ ...catalog, items: [...catalog.items, item] }, now));
}

export function withNewVersion(
  document: CatalogsDocument,
  catalogId: string,
  itemId: string,
  version: StoredVersion,
  now: string,
): CatalogsDocument {
  const catalog = findCatalog(document, catalogId);
  const item = findItem(catalog, itemId);
  if (item.withdrawnAt !== undefined)
    throw new CatalogRefusal('item_withdrawn', `${item.name} was withdrawn, so it takes no new version.`);
  return replaceCatalog(
    document,
    bumped(replaceItem(catalog, { ...item, versions: [...item.versions, version] }), now),
  );
}

export function withWithdrawn(
  document: CatalogsDocument,
  catalogId: string,
  itemId: string,
  now: string,
): CatalogsDocument {
  const catalog = findCatalog(document, catalogId);
  const item = findItem(catalog, itemId);
  if (item.withdrawnAt !== undefined) throw new CatalogRefusal('item_withdrawn', `${item.name} was already withdrawn.`);
  if (catalog.items.filter(other => other.withdrawnAt !== undefined).length >= CATALOG_MAX_WITHDRAWN)
    throw new CatalogRefusal('catalog_full', `A catalog remembers at most ${CATALOG_MAX_WITHDRAWN} withdrawn items.`);
  const next = bumped(catalog, now);
  return replaceCatalog(document, replaceItem(next, { ...item, withdrawnAt: next.issuedAt }));
}

/** Why a stored document cannot be used, in one line, or `null` when it parses. */
export function documentProblem(parsed: ReturnType<typeof CatalogsDocumentSchema.safeParse>): string | null {
  if (parsed.success) return null;
  const first = parsed.error.issues[0];
  const where = first === undefined || first.path.length === 0 ? '' : ` (at ${first.path.join('.')})`;
  return `${first?.message ?? 'it is malformed'}${where}`;
}
