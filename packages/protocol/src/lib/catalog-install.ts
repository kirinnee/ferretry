/**
 * Installing a catalog item on the subscriber's OWN daemon (docs/catalogs.md § Installing). The
 * installer is daemon B: paired to the subscriber's browser in the ordinary way, and never a member of
 * the publisher. B never talks to the publisher, and it does not take the caller's word for what the
 * publisher said — it checks the publisher's signature and the item's digest itself, so an item from a
 * file someone sent is exactly as trustworthy as one fetched live.
 *
 * TWO STEPS, EACH SCOPE ITS OWN ROUTES. A route declares exactly one capability, and a project write is
 * governed by `filesystem` while a runtime write is governed by `fleet`, so each scope has its own
 * preview and apply (docs/grants.md, as session MCP does):
 *
 * 1. `POST …/<scope>/preview` verifies everything and answers the review — every file in full, every
 *    command line, every secret the item asks for, every warning — and a `previewId`. It writes nothing.
 * 2. `POST …/<scope>` applies exactly that preview, with the installer's explicit choice of which of
 *    THEIR OWN secrets fills each placeholder. The preview is bound to the item's digest and the target.
 *
 * NOTHING AUTO-UPDATES. An install is pinned to the publisher's fingerprint, the item version and its
 * digest. A later version is a new preview and a new yes.
 */
import { z } from 'zod';
import { InstantSchema } from './common.ts';
import { DaemonIdSchema } from './pairing.ts';
import { SecretNameSchema } from './secrets.ts';
import {
  CATALOG_MCP_MAX_ENV,
  CatalogDigestSchema,
  CatalogItemKindSchema,
  CatalogItemNameSchema,
  CatalogLabelSchema,
  SharedCatalogIdSchema,
  SharedCatalogItemIdSchema,
  SharedCatalogItemSchema,
  SignedCatalogManifestSchema,
} from './shared-catalog.ts';
import { CatalogInstallWarningSchema, CatalogReviewEntrySchema } from './shared-catalog-review.ts';

export const CATALOG_INSTALLS_PATH = '/v1/catalog-installs' as const;

/** The two scopes' own routes: `<CATALOG_INSTALLS_PATH>/project` and `…/runtime`, each with a `/preview`. */
export const catalogInstallsPath = (scope: 'project' | 'runtime', preview = false): string =>
  `${CATALOG_INSTALLS_PATH}/${scope}${preview ? '/preview' : ''}`;

/**
 * The most a preview request may weigh, refused before it is parsed. An item is at most 2 MiB of text
 * and JSON may spell one control character as six, so 12 MiB of item plus the manifest's 200 lines
 * (well under 1 MiB) fits with room; 16 MiB is that, rounded up.
 */
export const CATALOG_INSTALL_PREVIEW_MAX_BODY_BYTES = 16 * 1024 * 1024;

/** How long a preview may be applied. Long enough to read every file; short enough to be the same decision. */
export const CATALOG_INSTALL_PREVIEW_TTL_SECONDS = 600;

/** Placeholder → the installer's own secret, or `null` for unbound. At most one per variable an item can set. */
export const CatalogSecretBindingsSchema = z
  .record(SecretNameSchema, SecretNameSchema.nullable())
  .refine(bindings => Object.keys(bindings).length <= CATALOG_MCP_MAX_ENV, `at most ${CATALOG_MCP_MAX_ENV} secrets`);
export type CatalogSecretBindings = z.infer<typeof CatalogSecretBindingsSchema>;

/** `cip_` and 22 base64url characters: one preview, 128 random bits. */
export const CatalogInstallPreviewIdSchema = z.string().regex(/^cip_[A-Za-z0-9_-]{22}$/u, 'invalid install preview id');
export type CatalogInstallPreviewId = z.infer<typeof CatalogInstallPreviewIdSchema>;

/** `cin_` and 22 base64url characters: one install, as B records it. */
export const CatalogInstallIdSchema = z.string().regex(/^cin_[A-Za-z0-9_-]{22}$/u, 'invalid install id');
export type CatalogInstallId = z.infer<typeof CatalogInstallIdSchema>;

