/**
 * Skills' wire schemas, copied from today's `@ferretry/protocol` (`skills-inventory.ts`, `local-skill-install.ts`,
 * `catalog.ts`'s `SessionSkills`) and `@ferretry/fleet` (`SkillsComponentSchema`). Strict objects where today's were;
 * the inventory objects stay non-strict as today's are (`z.object`), because the harness side may add a field.
 *
 * Stripped (port work, `daemon/lib`): `localSkillInstallsPath` (the paths live in the manifest now).
 *
 * Inlined foreign pieces (a contract imports no other plugin's): `CatalogInstallTarget`, `CatalogProvenance`,
 * `CatalogReviewEntry`, `CatalogInstallWarning` and `CatalogSourceProblem` (Catalogs' vocabulary, trimmed to the
 * fields a local copy uses; text-safety refinements of `CatalogLabelSchema` are NOT carried: partial), the catalog item
 * name grammar, and the harness key (`claude` → `claude-code`, the plugin id).
 */
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { HarnessKeySchema } from './core.ts';

// ─── inventory (docs/skills-inventory.md) ────────────────────────────────────────────────────────────────────────

/**
 * Where a skill comes from: `ferretry` (a skill item linked into a runtime home), `user` (the harness home's own
 * skills folder), `project` (Claude reads `<root>/.claude/skills`, Codex `<root>/.agents/skills`).
 */
export const SkillScopeSchema = z.enum(['ferretry', 'user', 'project']);
export type SkillScope = z.infer<typeof SkillScopeSchema>;

export const SkillToggleSchema = z.object({
  supported: z.boolean(),
  enabled: z.boolean(),
  reason: z.string().min(1).optional(),
});
export type SkillToggle = z.infer<typeof SkillToggleSchema>;

export const SkillProjectRefSchema = z.object({ id: z.string().min(1).optional(), root: z.string().min(1) });
export type SkillProjectRef = z.infer<typeof SkillProjectRefSchema>;

export const SkillEntrySchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  harness: HarnessKeySchema,
  scope: SkillScopeSchema,
  /** Absolute path of the SKILL.md. The only path `GET /v1/skills/file` will serve. */
  path: z.string().min(1),
  runtimes: z.array(z.string().min(1)),
  project: SkillProjectRefSchema.optional(),
  shadowedBy: SkillScopeSchema.optional(),
  toggle: SkillToggleSchema.optional(),
});
export type SkillEntry = z.infer<typeof SkillEntrySchema>;

export const SkillHomeListingSchema = z.object({
  runtime: z.string().min(1),
  harness: HarnessKeySchema,
  home: z.string().min(1),
  skills: z.array(SkillEntrySchema),
});
export type SkillHomeListing = z.infer<typeof SkillHomeListingSchema>;

export const SkillProjectListingSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  root: z.string().min(1),
  skills: z.array(SkillEntrySchema),
});
export type SkillProjectListing = z.infer<typeof SkillProjectListingSchema>;

/** `GET /v1/skills`: every runtime home and every registered project. */
export const MachineSkillsInventorySchema = z.object({
  homes: z.array(SkillHomeListingSchema),
  projects: z.array(SkillProjectListingSchema),
  truncated: z.boolean(),
});
export type MachineSkillsInventory = z.infer<typeof MachineSkillsInventorySchema>;

/** `GET /v1/ferrets/:ferretId/skills/inventory`: exactly what that ferret sees. (Today's field `sessionId` is `ferretId`.) */
export const FerretSkillsInventorySchema = z.object({
  ferretId: z.string().min(1),
  harness: HarnessKeySchema,
  runtime: z.string().min(1).optional(),
  skills: z.array(SkillEntrySchema),
  truncated: z.boolean(),
});
export type FerretSkillsInventory = z.infer<typeof FerretSkillsInventorySchema>;

/** `GET /v1/skills/file`: the SKILL.md text of a skill the inventory lists. */
export const SkillFileSchema = z.object({ path: z.string().min(1), content: z.string() });
export type SkillFile = z.infer<typeof SkillFileSchema>;

/** The composer's autocomplete list (`/` and `$`): `GET /v1/ferrets/:ferretId/skills`. */
export const AvailableSkillSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  scope: z.enum(['global', 'project']),
  origin: z.enum(['claude-code', 'codex', 'both', 'unknown']),
});
export type AvailableSkill = z.infer<typeof AvailableSkillSchema>;

