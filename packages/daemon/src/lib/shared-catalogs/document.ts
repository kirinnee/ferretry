/**
 * What this machine keeps about the catalogs it publishes (`state/catalogs/catalogs.json`, schema version 2),
 * and the pure rules that change it (docs/catalogs.md § The publisher side).
 *
 * ## One table of items, listed by catalogs
 *
 * An item (its name, its versions, which version is current) is kept ONCE, in `items`. A catalog does not
 * hold items: it holds `entries`, which point at them, in the order its manifest lists them. An item
 * can therefore be listed by more than one catalog, and a version is one record.
 *
 * ## Two digests per version
 *
 * The signed item names its catalog (`catalogId` is in its head), so the same content has a different
 * digest in every catalog that lists it, and the format cannot change without older installers refusing
 * it. So a version holds:
 *
 * - `contentDigest`: the item with its catalog, id and version number normalised away. The frozen file on
 *   disk is this one copy.
 * - `bindings[catalogId]`: the digest and size of the item as THAT catalog's manifest lists it. Turning the
 *   shared copy into a catalog's item is a pure change of three head fields (`freeze.ts`).
 *
 * ## One rule for the revision
 *
 * A catalog's `revision` goes up by exactly one on every change to what its manifest says — an item
 * added, a new version of an item it lists live, a withdrawal, a rename, a new description, a new
 * publisher name — and never otherwise. `issuedAt` is the instant of that change. An export signs both, so
 * two exports with nothing between them are the same bytes (Ed25519 is deterministic), and a reader that
 * saw revision 7 refuses a signed 6.
 *
 * Every change below returns the whole next document, so one atomic write carries every catalog it bumped.
 */
import {
  CATALOGS_MAX_PER_PUBLISHER,
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
  SHARED_ITEMS_MAX,
  SharedCatalogIdSchema,
  SharedCatalogItemIdSchema,
} from '@ferretry/protocol';
import { z } from 'zod';
import { NORMALISED_CATALOG_ID, NORMALISED_ITEM_ID } from './freeze.ts';
import { CatalogRefusal } from './refusal.ts';

export const CATALOGS_SCHEMA_VERSION = 2;

const BindingSchema = z.strictObject({
  /** The digest the catalog's signed manifest lists: it covers the item's catalog, id and version number. */
  digest: CatalogDigestSchema,
  size: z.number().int().min(1),
});
export type CatalogBinding = z.infer<typeof BindingSchema>;

const StoredVersionSchema = z.strictObject({
  version: z.number().int().min(1),
  publishedAt: InstantSchema,
  summary: CatalogSummarySchema,
  source: CatalogSourceReferenceSchema,
  /** The digest of the shared copy: the item with its catalog, id and version number normalised. */
  contentDigest: CatalogDigestSchema,
  /** Bytes of that shared copy. For display only. */
  size: z.number().int().min(1),
  fileCount: z.number().int().min(0).optional(),
  /** Set by a later slice (retiring a version); the schema is ready for it. */
  retiredAt: InstantSchema.optional(),
  bindings: z.record(SharedCatalogIdSchema, BindingSchema),
});
export type StoredVersion = z.infer<typeof StoredVersionSchema>;

const StoredSharedItemSchema = z.strictObject({
  itemId: SharedCatalogItemIdSchema,
  kind: z.enum(['skill', 'mcp']),
  name: CatalogItemNameSchema,
  harness: CatalogHarnessSchema.optional(),
  /** The person wrote the summary, so a new version keeps it instead of reading the source's again. */
  ownSummary: z.boolean(),
  createdAt: InstantSchema,
  /** The version every catalog that lists this item live puts in its manifest. */
  current: z.number().int().min(1),
  versions: z.array(StoredVersionSchema).min(1),
});
export type StoredSharedItem = z.infer<typeof StoredSharedItemSchema>;