export const CatalogInstallScopeSchema = z.enum(['project', 'runtime']);
export type CatalogInstallScope = z.infer<typeof CatalogInstallScopeSchema>;

/**
 * Where an item lands. A project is one B already knows (a registered project or managed worktree), and
 * the harness says which folder a skill goes in (`.claude/skills` or `.agents/skills`). A runtime is an
 * existing runtime and one of its profiles. B refuses a target it does not know rather than making one.
 */
export const CatalogInstallTargetSchema = z.discriminatedUnion('scope', [
  z.strictObject({
    scope: z.literal('project'),
    /** Absolute; B resolves it against the projects it knows. */
    projectRoot: z.string().min(1).max(4_096).startsWith('/'),
    harness: z.enum(['claude', 'codex']),
  }),
  z.strictObject({
    scope: z.literal('runtime'),
    runtime: z.string().min(1).max(128),
    profile: z.string().min(1).max(128),
  }),
]);
export type CatalogInstallTarget = z.infer<typeof CatalogInstallTargetSchema>;

/** `POST /v1/catalog-installs/<scope>/preview`: the signed manifest and one item, as fetched or as read from a file. */
export const CatalogInstallPreviewRequestSchema = z.strictObject({
  signedManifest: SignedCatalogManifestSchema,
  item: SharedCatalogItemSchema,
  target: CatalogInstallTargetSchema,
  /** The person chose a version lower than the one installed; the review then says so first. */
  allowOlder: z.literal(true).optional(),
});
export type CatalogInstallPreviewRequest = z.infer<typeof CatalogInstallPreviewRequestSchema>;

/** Where an install came from, as B VERIFIED it — never as a caller reported it. Recorded on what it wrote. */
export const CatalogProvenanceSchema = z.strictObject({
  publisher: DaemonIdSchema,
  publisherName: CatalogLabelSchema,
  catalogId: SharedCatalogIdSchema,
  catalogName: CatalogLabelSchema,
  itemId: SharedCatalogItemIdSchema,
  kind: CatalogItemKindSchema,
  name: CatalogItemNameSchema,
  version: z.number().int().min(1),
  digest: CatalogDigestSchema,
});
export type CatalogProvenance = z.infer<typeof CatalogProvenanceSchema>;

/** One secret the item asks for, and whether B holds a secret of that same name (it is never bound for you). */
export const CatalogInstallSecretSchema = z.strictObject({
  placeholder: SecretNameSchema,
  held: z.boolean(),
});
export type CatalogInstallSecret = z.infer<typeof CatalogInstallSecretSchema>;

/** The review: what B verified, and everything the item brings. */
export const CatalogInstallPreviewSchema = z.strictObject({
  previewId: CatalogInstallPreviewIdSchema,
  expiresAt: InstantSchema,
  provenance: CatalogProvenanceSchema,
  /** `firstSeen`: B had no install from this publisher, so its fingerprint is pinned by this one. */
  publisher: z.strictObject({ daemonId: DaemonIdSchema, name: CatalogLabelSchema, firstSeen: z.boolean() }),
  target: CatalogInstallTargetSchema,
  /** Where it would write, in words: a folder, `.mcp.json`, or a runtime and profile. */
  destination: z.string().min(1),
  review: z.array(CatalogReviewEntrySchema),
  secrets: z.array(CatalogInstallSecretSchema).max(CATALOG_MCP_MAX_ENV),
  warnings: z.array(CatalogInstallWarningSchema),
  /** The install this would replace at the same target, when there is one. */
  replaces: z.strictObject({ installId: CatalogInstallIdSchema, version: z.number().int().min(1) }).optional(),
});
export type CatalogInstallPreview = z.infer<typeof CatalogInstallPreviewSchema>;