export const FerretSkillsSchema = z.object({ harness: HarnessKeySchema, skills: z.array(AvailableSkillSchema) });
export type FerretSkills = z.infer<typeof FerretSkillsSchema>;

// ─── copying one skill from this machine (docs/catalogs.md § Copying a skill from this machine) ───────────────────

/** How long a preview may be applied; the same decision window as a catalog install. */
export const LOCAL_SKILL_PREVIEW_TTL_SECONDS = 600;

export const LocalSkillPreviewIdSchema = z.string().regex(/^lsp_[A-Za-z0-9_-]{22}$/u, 'invalid local skill preview id');
export type LocalSkillPreviewId = z.infer<typeof LocalSkillPreviewIdSchema>;

export const LocalSkillInstallIdSchema = z.string().regex(/^lsi_[A-Za-z0-9_-]{22}$/u, 'invalid local skill install id');
export type LocalSkillInstallId = z.infer<typeof LocalSkillInstallIdSchema>;

/** A catalog item name: the folder a skill installs as. One plain path segment, a letter or digit first. */
export const SkillNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u,
    'use letters, digits, - and _ (at most 64), starting with a letter or digit',
  );

/** Where a copy goes: a project folder for one harness, or a runtime's profile. */
export const SkillInstallTargetSchema = z.discriminatedUnion('scope', [
  z.strictObject({
    scope: z.literal('project'),
    projectRoot: z.string().min(1).max(4_096).startsWith('/'),
    harness: HarnessKeySchema,
  }),
  z.strictObject({
    scope: z.literal('runtime'),
    runtime: z.string().min(1).max(128),
    profile: z.string().min(1).max(128),
  }),
]);
export type SkillInstallTarget = z.infer<typeof SkillInstallTargetSchema>;
export type SkillInstallScope = SkillInstallTarget['scope'];

/** The skill to copy, named by the SKILL.md path the inventory lists. Never opened on the caller's word (G175). */
export const LocalSkillSourceSchema = z.strictObject({ path: z.string().min(1).max(4_096).startsWith('/') });
export type LocalSkillSource = z.infer<typeof LocalSkillSourceSchema>;

export const LocalSkillPreviewRequestSchema = z.strictObject({
  source: LocalSkillSourceSchema,
  target: SkillInstallTargetSchema,
});
export type LocalSkillPreviewRequest = z.infer<typeof LocalSkillPreviewRequestSchema>;

/** Where a copy came from, as this machine found it in its own inventory, never as a caller reported it. */
export const LocalSkillOriginSchema = z.strictObject({
  kind: z.enum(['account', 'project']),
  owner: z.string().min(1).max(4_096),
  harness: HarnessKeySchema,
  path: z.string().min(1).max(4_096),
});
export type LocalSkillOrigin = z.infer<typeof LocalSkillOriginSchema>;

/** Catalogs' provenance record (inlined, partial: the synthetic one a runtime install records, "This machine"). */
export const SkillProvenanceSchema = z.strictObject({
  publisher: z.string().regex(/^fy_daemon_[A-Za-z0-9_-]{43}$/u, 'invalid daemon id'),
  publisherName: z.string().min(1).max(80),
  catalogId: z.string().regex(/^cat_[A-Za-z0-9_-]{22}$/u),
  catalogName: z.string().min(1).max(80),
  itemId: z.string().regex(/^itm_[A-Za-z0-9_-]{22}$/u),
  kind: z.enum(['skill', 'mcp', 'artifact']),
  name: SkillNameSchema,
  version: z.number().int().min(1),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
});

export const SkillReviewEntrySchema = z.strictObject({
  label: z.string().min(1),
  text: z.string(),
  document: z.boolean(),
});
export type SkillReviewEntry = z.infer<typeof SkillReviewEntrySchema>;

export const SKILL_INSTALL_WARNING_CODES = [
  'unpinned-package',
  'network-url',
  'carries-scripts',
  'older-version',
  'edited-locally',
  'first-publisher',
  'package-registry',
  'runs-on-its-own',
  'hidden-characters',
  'possible-secret',
] as const;
export const SkillInstallWarningSchema = z.strictObject({
  code: z.enum(SKILL_INSTALL_WARNING_CODES),
  text: z.string().min(1),
});
export type SkillInstallWarning = z.infer<typeof SkillInstallWarningSchema>;

