/**
 * Skills' wire schemas, copied from today's `@ferretry/protocol` (`skills-inventory.ts`, `catalog.ts`'s `SessionSkills`)
 * and `@ferretry/fleet` (`SkillsComponentSchema`). Strict objects where today's were; the inventory objects stay
 * non-strict as today's are (`z.object`), because the harness side may add a field.
 *
 * Inlined foreign pieces (a contract imports no other plugin's): the harness key (`claude` → `claude-code`, the plugin id).
 */
import { z } from 'zod';
import { HarnessKeySchema } from '@ferretry/core-ferrets/contract';

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
  /** The folder the ferret works in: what "+ Add skills" uses to pre-select the project the ferret sits in. */
  folder: z.string().min(1),
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