/**
 * `POST /v1/catalog-installs/<scope>`: apply one preview. `secretBindings` names EVERY placeholder the
 * preview listed, each mapped to one of the installer's own secrets or to `null` (left unbound: the
 * install lands, and a launch is refused with the existing "missing secret" sentence until it is set).
 * Nobody gets "it used my key" without having chosen it.
 */
export const CatalogInstallRequestSchema = z.strictObject({
  previewId: CatalogInstallPreviewIdSchema,
  secretBindings: CatalogSecretBindingsSchema,
});
export type CatalogInstallRequest = z.infer<typeof CatalogInstallRequestSchema>;

/** One install, as B records and lists it (`GET /v1/catalog-installs`). */
export const CatalogInstallSchema = z.strictObject({
  installId: CatalogInstallIdSchema,
  installedAt: InstantSchema,
  provenance: CatalogProvenanceSchema,
  target: CatalogInstallTargetSchema,
  destination: z.string().min(1),
  /** Placeholder → the installer's own secret it was bound to, or `null` when left unbound. */
  secretBindings: CatalogSecretBindingsSchema,
});
export type CatalogInstall = z.infer<typeof CatalogInstallSchema>;

/** What an apply answers: the install as recorded, and anything the person should know about how it landed. */
export const CatalogInstalledSchema = z.strictObject({
  install: CatalogInstallSchema,
  /** Plain sentences, e.g. that a project server needs a variable set in the ferret's environment. */
  notes: z.array(z.string().min(1)),
});
export type CatalogInstalled = z.infer<typeof CatalogInstalledSchema>;

/** What a remove answers. */
export const CatalogInstallRemovedSchema = z.strictObject({
  installId: CatalogInstallIdSchema,
  provenance: CatalogProvenanceSchema,
  destination: z.string().min(1),
});
export type CatalogInstallRemoved = z.infer<typeof CatalogInstallRemovedSchema>;

export const CatalogInstallListSchema = z.strictObject({ installs: z.array(CatalogInstallSchema) });
export type CatalogInstallList = z.infer<typeof CatalogInstallListSchema>;

/**
 * Why B refused, so a client words each one differently. In the order B checks (docs/catalogs.md):
 *
 * - `catalog_signature_invalid`: the manifest was not signed by the machine it names.
 * - `catalog_item_mismatch`: the item is not the version, or not the bytes, the signed manifest lists.
 * - `catalog_publisher_changed`: B already installed from a publisher of this catalog under a different
 *   fingerprint — a different machine is using the same catalog.
 * - `catalog_revision_older`: the manifest is an older revision of this catalog than B has already seen.
 * - `catalog_downgrade`: the version is lower than the one installed, and the person did not choose that.
 * - `catalog_item_invalid`: the item breaks a bundle rule (path, size, a raw secret).
 * - `catalog_not_installable`: an artifact is opened, not installed; or a kind this target cannot take.
 * - `catalog_target_unknown`: B does not know that project, runtime or profile.
 * - `catalog_preview_unknown`, `catalog_preview_expired`: apply again from a fresh preview.
 * - `catalog_bindings_invalid`: a placeholder was left out, an extra one named, or an own secret B lacks.
 * - `catalog_install_conflict`: something already sits where the item would land, and B did not write it,
 *   or what B wrote there was edited on this machine since.
 * - `catalog_install_unknown`: B has no install with that id (remove).
 */
export const CATALOG_INSTALL_REFUSALS = [
  'catalog_signature_invalid',
  'catalog_item_mismatch',
  'catalog_publisher_changed',
  'catalog_revision_older',
  'catalog_downgrade',
  'catalog_item_invalid',
  'catalog_not_installable',
  'catalog_target_unknown',
  'catalog_preview_unknown',
  'catalog_preview_expired',
  'catalog_bindings_invalid',
  'catalog_install_conflict',
  'catalog_install_unknown',
] as const;
export const CatalogInstallRefusalSchema = z.enum(CATALOG_INSTALL_REFUSALS);
export type CatalogInstallRefusal = z.infer<typeof CatalogInstallRefusalSchema>;
