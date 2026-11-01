/**
 * The owner's side of catalogs: the wire for making a catalog on this machine, adding skills and MCP
 * setups to it, publishing new versions, withdrawing, and exporting a signed file
 * (docs/catalogs.md § The publisher side). The frozen item and the signed file themselves are
 * `./shared-catalog.ts`; this file is only what the owner's routes say to each other.
 *
 * Every route is `sharing` (use), and a ferret may only LIST. A write by a ferret is refused by the
 * daemon, because export signs as this machine.
 *
 * ## One digest binds a preview to a publish
 *
 * A preview answers a `digest`: the SHA-256 of the canonical JSON of the frozen item exactly as the
 * preview showed it, with its identity (item id, version) normalised so the same content hashes the
 * same whichever item it becomes. Adding or publishing sends that digest back, and the daemon re-reads
 * the source and refuses unless it hashes the same — so what the person read is what gets frozen. It
 * is NOT the digest in the signed manifest, which covers the identity as well.
 */
import { z } from 'zod';
import { InstantSchema } from './common.ts';
import { DaemonIdSchema } from './pairing.ts';
import {
  CatalogDescriptionSchema,
  CatalogDigestSchema,
  CatalogHarnessSchema,
  CatalogItemKindSchema,
  CatalogItemNameSchema,
  CatalogLabelSchema,
  CatalogSummarySchema,
  CatalogVisibilitySchema,
  SharedCatalogIdSchema,
  SharedCatalogItemIdSchema,
} from './shared-catalog.ts';
import { CatalogChangesSchema } from './shared-catalog-diff.ts';
import { CatalogInstallWarningSchema, CatalogReviewEntrySchema } from './shared-catalog-review.ts';

export const SHARED_CATALOGS_PATH = '/v1/catalogs';

/** `GET /v1/catalog-items`: the shared items this machine keeps, whichever catalogs list them. */
export const CATALOG_ITEMS_PATH = '/v1/catalog-items';

/** Most catalogs one machine keeps. Making one past it is refused `catalogs_full`. */
export const CATALOGS_MAX_PER_PUBLISHER = 256;

/** Most shared items one machine keeps. A new item past it is refused `items_full`. */
export const SHARED_ITEMS_MAX = 4_096;

/** Most versions one item keeps. A version past it is refused `items_full`. */
export const CATALOG_ITEM_MAX_VERSIONS = 1_000;

/** The sentence a request for a public catalog is refused with. */
export const CATALOG_PUBLIC_UNAVAILABLE =
  'A public catalog is not available yet. Catalogs are shared with the people you add as members, and until members exist, as a file.';

/** Where the source of a skill is: the SKILL.md path the skills inventory lists, or the skill's name. */
export const CatalogSourceSkillSchema = z.strictObject({
  kind: z.literal('skill'),
  skill: z.string().min(1).max(4_096),
});

/** Where the source of an MCP setup is: an MCP inventory server id, or the server's name. */
export const CatalogSourceMcpSchema = z.strictObject({
  kind: z.literal('mcp'),
  mcp: z.string().min(1).max(256),
});

/** What a person points at to add to a catalog. */
export const CatalogItemSourceSchema = z.discriminatedUnion('kind', [CatalogSourceSkillSchema, CatalogSourceMcpSchema]);
export type CatalogItemSource = z.infer<typeof CatalogItemSourceSchema>;

/** What a version remembers of where it came from, resolved: the exact path or the exact inventory id. */
export const CatalogSourceReferenceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('skill'), path: z.string().min(1).max(4_096) }),
  z.strictObject({ kind: z.literal('mcp'), id: z.string().min(1).max(128), name: z.string().min(1).max(256) }),
]);
export type CatalogSourceReference = z.infer<typeof CatalogSourceReferenceSchema>;

/** A file or field left out of the frozen copy, and why. Nothing is skipped without one. */
export const CatalogSourceProblemSchema = z.strictObject({
  /** The path inside the skill, or the field of the setup. */
  subject: z.string().min(1).max(512),
  reason: z.string().min(1).max(1_024),
});
export type CatalogSourceProblem = z.infer<typeof CatalogSourceProblemSchema>;

