/**
 * Copying ONE skill from somewhere else on this machine into a project or a runtime
 * (docs/catalogs.md § Copying a skill from this machine). The source is a skill the machine's skills
 * inventory lists — another account's home, or a registered project — and the copy is a COPY: the files
 * are written, never linked, so the two stay separate.
 *
 * It is the catalog installer's twin and keeps its rules (`catalog-install.ts`): a preview that writes
 * nothing and answers every file in full, and an apply of exactly what was previewed. There is no signed
 * manifest, because nobody published anything — the source is this machine's own disk, so the checks that
 * stand in for a signature are the inventory (the source must be a skill it lists, found again by its
 * SKILL.md path) and the caps on the folder it reads.
 *
 * ONE ROUTE PER SCOPE, because a route declares exactly one capability: a project is governed by
 * `filesystem`, a runtime by `fleet` (docs/grants.md). Ferrets are refused on both writes.
 */
import { z } from 'zod';
import { InstantSchema } from './common.ts';
import { CatalogInstallTargetSchema, CatalogProvenanceSchema, type CatalogInstallScope } from './catalog-install.ts';
import { CatalogInstallWarningSchema, CatalogReviewEntrySchema } from './shared-catalog-review.ts';
import { CatalogSourceProblemSchema } from './shared-catalog-owner.ts';
import { CatalogItemNameSchema } from './shared-catalog.ts';

export const LOCAL_SKILL_INSTALLS_PATH = '/v1/skill-installs/local' as const;

/** The two scopes' own routes: `<LOCAL_SKILL_INSTALLS_PATH>/project` and `…/runtime`, each with a `/preview`. */
export const localSkillInstallsPath = (scope: CatalogInstallScope, preview = false): string =>
  `${LOCAL_SKILL_INSTALLS_PATH}/${scope}${preview ? '/preview' : ''}`;

/** How long a preview may be applied; the same decision window as a catalog install. */
export const LOCAL_SKILL_PREVIEW_TTL_SECONDS = 600;

/** `lsp_` and 22 base64url characters: one preview, 128 random bits. */
export const LocalSkillPreviewIdSchema = z.string().regex(/^lsp_[A-Za-z0-9_-]{22}$/u, 'invalid local skill preview id');
export type LocalSkillPreviewId = z.infer<typeof LocalSkillPreviewIdSchema>;

/** `lsi_` and 22 base64url characters: one local copy, as this machine records it. */
export const LocalSkillInstallIdSchema = z.string().regex(/^lsi_[A-Za-z0-9_-]{22}$/u, 'invalid local skill install id');
export type LocalSkillInstallId = z.infer<typeof LocalSkillInstallIdSchema>;

/**
 * The skill to copy, named by the SKILL.md path the skills inventory lists (`GET /v1/skills`). Anything
 * the inventory does not list is refused; the path is looked up there, never opened on the caller's word.
 */
export const LocalSkillSourceSchema = z.strictObject({
  path: z.string().min(1).max(4_096).startsWith('/'),
});
export type LocalSkillSource = z.infer<typeof LocalSkillSourceSchema>;

/** `POST /v1/skill-installs/local/<scope>/preview`. */
export const LocalSkillPreviewRequestSchema = z.strictObject({
  source: LocalSkillSourceSchema,
  target: CatalogInstallTargetSchema,
});
export type LocalSkillPreviewRequest = z.infer<typeof LocalSkillPreviewRequestSchema>;

/**
 * Where a copy came from, as this machine found it in its own inventory — never as a caller reported it.
 * `owner` is the account runtime that holds the skill, or the project's root.
 */
export const LocalSkillOriginSchema = z.strictObject({
  kind: z.enum(['account', 'project']),
  /** The runtime (wrapper) name of the account, or the project's root folder. */
  owner: z.string().min(1).max(4_096),
  harness: z.enum(['claude', 'codex']),
  /** The SKILL.md path the inventory listed. */
  path: z.string().min(1).max(4_096),
});
export type LocalSkillOrigin = z.infer<typeof LocalSkillOriginSchema>;