/** A file in the source folder that is not copied, with the reason (links, binaries, credential names…). */
export const SkillSourceProblemSchema = z.strictObject({
  subject: z.string().min(1).max(512),
  reason: z.string().min(1).max(1_024),
});
export type SkillSourceProblem = z.infer<typeof SkillSourceProblemSchema>;

/** The review: where it is from, every file in full, and what to look at. */
export const LocalSkillPreviewSchema = z.strictObject({
  previewId: LocalSkillPreviewIdSchema,
  expiresAt: InstantSchema,
  name: SkillNameSchema,
  origin: LocalSkillOriginSchema,
  provenance: SkillProvenanceSchema,
  target: SkillInstallTargetSchema,
  destination: z.string().min(1),
  review: z.array(SkillReviewEntrySchema),
  skipped: z.array(SkillSourceProblemSchema),
  warnings: z.array(SkillInstallWarningSchema),
  replaces: z.strictObject({ installId: LocalSkillInstallIdSchema }).optional(),
});
export type LocalSkillPreview = z.infer<typeof LocalSkillPreviewSchema>;

/** Apply exactly one preview. */
export const LocalSkillInstallRequestSchema = z.strictObject({ previewId: LocalSkillPreviewIdSchema });
export type LocalSkillInstallRequest = z.infer<typeof LocalSkillInstallRequestSchema>;

export const LocalSkillInstallSchema = z.strictObject({
  installId: LocalSkillInstallIdSchema,
  installedAt: InstantSchema,
  name: SkillNameSchema,
  origin: LocalSkillOriginSchema,
  target: SkillInstallTargetSchema,
  destination: z.string().min(1),
  /** The folder's files this install wrote, by path, each with the SHA-256 recorded. */
  files: z.array(z.strictObject({ path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/u) })),
});
export type LocalSkillInstall = z.infer<typeof LocalSkillInstallSchema>;

export const LocalSkillInstalledSchema = z.strictObject({
  install: LocalSkillInstallSchema,
  notes: z.array(z.string().min(1)),
});
export type LocalSkillInstalled = z.infer<typeof LocalSkillInstalledSchema>;

export const LocalSkillRemovedSchema = z.strictObject({
  installId: LocalSkillInstallIdSchema,
  name: SkillNameSchema,
  destination: z.string().min(1),
});
export type LocalSkillRemoved = z.infer<typeof LocalSkillRemovedSchema>;

export const LocalSkillInstallListSchema = z.strictObject({ installs: z.array(LocalSkillInstallSchema) });
export type LocalSkillInstallList = z.infer<typeof LocalSkillInstallListSchema>;

/** Why this machine refused, in the order it checks. */
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

// ─── config: config/skills/<name>.yaml (today's SkillsComponentSchema) ───────────────────────────────────────────

const NonEmptyString = z.string().min(1);

/** A component name: one safe path segment (today's `SafeNameSchema`). */
export const SafeNameSchema = NonEmptyString.max(64)
  .refine(value => value.trim() === value, { message: 'must not start or end with whitespace' })
  .refine(value => !/[/\\]/.test(value), { message: 'must not contain a path separator' })
  .refine(value => value !== '.' && !value.includes('..'), { message: 'must not contain a path traversal segment' })
  .refine(value => ![...value].some(character => (character.codePointAt(0) ?? 0) < 32), {
    message: 'must not contain control characters',
  });

/** A selection of skill folders from the skills store, each landing under its own name. */
export const SkillsItemSchema = z
  .strictObject({
    items: z.array(SafeNameSchema).min(1),
    harness: HarnessKeySchema.optional(),
    clonedFrom: NonEmptyString.optional(),
    clonedFromDaemon: NonEmptyString.optional(),
    clonedFromKey: NonEmptyString.optional(),
    installedFrom: z
      .strictObject({
        publisher: NonEmptyString,
        publisherName: NonEmptyString,
        catalogId: NonEmptyString,
        catalogName: NonEmptyString,
        itemId: NonEmptyString,
        kind: z.enum(['skill', 'mcp']),
        name: NonEmptyString,
        version: z.number().int().min(1),
        digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
      })
      .optional(),
  })
  .check(ctx => {
    const seen = new Set<string>();
    ctx.value.items.forEach((item, index) => {
      if (seen.has(item))
        ctx.issues.push({
          code: 'custom',
          message: `skill item "${item}" is listed twice`,
          input: item,
          path: ['items', index],
        });
      seen.add(item);
    });
  });
export type SkillsItem = z.infer<typeof SkillsItemSchema>;
