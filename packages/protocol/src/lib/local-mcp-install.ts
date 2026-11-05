/**
 * Copying ONE MCP server definition from somewhere else on this machine into a project's `.mcp.json` or a
 * runtime (docs/catalogs.md § Copying an MCP server from this machine). The source is a server the machine's
 * MCP inventory lists — another account's home, a fleet component, or a registered project — and the copy is a
 * COPY: the definition is written, never linked, so the two stay separate.
 *
 * It is `local-skill-install.ts`'s twin for servers and keeps the catalog installer's rules for secrets
 * (`catalog-install.ts`): a preview that writes nothing, and an apply of exactly what was previewed. There is no
 * signed manifest, because nobody published anything: the source is this machine's own inventory, found again
 * by its id. NO SECRET VALUE IS COPIED OR SHOWN. Every environment value of the source becomes a PLACEHOLDER
 * (`${secret:NAME}`, the variable's own name), an address's credentials are left out and said, and the person
 * binds each placeholder to one of THEIR OWN secrets at apply, or leaves it unbound.
 *
 * ONE ROUTE PER SCOPE, because a route declares exactly one capability: a project is governed by `filesystem`,
 * a runtime by `fleet` (docs/grants.md). Ferrets are refused on every route.
 */
import { z } from 'zod';
import { InstantSchema } from './common.ts';
import {
  CatalogInstallSecretSchema,
  CatalogInstallTargetSchema,
  CatalogProvenanceSchema,
  CatalogSecretBindingsSchema,
  type CatalogInstallScope,
} from './catalog-install.ts';
import { McpScopeSchema } from './mcp-inventory.ts';
import { CatalogInstallWarningSchema, CatalogReviewEntrySchema } from './shared-catalog-review.ts';
import { CatalogSourceProblemSchema } from './shared-catalog-owner.ts';
import { CATALOG_MCP_MAX_ENV, CatalogItemNameSchema } from './shared-catalog.ts';

export const LOCAL_MCP_INSTALLS_PATH = '/v1/mcp-installs/local' as const;

/** The two scopes' own routes: `<LOCAL_MCP_INSTALLS_PATH>/project` and `…/runtime`, each with a `/preview`. */
export const localMcpInstallsPath = (scope: CatalogInstallScope, preview = false): string =>
  `${LOCAL_MCP_INSTALLS_PATH}/${scope}${preview ? '/preview' : ''}`;

/** How long a preview may be applied; the same decision window as a catalog install. */
export const LOCAL_MCP_PREVIEW_TTL_SECONDS = 600;

/** `lmp_` and 22 base64url characters: one preview, 128 random bits. */
export const LocalMcpPreviewIdSchema = z.string().regex(/^lmp_[A-Za-z0-9_-]{22}$/u, 'invalid local MCP preview id');
export type LocalMcpPreviewId = z.infer<typeof LocalMcpPreviewIdSchema>;

/** `lmi_` and 22 base64url characters: one local copy, as this machine records it. */
export const LocalMcpInstallIdSchema = z.string().regex(/^lmi_[A-Za-z0-9_-]{22}$/u, 'invalid local MCP install id');
export type LocalMcpInstallId = z.infer<typeof LocalMcpInstallIdSchema>;

/**
 * The server to copy, named by the id the MCP inventory lists (`GET /v1/mcp`). Anything the inventory does not
 * list is refused; the id is looked up there, and no file is opened on the caller's word.
 */
export const LocalMcpSourceSchema = z.strictObject({
  id: z.string().regex(/^[0-9a-f]{24}$/u, 'an MCP inventory server id'),
});
export type LocalMcpSource = z.infer<typeof LocalMcpSourceSchema>;

/** `POST /v1/mcp-installs/local/<scope>/preview`. */
export const LocalMcpPreviewRequestSchema = z.strictObject({
  source: LocalMcpSourceSchema,
  target: CatalogInstallTargetSchema,
});
export type LocalMcpPreviewRequest = z.infer<typeof LocalMcpPreviewRequestSchema>;

/**
 * Where a copy came from, as this machine found it in its own inventory — never as a caller reported it.
 * `owner` is the account runtime that holds the server, or the project's root.
 */
export const LocalMcpOriginSchema = z.strictObject({
  kind: z.enum(['account', 'project']),
  /** The runtime (wrapper) name of the account, or the project's root folder. */
  owner: z.string().min(1).max(4_096),
  harness: z.enum(['claude', 'codex']),
  /** Which declaration the inventory listed it from: a fleet component, the account's own, a project's. */
  scope: McpScopeSchema,
  /** The inventory's id for it. */
  id: z.string().min(1).max(64),
});
export type LocalMcpOrigin = z.infer<typeof LocalMcpOriginSchema>;

