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
  /** Stable daemon-local record identity; a path is not an identity. */
  id: z.string().uuid(),
  name: z.string().trim().min(1),
  /** Canonical, resolved workspace root. It can be a non-Git folder. */
  path: z.string().min(1),
  /** The deliberate action that created this record. Discoveries require confirmation. */
  source: z.enum(['existing-folder', 'clone', 'new-folder', 'confirmed-discovery']),
  createdAt: InstantSchema,
  /** Present only when Git was attached while registering the folder. */
  git: z
    .object({
      commonDirectory: z.string().min(1),
    })
    .optional(),
  lastActivity: InstantSchema.optional(),
});
export type ProjectInfo = z.infer<typeof ProjectInfoSchema>;

export const ProjectListSchema = z.array(ProjectInfoSchema);
export type ProjectList = z.infer<typeof ProjectListSchema>;

/**
 * Whether a registered project path is an absolute root (POSIX: a leading `/`).
 * A relative path would resolve against the daemon's own working directory,
 * letting a caller name a directory it cannot see, so refusing it is the trust
 * boundary both programs share. Spelled inline rather than importing a Node path
 * module, so this stays loadable in the browser bundle with no polyfill; the
 * shipped daemon targets are POSIX (Linux/macOS).
 */
function isProjectPathAbsolute(path: string): boolean {
  return path.startsWith('/');
}

/** The policy refusal the daemon mount may distinguish from ordinary malformed input. */
export const ProjectPathMustBeAbsoluteMessage =
  "a project path must be absolute; a relative path would resolve against the daemon's own directory";

/**
 * The single owner of "a registered project path is absolute" (see
 * fact-ownership R1): a parser both ends of the wire share rather than a rule
 * each reinterprets. Applied to every registration arm, so the wire itself
 * refuses a relative path a caller cannot otherwise be trusted to name.
 */
export const ProjectPathSchema = z.string().trim().min(1).refine(isProjectPathAbsolute, {
  message: ProjectPathMustBeAbsoluteMessage,
});

/** Every route is explicit: scanning a path is never a registration operation. */
export const RegisterProjectRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing-folder'), path: ProjectPathSchema, name: z.string().trim().min(1).optional() }),
  z.object({
    kind: z.literal('confirmed-discovery'),
    path: ProjectPathSchema,
    name: z.string().trim().min(1).optional(),
  }),
  z.object({
    kind: z.literal('new-folder'),
    path: ProjectPathSchema,
    name: z.string().trim().min(1).optional(),
    initializeGit: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal('clone'),
    url: z.string().url(),
    path: ProjectPathSchema,
    name: z.string().trim().min(1).optional(),
  }),
]);
export type RegisterProjectRequest = z.infer<typeof RegisterProjectRequestSchema>;