// ── The catalog and what it holds ────────────────────────────────────────────────────────────────

/** One published version of an item. Its bytes never change. */
export const CatalogItemVersionSchema = z.strictObject({
  version: z.number().int().min(1),
  /** The digest the signed manifest lists for it. */
  digest: CatalogDigestSchema,
  size: z.number().int().min(1),
  publishedAt: InstantSchema,
  /** When the version was retired (versions, 3d); unset while it is in use. */
  retiredAt: InstantSchema.optional(),
});
export type CatalogItemVersion = z.infer<typeof CatalogItemVersionSchema>;

/**
 * Whether the source has changed since the latest version was frozen.
 * `withdrawn` items are not looked at. `unavailable`: the skill or the server is not there any more.
 */
export const CatalogSourceStateSchema = z.enum(['unchanged', 'changed', 'unavailable', 'withdrawn']);
export type CatalogSourceState = z.infer<typeof CatalogSourceStateSchema>;

export const OwnedCatalogItemSchema = z.strictObject({
  itemId: SharedCatalogItemIdSchema,
  kind: CatalogItemKindSchema,
  name: CatalogItemNameSchema,
  /** The current version's summary. */
  summary: CatalogSummarySchema,
  harness: CatalogHarnessSchema.optional(),
  source: CatalogSourceReferenceSchema,
  /** The version every catalog that lists this item live puts in its manifest. Absent from an older daemon: the latest. */
  current: z.number().int().min(1).optional(),
  /** Only when it was asked for (`?sourceState=1`): finding it re-reads the source, so a plain list does not. */
  sourceState: CatalogSourceStateSchema.optional(),
  /** Why a source is `unavailable`, in words. */
  sourceNote: z.string().max(1_024).optional(),
  /** Set when the item was withdrawn. */
  withdrawnAt: InstantSchema.optional(),
  /** Oldest first. */
  versions: z.array(CatalogItemVersionSchema).min(1).readonly(),
});
export type OwnedCatalogItem = z.infer<typeof OwnedCatalogItemSchema>;

/** A catalog is the default (where one tap adds) or one of the others. Kept by id, never by name. */
export const CatalogRoleSchema = z.enum(['default', 'collection']);
export type CatalogRole = z.infer<typeof CatalogRoleSchema>;

export const OwnedCatalogSchema = z.strictObject({
  id: SharedCatalogIdSchema,
  name: CatalogLabelSchema,
  description: CatalogDescriptionSchema,
  /** What the signed manifest calls this machine: set when the catalog is made, changed with a new revision. */
  publisherName: CatalogLabelSchema,
  visibility: CatalogVisibilitySchema,
  /** Goes up by one on every change to what a manifest says, and never otherwise. */
  revision: z.number().int().min(1),
  /** When the current revision was made. An export signs this instant, so exporting twice is the same bytes. */
  issuedAt: InstantSchema,
  createdAt: InstantSchema,
  /** Absent from an older daemon: every catalog was then a collection. */
  role: CatalogRoleSchema.optional(),
  items: z.array(OwnedCatalogItemSchema).readonly(),
});
export type OwnedCatalog = z.infer<typeof OwnedCatalogSchema>;

/** `GET /v1/catalogs`: every catalog on this machine. */
export const OwnedCatalogListSchema = z.strictObject({
  publisher: DaemonIdSchema,
  /** The catalog one tap adds to. Absent when there is none yet, and from an older daemon. */
  defaultCatalogId: SharedCatalogIdSchema.optional(),
  catalogs: z.array(OwnedCatalogSchema).readonly(),
});
export type OwnedCatalogList = z.infer<typeof OwnedCatalogListSchema>;

// ── The shared items ─────────────────────────────────────────────────────────────────────────────

