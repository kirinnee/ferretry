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
import { CatalogInstallWarningSchema, CatalogReviewEntrySchema } from './shared-catalog-review.ts';
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

export const SHARED_CATALOGS_PATH = '/v1/catalogs';

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
  /** The latest version's summary. */
  summary: CatalogSummarySchema,
  harness: CatalogHarnessSchema.optional(),
  source: CatalogSourceReferenceSchema,
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
  items: z.array(OwnedCatalogItemSchema).readonly(),
});
export type OwnedCatalog = z.infer<typeof OwnedCatalogSchema>;

/** `GET /v1/catalogs`: every catalog on this machine. */
export const OwnedCatalogListSchema = z.strictObject({
  publisher: DaemonIdSchema,
  catalogs: z.array(OwnedCatalogSchema).readonly(),
});
export type OwnedCatalogList = z.infer<typeof OwnedCatalogListSchema>;

// ── Catalogs ─────────────────────────────────────────────────────────────────────────────────────

/** `POST /v1/catalogs`. `visibility` is `members`; `public` is refused with {@link CATALOG_PUBLIC_UNAVAILABLE}. */
export const CreateCatalogRequestSchema = z.strictObject({
  name: CatalogLabelSchema,
  description: CatalogDescriptionSchema.optional(),
  visibility: CatalogVisibilitySchema.optional(),
});
export type CreateCatalogRequest = z.infer<typeof CreateCatalogRequestSchema>;

/** `PATCH /v1/catalogs/:id`: rename it, describe it, or change the name this machine signs it under. */
export const UpdateCatalogRequestSchema = z
  .strictObject({
    name: CatalogLabelSchema.optional(),
    description: CatalogDescriptionSchema.optional(),
    publisherName: CatalogLabelSchema.optional(),
    visibility: CatalogVisibilitySchema.optional(),
  })
  .refine(
    request =>
      request.name !== undefined ||
      request.description !== undefined ||
      request.publisherName !== undefined ||
      request.visibility !== undefined,
    'name a change: a name, a description, a publisher name or a visibility',
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
});
export type CatalogItemPreview = z.infer<typeof CatalogItemPreviewSchema>;

/** `POST /v1/catalogs/:id/items`: the first version, only if the source still hashes to `digest`. */
export const AddCatalogItemRequestSchema = z.strictObject({
  source: CatalogItemSourceSchema,
  digest: CatalogDigestSchema,
  summary: CatalogSummarySchema.optional(),
});
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