const CatalogEntrySchema = z.strictObject({
  itemId: SharedCatalogItemIdSchema,
  addedAt: InstantSchema,
  withdrawnAt: InstantSchema.optional(),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

const StoredCatalogSchema = z.strictObject({
  id: SharedCatalogIdSchema,
  name: CatalogLabelSchema,
  description: CatalogDescriptionSchema,
  /** What the signed manifest calls this machine. Kept here so two exports of one revision are the same bytes. */
  publisherName: CatalogLabelSchema,
  visibility: z.literal('members'),
  revision: z.number().int().min(1),
  issuedAt: InstantSchema,
  createdAt: InstantSchema,
  /** In the order the manifest lists them. */
  entries: z.array(CatalogEntrySchema),
});
export type StoredCatalog = z.infer<typeof StoredCatalogSchema>;

/** Why an id may not be used, when it is the placeholder a shared copy is stored under. */
export function placeholderProblem(kind: 'catalog' | 'item', id: string): string | undefined {
  const placeholder = kind === 'catalog' ? NORMALISED_CATALOG_ID : NORMALISED_ITEM_ID;
  return id === placeholder
    ? `${id} is the placeholder id a shared copy is stored under, so it cannot be a ${kind} id`
    : undefined;
}

/** The first thing wrong with a parsed document, or `undefined`: the rules a shape alone cannot say. */
function firstProblem(document: {
  readonly defaultCatalogId?: string | undefined;
  readonly items: readonly StoredSharedItem[];
  readonly catalogs: readonly StoredCatalog[];
}): string | undefined {
  const catalogIds = new Set<string>();
  for (const catalog of document.catalogs) {
    const placeholder = placeholderProblem('catalog', catalog.id);
    if (placeholder !== undefined) return placeholder;
    if (catalogIds.has(catalog.id)) return `${catalog.id} is listed twice`;
    catalogIds.add(catalog.id);
  }
  if (document.defaultCatalogId !== undefined && !catalogIds.has(document.defaultCatalogId))
    return `the default catalog ${document.defaultCatalogId} does not exist`;

  const items = new Map<string, StoredSharedItem>();
  for (const item of document.items) {
    const placeholder = placeholderProblem('item', item.itemId);
    if (placeholder !== undefined) return placeholder;
    if (items.has(item.itemId)) return `${item.itemId} is listed twice`;
    items.set(item.itemId, item);
    if (item.versions.some((version, index) => version.version !== index + 1))
      return `${item.itemId} does not have versions 1, 2, 3 in order`;
    const current = item.versions.find(version => version.version === item.current);
    if (current === undefined) return `${item.itemId} has no version ${String(item.current)}, which is its current one`;
    if (current.retiredAt !== undefined) return `${item.itemId} has a retired version as its current one`;
  }

  const listedBy = new Map<string, Set<string>>();
  for (const catalog of document.catalogs) {
    const seen = new Set<string>();
    const names = new Set<string>();
    let live = 0;
    let withdrawn = 0;
    for (const entry of catalog.entries) {
      const item = items.get(entry.itemId);
      if (item === undefined) return `${catalog.name} lists ${entry.itemId}, which is not an item`;
      if (seen.has(entry.itemId)) return `${catalog.name} lists ${entry.itemId} twice`;
      seen.add(entry.itemId);
      const lists = listedBy.get(entry.itemId) ?? new Set<string>();
      lists.add(catalog.id);
      listedBy.set(entry.itemId, lists);
      if (entry.withdrawnAt !== undefined) {
        withdrawn += 1;
        continue;
      }
      live += 1;
      const key = JSON.stringify([item.kind, item.name]);
      if (names.has(key)) return `${catalog.name} lists two live ${item.kind} items called ${item.name}`;
      names.add(key);
    }
    if (live > CATALOG_MAX_ITEMS) return `${catalog.name} lists more than ${String(CATALOG_MAX_ITEMS)} live items`;
    if (withdrawn > CATALOG_MAX_WITHDRAWN)
      return `${catalog.name} remembers more than ${String(CATALOG_MAX_WITHDRAWN)} withdrawn items`;
  }

  for (const item of document.items) {
    const lists = listedBy.get(item.itemId) ?? new Set<string>();
    for (const version of item.versions) {
      for (const catalogId of lists)
        if (version.bindings[catalogId] === undefined)
          return `${item.itemId} version ${String(version.version)} has no digest for ${catalogId}, which lists it`;
      for (const catalogId of Object.keys(version.bindings))
        if (!lists.has(catalogId))
          return `${item.itemId} version ${String(version.version)} has a digest for ${catalogId}, which does not list it`;
    }
  }
  return undefined;
}

export const CatalogsDocumentSchema = z
  .strictObject({
    schemaVersion: z.literal(CATALOGS_SCHEMA_VERSION),
    defaultCatalogId: SharedCatalogIdSchema.optional(),
    items: z.array(StoredSharedItemSchema),
    catalogs: z.array(StoredCatalogSchema),
  })
  .check(ctx => {
    const problem = firstProblem(ctx.value);
    if (problem !== undefined)
      ctx.issues.push({ code: 'custom', message: problem, input: ctx.value, path: ['catalogs'] });
  });
export type CatalogsDocument = z.infer<typeof CatalogsDocumentSchema>;

export const EMPTY_CATALOGS_DOCUMENT: CatalogsDocument = {
  schemaVersion: CATALOGS_SCHEMA_VERSION,
  items: [],
  catalogs: [],
};

/** The newest version of an item. Every item has at least one. */
export const latestVersion = (item: StoredSharedItem): StoredVersion =>
  item.versions[item.versions.length - 1] as StoredVersion;

/** The version a manifest lists: the schema guarantees there is one. */
export const currentVersion = (item: StoredSharedItem): StoredVersion =>
  item.versions.find(version => version.version === item.current) as StoredVersion;

/** An item of the table, or the refusal that this machine keeps none by that id. */
export function findItem(document: CatalogsDocument, itemId: string): StoredSharedItem {
  const item = document.items.find(candidate => candidate.itemId === itemId);
  if (item === undefined) throw new CatalogRefusal('item_unknown', `There is no item ${itemId} on this machine.`);
  return item;
}

/** Whether a catalog is the default (where one tap adds) or one of the others. Derived, never stored. */
export const roleOf = (document: CatalogsDocument, catalogId: string): 'default' | 'collection' =>
  document.defaultCatalogId === catalogId ? 'default' : 'collection';

/** The digest and size a catalog's manifest lists for this version: the schema guarantees one for every entry. */
export const bindingOf = (version: StoredVersion, catalogId: string): CatalogBinding =>
  version.bindings[catalogId] as CatalogBinding;

export const liveEntries = (catalog: StoredCatalog): readonly CatalogEntry[] =>
  catalog.entries.filter(entry => entry.withdrawnAt === undefined);

/** Looks a catalog up by its id. */
export function findCatalog(document: CatalogsDocument, id: string): StoredCatalog {
  const catalog = document.catalogs.find(candidate => candidate.id === id);
  if (catalog === undefined) throw new CatalogRefusal('catalog_unknown', `There is no catalog ${id} on this machine.`);
  return catalog;
}

/** The catalog's line for an item, or the refusal that it lists none. */
export function findEntry(catalog: StoredCatalog, itemId: string): CatalogEntry {
  const entry = catalog.entries.find(candidate => candidate.itemId === itemId);
  if (entry === undefined) throw new CatalogRefusal('item_unknown', `${catalog.name} has no item ${itemId}.`);
  return entry;
}

/** An item of the table. Only called for an id an entry names, so the schema guarantees it is there. */
export const itemOf = (document: CatalogsDocument, itemId: string): StoredSharedItem =>
  document.items.find(item => item.itemId === itemId) as StoredSharedItem;

/** Every catalog that has a line for this item, withdrawn or not: each needs a digest for every version. */
export const catalogsListing = (document: CatalogsDocument, itemId: string): readonly StoredCatalog[] =>
  document.catalogs.filter(catalog => catalog.entries.some(entry => entry.itemId === itemId));

/** The change a manifest sees: a new revision, made at `now` (never earlier than the one before). */
function bumped(catalog: StoredCatalog, now: string): StoredCatalog {
  return { ...catalog, revision: catalog.revision + 1, issuedAt: now > catalog.issuedAt ? now : catalog.issuedAt };
}

const replaceCatalog = (document: CatalogsDocument, next: StoredCatalog): CatalogsDocument => ({
  ...document,
  catalogs: document.catalogs.map(catalog => (catalog.id === next.id ? next : catalog)),
});

export interface NewCatalog {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly publisherName: string;
  readonly now: string;
}

/**
 * `catalogs_full` is the cap on catalogs this machine keeps (256). `catalog_full` is a different limit: the items
 * one catalog holds. An app naming either must say which, because the remedy differs.
 */
export function withCatalog(document: CatalogsDocument, created: NewCatalog): CatalogsDocument {
  if (document.catalogs.length >= CATALOGS_MAX_PER_PUBLISHER)
    throw new CatalogRefusal(
      'catalogs_full',
      `This machine keeps at most ${CATALOGS_MAX_PER_PUBLISHER} catalogs. Delete one first.`,
    );
  if (document.catalogs.some(catalog => catalog.name === created.name))
    throw new CatalogRefusal('name_taken', `You already have a catalog called ${created.name}.`);
  const catalog: StoredCatalog = {
    id: created.id,
    name: created.name,
    description: created.description,
    publisherName: created.publisherName,
    visibility: 'members',
    revision: 1,
    issuedAt: created.now,
    createdAt: created.now,
    entries: [],
  };
  return { ...document, catalogs: [...document.catalogs, catalog] };
}

/**
 * Takes the catalog, its lines and its digests out. The items and their versions STAY in the table: they
 * are the person's frozen work, and the default catalog is forgotten if this was it.
 */
export function withoutCatalog(document: CatalogsDocument, id: string): CatalogsDocument {
  findCatalog(document, id);
  const { defaultCatalogId, ...rest } = document;
  return {
    ...rest,
    ...(defaultCatalogId === undefined || defaultCatalogId === id ? {} : { defaultCatalogId }),
    items: document.items.map(item => ({
      ...item,
      versions: item.versions.map(version => {
        const { [id]: _removed, ...bindings } = version.bindings;
        return { ...version, bindings };
      }),
    })),
    catalogs: document.catalogs.filter(catalog => catalog.id !== id),
  };
}

export interface CatalogPatch {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly publisherName?: string | undefined;
}

/** A rename, a new description or a new publisher name. Saying what it already is changes nothing, so the revision stays. */
export function withCatalogPatch(
  document: CatalogsDocument,
  id: string,
  patch: CatalogPatch,
  now: string,
): CatalogsDocument {
  const catalog = findCatalog(document, id);
  const name = patch.name ?? catalog.name;
  const description = patch.description ?? catalog.description;
  const publisherName = patch.publisherName ?? catalog.publisherName;
  if (name === catalog.name && description === catalog.description && publisherName === catalog.publisherName)
    return document;
  if (name !== catalog.name && document.catalogs.some(other => other.id !== id && other.name === name))
    throw new CatalogRefusal('name_taken', `You already have a catalog called ${name}.`);
  return replaceCatalog(document, bumped({ ...catalog, name, description, publisherName }, now));
}

/** Whether a live item of this kind already has this name in the catalog: the manifest would refuse two. */
function nameTaken(document: CatalogsDocument, catalog: StoredCatalog, kind: string, name: string): boolean {
  return liveEntries(catalog).some(entry => {
    const item = itemOf(document, entry.itemId);
    return item.kind === kind && item.name === name;
  });
}

/** Refuses unless the catalog has room for one more live item of this kind and name. */
function assertRoom(document: CatalogsDocument, catalog: StoredCatalog, item: StoredSharedItem): void {
  if (liveEntries(catalog).length >= CATALOG_MAX_ITEMS)
    throw new CatalogRefusal('catalog_full', `A catalog holds at most ${CATALOG_MAX_ITEMS} items. Withdraw one first.`);
  if (nameTaken(document, catalog, item.kind, item.name))
    throw new CatalogRefusal(
      'name_taken',
      `${catalog.name} already has a ${item.kind === 'skill' ? 'skill' : 'MCP setup'} called ${item.name}. Publish a new version of it instead, or withdraw it first.`,
    );
}

/** A new item, listed live by one catalog. The item arrives with its digest for that catalog. */
export function withNewItem(
  document: CatalogsDocument,
  catalogId: string,
  item: StoredSharedItem,
  now: string,
): CatalogsDocument {
  const catalog = findCatalog(document, catalogId);
  if (document.items.length >= SHARED_ITEMS_MAX)
    throw new CatalogRefusal('items_full', `This machine keeps at most ${SHARED_ITEMS_MAX} shared items.`);
  assertRoom(document, catalog, item);
  const next = bumped({ ...catalog, entries: [...catalog.entries, { itemId: item.itemId, addedAt: now }] }, now);
  return replaceCatalog({ ...document, items: [...document.items, item] }, next);
}

function bindingFor(bindings: Readonly<Record<number, CatalogBinding>>, version: number): CatalogBinding {
  const binding = bindings[version];
  if (binding === undefined)
    throw new CatalogRefusal('store_damaged', `Version ${String(version)} has no digest for this catalog.`);
  return binding;
}

/**
 * An item this machine already keeps, listed live by one more catalog at the version the person reviewed.
 *
 * `version` must still be the item's current one (else `current_changed`). An item the catalog already lists
 * live is `item_listed`; one it withdrew is listed again IN PLACE, its withdrawal forgotten. A catalog that never
 * listed it arrives with the digest of EVERY version in its own terms (`bindings`, keyed by version), because the
 * schema wants one for each. Only this catalog's revision rises.
 */
export function withListedItem(
  document: CatalogsDocument,
  catalogId: string,
  itemId: string,
  version: number,
  bindings: Readonly<Record<number, CatalogBinding>>,
  now: string,
): CatalogsDocument {
  const catalog = findCatalog(document, catalogId);
  const item = findItem(document, itemId);
  const entry = catalog.entries.find(candidate => candidate.itemId === itemId);
  if (entry !== undefined && entry.withdrawnAt === undefined)
    throw new CatalogRefusal('item_listed', `${catalog.name} already lists ${item.name}.`);
  if (version !== item.current)
    throw new CatalogRefusal(
      'current_changed',
      `${item.name} is at version ${item.current} now, not version ${version}. Review it again, then add it.`,
    );
  assertRoom(document, catalog, item);
  if (entry !== undefined) {
    const { withdrawnAt: _forgotten, ...kept } = entry;
    const listed = { ...kept, addedAt: now };
    return replaceCatalog(
      document,
      bumped({ ...catalog, entries: catalog.entries.map(other => (other === entry ? listed : other)) }, now),
    );
  }
  const next = bumped({ ...catalog, entries: [...catalog.entries, { itemId, addedAt: now }] }, now);
  return {
    ...replaceCatalog(document, next),
    items: document.items.map(other =>
      other.itemId === itemId
        ? {
            ...other,
            versions: other.versions.map(stored => ({
              ...stored,
              bindings: { ...stored.bindings, [catalogId]: bindingFor(bindings, stored.version) },
            })),
          }
        : other,
    ),
  };
}

/**
 * Makes a catalog the default. Nothing a manifest says changes, so no revision rises. Saying what it already is
 * changes nothing. There is no way back to "none": the default moves by promoting another catalog.
 */
export function withDefault(document: CatalogsDocument, id: string): CatalogsDocument {
  findCatalog(document, id);
  return document.defaultCatalogId === id ? document : { ...document, defaultCatalogId: id };
}

/**
 * A new version of an item, which becomes its current one. Every catalog that lists the item live puts it in
 * its manifest from now on, so every one of them rises a revision, in this one change. The version arrives with
 * its digest for every catalog that has a line for the item.
 */
export function withNewVersion(
  document: CatalogsDocument,
  catalogId: string,
  itemId: string,
  version: StoredVersion,
  now: string,
): CatalogsDocument {
  const entry = findEntry(findCatalog(document, catalogId), itemId);
  const item = itemOf(document, itemId);
  if (entry.withdrawnAt !== undefined)
    throw new CatalogRefusal('item_withdrawn', `${item.name} was withdrawn, so it takes no new version.`);
  return {
    ...document,
    items: document.items.map(other =>
      other.itemId === itemId ? { ...item, current: version.version, versions: [...item.versions, version] } : other,
    ),
    catalogs: document.catalogs.map(catalog =>
      liveEntries(catalog).some(live => live.itemId === itemId) ? bumped(catalog, now) : catalog,
    ),
  };
}

export function withWithdrawn(
  document: CatalogsDocument,
  catalogId: string,
  itemId: string,
  now: string,
): CatalogsDocument {
  const catalog = findCatalog(document, catalogId);
  const entry = findEntry(catalog, itemId);
  const item = itemOf(document, itemId);
  if (entry.withdrawnAt !== undefined)
    throw new CatalogRefusal('item_withdrawn', `${item.name} was already withdrawn.`);
  if (catalog.entries.filter(other => other.withdrawnAt !== undefined).length >= CATALOG_MAX_WITHDRAWN)
    throw new CatalogRefusal('catalog_full', `A catalog remembers at most ${CATALOG_MAX_WITHDRAWN} withdrawn items.`);
  const next = bumped(catalog, now);
  return replaceCatalog(document, {
    ...next,
    entries: next.entries.map(other => (other.itemId === itemId ? { ...other, withdrawnAt: next.issuedAt } : other)),
  });
}

/** Why a stored document cannot be used, in one line, or `null` when it parses. */
export function documentProblem(
  parsed: { readonly success: true } | { readonly success: false; readonly error: z.ZodError },
): string | null {
  if (parsed.success) return null;
  const first = parsed.error.issues[0];
  const where = first === undefined || first.path.length === 0 ? '' : ` (at ${first.path.join('.')})`;
  return `${first?.message ?? 'it is malformed'}${where}`;
}
