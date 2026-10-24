/**
 * The skills inventory: which skills exist on this machine and which one ferret actually sees.
 *
 * Distinct from `catalog.ts`'s {@link AvailableSkill}, which is the composer's autocomplete list: this one
 * says WHERE each skill came from (`scope`), WHICH runtimes see it, whether another skill of the same name
 * wins, and the absolute path of its SKILL.md so the person can open it.
 */
import { z } from 'zod';
import { HarnessSchema } from './session.ts';

/**
 * Where a skill comes from.
 *  - `ferretry`: a Ferretry skill component, materialised into a runtime home as a link into the fleet assets.
 *  - `user`: the harness home's own skills directory, not from Ferretry.
 *  - `project`: a project folder — Claude reads `<root>/.claude/skills`, Codex reads `<root>/.agents/skills`
 *    (the path is present in the Codex 0.156 binary; `.codex/skills` is a user-level location only).
 */
export const SkillScopeSchema = z.enum(['ferretry', 'user', 'project']);
export type SkillScope = z.infer<typeof SkillScopeSchema>;

/**
 * Whether the skill can be switched off from here. No harness toggle is verified yet, so every entry
 * reports `supported: false` with the reason; `enabled` is what the harness is assumed to do (load it).
 */
export const SkillToggleSchema = z.object({
  supported: z.boolean(),
  enabled: z.boolean(),
  reason: z.string().min(1).optional(),
});
export type SkillToggle = z.infer<typeof SkillToggleSchema>;

export const SkillProjectRefSchema = z.object({
  id: z.string().min(1).optional(),
  root: z.string().min(1),
});
export type SkillProjectRef = z.infer<typeof SkillProjectRefSchema>;

export const SkillEntrySchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  harness: HarnessSchema,
  scope: SkillScopeSchema,
  /** Absolute path of the SKILL.md. The only path `GET /v1/skills/file` will serve. */
  path: z.string().min(1),
  /** The runtimes (wrapper names) that see this skill. */
  runtimes: z.array(z.string().min(1)),
  project: SkillProjectRefSchema.optional(),
  /** Set when a same-name skill of this scope wins over this one, so this one is not what the harness loads. */
  shadowedBy: SkillScopeSchema.optional(),
  toggle: SkillToggleSchema.optional(),
});
export type SkillEntry = z.infer<typeof SkillEntrySchema>;

/** One runtime's home and the skills in it. */
export const SkillHomeListingSchema = z.object({
  runtime: z.string().min(1),
  harness: HarnessSchema,
  home: z.string().min(1),
  skills: z.array(SkillEntrySchema),
});
export type SkillHomeListing = z.infer<typeof SkillHomeListingSchema>;

/** One registered project and the skills in it, for both harnesses. */
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
  /** True when a per-directory or total cap cut the listing short. */
  truncated: z.boolean(),
});
export type MachineSkillsInventory = z.infer<typeof MachineSkillsInventorySchema>;

/** `GET /v1/sessions/:sessionId/skills/inventory`: exactly what that ferret sees. */
export const SessionSkillsInventorySchema = z.object({
  sessionId: z.string().min(1),
  harness: HarnessSchema,
  /** The runtime (wrapper name) the session runs as, or absent when it runs no fleet account. */
  runtime: z.string().min(1).optional(),
  skills: z.array(SkillEntrySchema),
  truncated: z.boolean(),
});
export type SessionSkillsInventory = z.infer<typeof SessionSkillsInventorySchema>;

/** `GET /v1/skills/file`: the SKILL.md text of a skill the inventory lists. */
export const SkillFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});
export type SkillFile = z.infer<typeof SkillFileSchema>;