/** One version of a shared item, and where it is in use. */
export const OwnedSharedItemVersionSchema = z.strictObject({
  version: z.number().int().min(1),
  /** Bytes of the frozen copy, which is the same whichever catalog lists it. */
  size: z.number().int().min(1),
  publishedAt: InstantSchema,
  /** When the version was retired (versions, 3d); unset while it is in use. */
  retiredAt: InstantSchema.optional(),
  summary: CatalogSummarySchema,
  /** Skills only: how many files it holds. */
  fileCount: z.number().int().min(0).optional(),
  /** Every catalog lists the current version, so this is the live catalogs for it and empty for any other. */
  usedBy: z.strictObject({ catalogIds: z.array(SharedCatalogIdSchema).readonly() }),
});
export type OwnedSharedItemVersion = z.infer<typeof OwnedSharedItemVersionSchema>;

/** Whether a catalog lists the item now, or did once and took it out. */
export const OwnedSharedItemCatalogSchema = z.strictObject({
  catalogId: SharedCatalogIdSchema,
  state: z.enum(['live', 'withdrawn']),
  withdrawnAt: InstantSchema.optional(),
});
export type OwnedSharedItemCatalog = z.infer<typeof OwnedSharedItemCatalogSchema>;

/** An item of the table: kept once, listed by any number of catalogs. */
export const OwnedSharedItemSchema = z.strictObject({
  itemId: SharedCatalogItemIdSchema,
  kind: CatalogItemKindSchema,
  name: CatalogItemNameSchema,
  /** The current version's summary. */
  summary: CatalogSummarySchema,
  harness: CatalogHarnessSchema.optional(),
  /** Where the current version was read from. */
  source: CatalogSourceReferenceSchema,
  /** The version every catalog that lists this item live puts in its manifest. */
  current: z.number().int().min(1),
  createdAt: InstantSchema,
  /** Only when it was asked for (`?sourceState=1`), and against the current version. */
  sourceState: CatalogSourceStateSchema.optional(),
  sourceNote: z.string().max(1_024).optional(),
  catalogs: z.array(OwnedSharedItemCatalogSchema).readonly(),
  /** Oldest first. */
  versions: z.array(OwnedSharedItemVersionSchema).min(1).readonly(),
});
export type OwnedSharedItem = z.infer<typeof OwnedSharedItemSchema>;

/** `GET /v1/catalog-items`. */
export const OwnedSharedItemListSchema = z.strictObject({
  publisher: DaemonIdSchema,
  defaultCatalogId: SharedCatalogIdSchema.optional(),
  items: z.array(OwnedSharedItemSchema).readonly(),
});
export type OwnedSharedItemList = z.infer<typeof OwnedSharedItemListSchema>;

// ── Catalogs ─────────────────────────────────────────────────────────────────────────────────────

/** `POST /v1/catalogs`. `visibility` is `members`; `public` is refused with {@link CATALOG_PUBLIC_UNAVAILABLE}. */
export const CreateCatalogRequestSchema = z.strictObject({
  name: CatalogLabelSchema,
  description: CatalogDescriptionSchema.optional(),
  visibility: CatalogVisibilitySchema.optional(),
});
export type CreateCatalogRequest = z.infer<typeof CreateCatalogRequestSchema>;

/**
 * `PATCH /v1/catalogs/:id`: rename it, describe it, change the name this machine signs it under, or make it the
 * default. `role` can only be `default`: the default moves by promoting another catalog, so there is never
 * none by accident. Making a catalog the default changes nothing a manifest says, so the revision stays.
 */
export const UpdateCatalogRequestSchema = z
  .strictObject({
    name: CatalogLabelSchema.optional(),
    description: CatalogDescriptionSchema.optional(),
    publisherName: CatalogLabelSchema.optional(),
    visibility: CatalogVisibilitySchema.optional(),
    role: z.literal('default').optional(),
  })
  .refine(
    request =>
      request.name !== undefined ||
      request.description !== undefined ||
      request.publisherName !== undefined ||
      request.visibility !== undefined ||
      request.role !== undefined,
    'name a change: a name, a description, a publisher name, a visibility or a role',
  );
