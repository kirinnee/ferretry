import type { Brand } from '@ferretry/std';
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';

/** A project's stable, daemon-local id. A path is not an identity. */
export type ProjectId = Brand<string, 'ProjectId'>;
export const ProjectIdSchema = z.uuid().transform(value => value as ProjectId);

/** A directory the daemon has deliberately registered as a launchable project (today's `ProjectInfoSchema`). */
export const ProjectInfoSchema = z.strictObject({
  id: ProjectIdSchema,
  name: z.string().trim().min(1),
  /** Canonical, resolved workspace root. It can be a non-Git folder. */
  path: z.string().min(1),
  /** The deliberate action that created this record. Discoveries require confirmation. */
  source: z.enum(['existing-folder', 'clone', 'new-folder', 'confirmed-discovery']),
  createdAt: InstantSchema,
  /** Present only when Git was attached while registering the folder. */
  git: z.strictObject({ commonDirectory: z.string().min(1) }).optional(),
  lastActivity: InstantSchema.optional(),
});
export type ProjectInfo = z.infer<typeof ProjectInfoSchema>;

export const ProjectListSchema = z.array(ProjectInfoSchema);
export type ProjectList = z.infer<typeof ProjectListSchema>;

/**
 * Whether a registered project path is an absolute root (POSIX: a leading `/`). A relative path would resolve against
 * the daemon's own working directory, letting a caller name a directory it cannot see.
 */
export const ProjectPathMustBeAbsoluteMessage =
  "a project path must be absolute; a relative path would resolve against the daemon's own directory";
export const ProjectPathSchema = z
  .string()
  .trim()
  .min(1)
  .refine(path => path.startsWith('/'), { message: ProjectPathMustBeAbsoluteMessage });

export const ProjectCloneUrlUnsupportedMessage = 'a clone address must be an https://, ssh:// or file:/// URL';

/** The transports a clone may use. */
const CLONE_TRANSPORTS: ReadonlySet<string> = new Set(['https:', 'ssh:', 'file:']);

/**
 * Whether git may be handed this exact text as a clone source. Judged on the RAW text as well as the parsed URL,
 * because git receives the raw text (the WHATWG parser repairs `https:/host`, strips a tab and accepts `ssh::x`, which
 * git reads as `<transport>::<address>`, the remote-helper syntax `ext::` uses to run a command). A host starting with
 * `-` is refused so it can never reach ssh as an option.
 */
function isProjectCloneUrl(value: string): boolean {
  if (/[\p{Cc}\s]/u.test(value) || !URL.canParse(value)) return false;
  const url = new URL(value);
  if (!CLONE_TRANSPORTS.has(url.protocol)) return false;
  if (!value.toLowerCase().startsWith(`${url.protocol}//`)) return false;
  if (url.protocol === 'file:') return url.host === '';
  return url.hostname !== '' && !url.hostname.startsWith('-');
}

export const ProjectCloneUrlSchema = z
  .string()
  .refine(isProjectCloneUrl, { message: ProjectCloneUrlUnsupportedMessage });

/** Every route is explicit: scanning a path is never a registration operation (today's `RegisterProjectRequestSchema`). */
export const RegisterProjectRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('existing-folder'),
    path: ProjectPathSchema,
    name: z.string().trim().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal('confirmed-discovery'),
    path: ProjectPathSchema,
    name: z.string().trim().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal('new-folder'),
    path: ProjectPathSchema,
    name: z.string().trim().min(1).optional(),
    initializeGit: z.boolean().default(false),
  }),
  z.strictObject({
    kind: z.literal('clone'),
    url: ProjectCloneUrlSchema,
    path: ProjectPathSchema,
    name: z.string().trim().min(1).optional(),
  }),
]);
export type RegisterProjectRequest = z.infer<typeof RegisterProjectRequestSchema>;

/** `state/projects/projects.json`: the whole registry, `format` first (§9.2). */
export const PROJECTS_FORMAT = 1;
export const ProjectsFileSchema = z.strictObject({
  format: z.literal(PROJECTS_FORMAT),
  projects: ProjectListSchema,
});
export type ProjectsFile = z.infer<typeof ProjectsFileSchema>;

/** Why a registration or removal was refused. `registration_failed` is today's `project_registration_failed` (422). */
export const PROJECT_REFUSAL_CODES = ['registration_failed', 'not_found'] as const;
export type ProjectRefusalCode = (typeof PROJECT_REFUSAL_CODES)[number];
export const ProjectRefusalSchema = z.strictObject({
  code: z.enum(PROJECT_REFUSAL_CODES),
  message: z.string().min(1),
});
export type ProjectRefusal = z.infer<typeof ProjectRefusalSchema>;