/**
 * The review: where it is from, the command or address in full (the catalog installer's review, hidden
 * characters marked), which placeholders it asks the person to fill, and what to look at. `provenance` is the
 * synthetic one a runtime install records through the fleet (`publisherName` is "This machine").
 */
export const LocalMcpPreviewSchema = z.strictObject({
  previewId: LocalMcpPreviewIdSchema,
  expiresAt: InstantSchema,
  name: CatalogItemNameSchema,
  origin: LocalMcpOriginSchema,
  provenance: CatalogProvenanceSchema,
  target: CatalogInstallTargetSchema,
  /** Where it would write, in words. */
  destination: z.string().min(1),
  review: z.array(CatalogReviewEntrySchema),
  /** One placeholder per environment variable of the source, never its value. `held`: the person has that secret. */
  secrets: z.array(CatalogInstallSecretSchema).max(CATALOG_MCP_MAX_ENV),
  /** What of the source is NOT copied, each with the reason (an address's credentials, headers…). */
  skipped: z.array(CatalogSourceProblemSchema),
  warnings: z.array(CatalogInstallWarningSchema),
  /** The copy this would replace at the same target, when there is one. */
  replaces: z.strictObject({ installId: LocalMcpInstallIdSchema }).optional(),
});
export type LocalMcpPreview = z.infer<typeof LocalMcpPreviewSchema>;

/**
 * `POST /v1/mcp-installs/local/<scope>`: apply exactly one preview. `secretBindings` names EVERY placeholder the
 * preview listed, each mapped to one of the person's own secrets or to `null` (left out), as a catalog install's.
 */
export const LocalMcpInstallRequestSchema = z.strictObject({
  previewId: LocalMcpPreviewIdSchema,
  secretBindings: CatalogSecretBindingsSchema,
});
export type LocalMcpInstallRequest = z.infer<typeof LocalMcpInstallRequestSchema>;

/** One local copy, as this machine records and lists it. */
export const LocalMcpInstallSchema = z.strictObject({
  installId: LocalMcpInstallIdSchema,
  installedAt: InstantSchema,
  name: CatalogItemNameSchema,
  origin: LocalMcpOriginSchema,
  target: CatalogInstallTargetSchema,
  destination: z.string().min(1),
  /** Placeholder → the person's own secret it was bound to, or `null` when left unbound. */
  secretBindings: CatalogSecretBindingsSchema,
});
export type LocalMcpInstall = z.infer<typeof LocalMcpInstallSchema>;

export const LocalMcpInstalledSchema = z.strictObject({
  install: LocalMcpInstallSchema,
  /** Plain sentences, e.g. which variable a project needs, or that a runtime gets the server the next time it starts. */
  notes: z.array(z.string().min(1)),
});
export type LocalMcpInstalled = z.infer<typeof LocalMcpInstalledSchema>;

export const LocalMcpRemovedSchema = z.strictObject({
  installId: LocalMcpInstallIdSchema,
  name: CatalogItemNameSchema,
  destination: z.string().min(1),
});
export type LocalMcpRemoved = z.infer<typeof LocalMcpRemovedSchema>;

export const LocalMcpInstallListSchema = z.strictObject({ installs: z.array(LocalMcpInstallSchema) });
export type LocalMcpInstallList = z.infer<typeof LocalMcpInstallListSchema>;

/**
 * Why this machine refused, in the order it checks:
 *
 * - `local_mcp_source_unknown`: the inventory lists no server with that id (or no longer does).
 * - `local_mcp_source_invalid`: it is listed but cannot be copied: its name is not a catalog name, it is Ferretry's
 *   own tools server, it holds what looks like a raw key or a `${…}` substitution in its command or arguments, or
 *   it is not a shape a project or runtime can hold.
 * - `local_mcp_target_unknown`: that project, runtime or profile is not one this machine knows.
 * - `local_mcp_bindings_invalid`: the secret bindings do not match the placeholders, or name a secret the person
 *   does not have, or one a project's `.mcp.json` cannot read.
 * - `local_mcp_preview_unknown`, `local_mcp_preview_expired`: apply again from a fresh preview.
 * - `local_mcp_conflict`: something already sits where the copy would land and no record of ours wrote it, or what
 *   a record of ours wrote there was edited on this machine since, or the project's `.mcp.json` changed under it.
 * - `local_mcp_install_unknown`: no local copy with that id (remove).
 */
export const LOCAL_MCP_REFUSALS = [
  'local_mcp_source_unknown',
  'local_mcp_source_invalid',
  'local_mcp_target_unknown',
  'local_mcp_bindings_invalid',
  'local_mcp_preview_unknown',
  'local_mcp_preview_expired',
  'local_mcp_conflict',
  'local_mcp_install_unknown',
] as const;
export const LocalMcpRefusalSchema = z.enum(LOCAL_MCP_REFUSALS);
export type LocalMcpRefusal = z.infer<typeof LocalMcpRefusalSchema>;