export type UpdateCatalogRequest = z.infer<typeof UpdateCatalogRequestSchema>;

/** `DELETE /v1/catalogs/:id`. */
export const DeletedCatalogSchema = z.strictObject({ catalogId: SharedCatalogIdSchema });
export type DeletedCatalog = z.infer<typeof DeletedCatalogSchema>;

// ── Items ────────────────────────────────────────────────────────────────────────────────────────

/**
 * `POST /v1/catalogs/:id/items/preview`: a new item from a source, or — with `itemId` — the NEXT version of
 * an item already in the catalog, read from the source it remembers. `summary` is the person's own words
 * for a new item; it is part of what the digest binds.
 */
export const CatalogItemPreviewRequestSchema = z.union([
  z.strictObject({ source: CatalogItemSourceSchema, summary: CatalogSummarySchema.optional() }),
  z.strictObject({ itemId: SharedCatalogItemIdSchema }),
]);
export type CatalogItemPreviewRequest = z.infer<typeof CatalogItemPreviewRequestSchema>;

/** Exactly what an installer would see of the frozen candidate, and the digest that binds it. */
export const CatalogItemPreviewSchema = z.strictObject({
  catalogId: SharedCatalogIdSchema,
  /** Set when this would be a new version of an existing item. */
  itemId: SharedCatalogItemIdSchema.optional(),
  kind: CatalogItemKindSchema,
  name: CatalogItemNameSchema,
  summary: CatalogSummarySchema,
  harness: CatalogHarnessSchema.optional(),
  /** WHERE the source is, as resolved: the SKILL.md path, or the file or fleet record the MCP server comes from. */
  location: z.string().min(1).max(2_048),
  /** The version this would be: 1 for a new item. */
  version: z.number().int().min(1),
  /** The version it would follow, when the frozen copy is the same as that one (nothing to publish). */
  sameAsVersion: z.number().int().min(1).optional(),
  digest: CatalogDigestSchema,
  /** Bytes of the frozen item. */
  size: z.number().int().min(1),
  review: z.array(CatalogReviewEntrySchema).readonly(),
  warnings: z.array(CatalogInstallWarningSchema).readonly(),
  problems: z.array(CatalogSourceProblemSchema).readonly(),
  /** Against the CURRENT version, when this would be a new version of an item that exists: what a person reads differently. */
  changes: CatalogChangesSchema.optional(),
});
export type CatalogItemPreview = z.infer<typeof CatalogItemPreviewSchema>;

/**
 * `POST /v1/catalogs/:id/items`: a new item, only if the source still hashes to `digest`; or an item this machine
 * already keeps, listed here too. `version` is the one the person reviewed and must still be the current one.
 */
export const AddCatalogItemRequestSchema = z.union([
  z.strictObject({
    source: CatalogItemSourceSchema,
    digest: CatalogDigestSchema,
    summary: CatalogSummarySchema.optional(),
  }),
  z.strictObject({ itemId: SharedCatalogItemIdSchema, version: z.number().int().min(1) }),
]);
export type AddCatalogItemRequest = z.infer<typeof AddCatalogItemRequestSchema>;

/** `POST /v1/catalogs/:id/items/:itemId/versions`: the next version, only if the source still hashes to `digest`. */
export const PublishCatalogVersionRequestSchema = z.strictObject({ digest: CatalogDigestSchema });
export type PublishCatalogVersionRequest = z.infer<typeof PublishCatalogVersionRequestSchema>;

/** The answer to adding an item or publishing a version. */
export const PublishedCatalogItemSchema = z.strictObject({
  catalogId: SharedCatalogIdSchema,
  itemId: SharedCatalogItemIdSchema,
  itemVersion: z.number().int().min(1),
  /** The digest the signed manifest lists for this version. */
  digest: CatalogDigestSchema,
  revision: z.number().int().min(1),
  item: OwnedCatalogItemSchema,
});
export type PublishedCatalogItem = z.infer<typeof PublishedCatalogItemSchema>;

