import { z } from 'zod';
import { InstantSchema } from './common.ts';
import { HarnessSchema } from './session.ts';

/** Display-safe metadata from a skill manifest. The daemon never returns SKILL.md contents. */
export const AvailableSkillSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  scope: z.enum(['global', 'project']),
  origin: z.enum(['claude', 'codex', 'both', 'unknown']),
});
export type AvailableSkill = z.infer<typeof AvailableSkillSchema>;

/** The skill catalog for one session's harness and project directory. */
export const SessionSkillsSchema = z.object({
  harness: HarnessSchema,
  skills: z.array(AvailableSkillSchema),
});
export type SessionSkills = z.infer<typeof SessionSkillsSchema>;

/** A directory the daemon has deliberately registered as a launchable project. */
export const ProjectInfoSchema = z.object({
  name: z.string().trim().min(1),
  path: z.string().min(1),
  lastActivity: InstantSchema.optional(),
});
export type ProjectInfo = z.infer<typeof ProjectInfoSchema>;

export const ProjectListSchema = z.array(ProjectInfoSchema);
export type ProjectList = z.infer<typeof ProjectListSchema>;