/**
 * The review: where it is from, every file in full, and what to look at. `provenance` is the synthetic
 * one a runtime install records through the fleet (`publisherName` is "This machine"); a person reads
 * `origin`.
 */
export const LocalSkillPreviewSchema = z.strictObject({
  previewId: LocalSkillPreviewIdSchema,
  expiresAt: InstantSchema,
  name: CatalogItemNameSchema,
  origin: LocalSkillOriginSchema,
  provenance: CatalogProvenanceSchema,
  target: CatalogInstallTargetSchema,
  /** Where it would write, in words. */
  destination: z.string().min(1),
  review: z.array(CatalogReviewEntrySchema),
  /** Files in the source folder that are not copied, each with the reason (links, binaries, credential names…). */
  skipped: z.array(CatalogSourceProblemSchema),
  warnings: z.array(CatalogInstallWarningSchema),
  /** The copy this would replace at the same target, when there is one. */
  replaces: z.strictObject({ installId: LocalSkillInstallIdSchema }).optional(),
});
export type LocalSkillPreview = z.infer<typeof LocalSkillPreviewSchema>;

/** `POST /v1/skill-installs/local/<scope>`: apply exactly one preview. */
export const LocalSkillInstallRequestSchema = z.strictObject({ previewId: LocalSkillPreviewIdSchema });
export type LocalSkillInstallRequest = z.infer<typeof LocalSkillInstallRequestSchema>;

/** One local copy, as this machine records and lists it. */
export const LocalSkillInstallSchema = z.strictObject({
  installId: LocalSkillInstallIdSchema,
  installedAt: InstantSchema,
  name: CatalogItemNameSchema,
  origin: LocalSkillOriginSchema,
  target: CatalogInstallTargetSchema,
  destination: z.string().min(1),
  /** The folder's files this install wrote, by path inside the folder, each with the SHA-256 recorded. */
  files: z.array(z.strictObject({ path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/u) })),
});
export type LocalSkillInstall = z.infer<typeof LocalSkillInstallSchema>;

export const LocalSkillInstalledSchema = z.strictObject({
  install: LocalSkillInstallSchema,
  /** Plain sentences, e.g. that a runtime gets the skill the next time it starts. */
  notes: z.array(z.string().min(1)),
});
export type LocalSkillInstalled = z.infer<typeof LocalSkillInstalledSchema>;

export const LocalSkillRemovedSchema = z.strictObject({
  installId: LocalSkillInstallIdSchema,
  name: CatalogItemNameSchema,
  destination: z.string().min(1),
});
export type LocalSkillRemoved = z.infer<typeof LocalSkillRemovedSchema>;

export const LocalSkillInstallListSchema = z.strictObject({ installs: z.array(LocalSkillInstallSchema) });
export type LocalSkillInstallList = z.infer<typeof LocalSkillInstallListSchema>;

/**
 * Why this machine refused, in the order it checks:
 *
 * - `local_skill_source_unknown`: the inventory lists no skill at that path (or no longer does).
 * - `local_skill_source_invalid`: it is listed but cannot be copied: its folder name is not a catalog name,
 *   SKILL.md cannot be carried, or the folder breaks the file, size or path caps.
 * - `local_skill_target_unknown`: that project, runtime or profile is not one this machine knows.
 * - `local_skill_preview_unknown`, `local_skill_preview_expired`: apply again from a fresh preview.
 * - `local_skill_conflict`: something already sits where the copy would land and no record of ours wrote it,
 *   or what a record of ours wrote there was edited on this machine since.
 * - `local_skill_install_unknown`: no local copy with that id (remove).
 */
export const LOCAL_SKILL_REFUSALS = [
  'local_skill_source_unknown',
  'local_skill_source_invalid',
  'local_skill_target_unknown',
  'local_skill_preview_unknown',
  'local_skill_preview_expired',
  'local_skill_conflict',
  'local_skill_install_unknown',
] as const;
export const LocalSkillRefusalSchema = z.enum(LOCAL_SKILL_REFUSALS);
export type LocalSkillRefusal = z.infer<typeof LocalSkillRefusalSchema>;