/** `DELETE /v1/catalogs/:id/items/:itemId`. */
export const WithdrawnCatalogItemSchema = z.strictObject({
  catalogId: SharedCatalogIdSchema,
  itemId: SharedCatalogItemIdSchema,
  revision: z.number().int().min(1),
  withdrawnAt: InstantSchema,
});
export type WithdrawnCatalogItem = z.infer<typeof WithdrawnCatalogItemSchema>;

// ── Export ───────────────────────────────────────────────────────────────────────────────────────

/**
 * `POST /v1/catalogs/:id/export`: the catalog as a signed file. The answer is a `SharedCatalogFile`.
 * Without `itemIds`, every listed item travels, at its latest version.
 */
export const ExportCatalogRequestSchema = z.strictObject({
  itemIds: z.array(SharedCatalogItemIdSchema).min(1).max(200).optional(),
});
export type ExportCatalogRequest = z.infer<typeof ExportCatalogRequestSchema>;

// ── One-tap Add, and Undo ────────────────────────────────────────────────────────────────────────

/** How long the daemon keeps the Undo of a one-tap Add, in seconds. The app's own toast is shorter. */
export const QUICK_ADD_UNDO_SECONDS = 60;

/** `POST /v1/catalog-items/quick-add`. */
export const QUICK_ADD_PATH = `${CATALOG_ITEMS_PATH}/quick-add`;

/** `POST /v1/catalog-items/quick-add/undo`. */
export const QUICK_ADD_UNDO_PATH = `${QUICK_ADD_PATH}/undo`;

/**
 * What the frozen candidate of a one-tap Add shows, before it is listed anywhere: the preview of an item with no
 * catalog of its own yet. `digest` is the content digest, the same value the catalog's own preview answers.
 */
export const SharedItemPreviewSchema = CatalogItemPreviewSchema.omit({ catalogId: true });
export type SharedItemPreview = z.infer<typeof SharedItemPreviewSchema>;

/**
 * `POST /v1/catalog-items/quick-add`: a source this machine has not shared yet, or an item it already keeps. There is
 * NO field for "this is clean": the daemon reads the source once, decides for itself and answers `review` when
 * anything wants a person's eyes.
 */
export const QuickAddRequestSchema = z.union([
  z.strictObject({ source: CatalogItemSourceSchema }),
  z.strictObject({ itemId: SharedCatalogItemIdSchema }),
]);
export type QuickAddRequest = z.infer<typeof QuickAddRequestSchema>;

/** The token of an Undo: 128 random bits, valid for {@link QUICK_ADD_UNDO_SECONDS} and good once. */
export const QuickAddUndoTokenSchema = z.string().regex(/^cqu_[A-Za-z0-9_-]{22}$/u);
export type QuickAddUndoToken = z.infer<typeof QuickAddUndoTokenSchema>;

/**
 * What a one-tap Add did. `added` (201) wrote the default catalog; `already` (200) found it listed there; `review`
 * (200) wrote NOTHING: a warning, a file left out, a missing summary, or an existing version with warnings means a
 * person reads it first, and `preview` is what they read (absent only when the one reason is `needs-summary`).
 */
export const QuickAddAnswerSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('added'),
    catalog: z.strictObject({
      catalogId: SharedCatalogIdSchema,
      name: CatalogLabelSchema,
      revision: z.number().int().min(1),
      /** True when this tap made the default catalog. */
      created: z.boolean(),
    }),
    itemId: SharedCatalogItemIdSchema,
    itemVersion: z.number().int().min(1),
    /** The digest the default catalog's signed manifest lists. */
    digest: CatalogDigestSchema,
    newItem: z.boolean(),
    /** The source has changed since the version added was frozen; nothing new was published. */
    sourceChanged: z.boolean(),
    undo: z.strictObject({ token: QuickAddUndoTokenSchema, expiresAt: InstantSchema }),
  }),
  z.strictObject({
    outcome: z.literal('already'),
    catalogId: SharedCatalogIdSchema,
    itemId: SharedCatalogItemIdSchema,
    itemVersion: z.number().int().min(1),
  }),
  z.strictObject({
    outcome: z.literal('review'),
    reasons: z
      .array(z.enum(['warnings', 'problems', 'needs-summary']))
      .min(1)
      .readonly(),
    preview: SharedItemPreviewSchema.optional(),
  }),
]);
export type QuickAddAnswer = z.infer<typeof QuickAddAnswerSchema>;

/** `POST /v1/catalog-items/quick-add/undo`. */
export const QuickAddUndoRequestSchema = z.strictObject({ token: QuickAddUndoTokenSchema });
export type QuickAddUndoRequest = z.infer<typeof QuickAddUndoRequestSchema>;

/**
 * What Undo did: `retracted` took the item out as if it had never been listed (nobody had been shown that revision);
 * `withdrawn` is the ordinary withdrawal, kept as a record, because a member may already have read it.
 */
export const QuickAddUndoneSchema = z.strictObject({
  catalogId: SharedCatalogIdSchema,
  itemId: SharedCatalogItemIdSchema,
  mode: z.enum(['retracted', 'withdrawn']),
  revision: z.number().int().min(1),
  /** The item itself was dropped from the store too: this tap had made it and no catalog lists it any more. */
  itemRemoved: z.boolean(),
});
export type QuickAddUndone = z.infer<typeof QuickAddUndoneSchema>;

// ── Versions of one item ─────────────────────────────────────────────────────────────────────────

/**
 * `GET /v1/catalog-items/:itemId/versions/:version`: one frozen version, read in full — what an installer of
 * exactly that version would be shown. Read from the stored copy, never the source.
 */
export const SharedItemVersionDetailSchema = z.strictObject({
  itemId: SharedCatalogItemIdSchema,
  version: z.number().int().min(1),
  kind: CatalogItemKindSchema,
  name: CatalogItemNameSchema,
  summary: CatalogSummarySchema,
  harness: CatalogHarnessSchema.optional(),
  size: z.number().int().min(1),
  publishedAt: InstantSchema,
  retiredAt: InstantSchema.optional(),
  review: z.array(CatalogReviewEntrySchema).readonly(),
  warnings: z.array(CatalogInstallWarningSchema).readonly(),
});
export type SharedItemVersionDetail = z.infer<typeof SharedItemVersionDetailSchema>;

/** `POST /v1/catalog-items/:itemId/versions/preview`: nothing to say; the item remembers where its source is. */
export const PreviewSharedItemVersionRequestSchema = z.strictObject({});
export type PreviewSharedItemVersionRequest = z.infer<typeof PreviewSharedItemVersionRequestSchema>;

/** `POST /v1/catalog-items/:itemId/versions`: the next version, only if the source still hashes to `digest`. */
export const PublishSharedItemVersionRequestSchema = z.strictObject({ digest: CatalogDigestSchema });
export type PublishSharedItemVersionRequest = z.infer<typeof PublishSharedItemVersionRequestSchema>;

/** Where a published version went: one entry per catalog that lists the item live, each bumped by one revision. */
export const PublishedSharedItemCatalogSchema = z.strictObject({
  catalogId: SharedCatalogIdSchema,
  revision: z.number().int().min(1),
  /** The digest that catalog's signed manifest lists for this version. */
  digest: CatalogDigestSchema,
});
export type PublishedSharedItemCatalog = z.infer<typeof PublishedSharedItemCatalogSchema>;

/** The answer to publishing a version at the item. */
export const PublishedSharedItemSchema = z.strictObject({
  itemId: SharedCatalogItemIdSchema,
  itemVersion: z.number().int().min(1),
  /** The version every live catalog serves now. */
  current: z.number().int().min(1),
  catalogs: z.array(PublishedSharedItemCatalogSchema).readonly(),
  item: OwnedSharedItemSchema,
});
export type PublishedSharedItem = z.infer<typeof PublishedSharedItemSchema>;
