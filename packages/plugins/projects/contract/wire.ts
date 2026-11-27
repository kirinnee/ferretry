import type { Brand } from '@ferretry/std';
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { MAX_PROJECT_ACCOUNTS, MAX_PROJECT_REPOS, ProjectAccountIdSchema, ProjectRepoSchema } from './repos.ts';

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
  /**
   * Present only when Git was attached while registering the folder: the repository the folder itself belongs to
   * (registration dedupes on it). The repositories INSIDE the folder are `repos`.
   */
  git: z.strictObject({ commonDirectory: z.string().min(1) }).optional(),
  lastActivity: InstantSchema.optional(),
  /**
   * The git accounts this project uses, by id; the first is the default. Absent (a record written before r9) reads as none.
   * Optional on purpose: the file stays `format: 1` and every older record stays valid as it is.
   */
  accounts: z.array(ProjectAccountIdSchema).max(MAX_PROJECT_ACCOUNTS).optional(),
  /** The repositories last found inside the folder (`GET /v1/projects/:id/repos` refreshes it). Absent reads as none yet. */
  repos: z.array(ProjectRepoSchema).max(MAX_PROJECT_REPOS).optional(),
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
  // Never trimmed: a picked folder may end in a space, and trimming would name a different sibling path.
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

/** The folder `git clone` makes for an address: its last segment without `.git` (`…/you/project.git` → `project`). */
export const cloneFolderName = (url: string): string | null => {
  const text = url.trim();
  // The address's PATH names the repository: `https://github.com/` has none, and its host is not a folder name.
  const path = URL.canParse(text) ? new URL(text).pathname : '';
  const name = (path.split('/').filter(Boolean).pop() ?? '').replace(/\.git$/u, '');
  // One folder name, never a way out of the project: `..` and `.` name no repository.
  return name === '' || name === '.' || name === '..' ? null : name;
};

export const CloneRepoCredentialsMessage =
  'Use Accounts and secrets for sign-in, then paste a repository address without credentials.';

/**
 * SSH usernames (for example `git`) select an account; ANY userinfo on an http(s) address (a token is often sent as the
 * username) and any password embeds a credential. Judged on the parsed URL AND on the raw authority, because the parser
 * skips extra slashes (`https:///tok@host`) and git receives the raw text.
 */
export const cloneAddressHasCredentials = (value: string): boolean => {
  const text = value.trim();
  if (/^https?:[/\\]*[^/\\?#]*@/iu.test(text)) return true;
  if (!URL.canParse(text)) return false;
  const url = new URL(text);
  return url.password !== '' || (/^https?:$/u.test(url.protocol) && url.username !== '');
};

/** Existing-project clones accept remote sources only: local sources would bypass the folder reader's policy. */
export const CloneRepoRequestSchema = z.strictObject({
  url: ProjectCloneUrlSchema.refine(value => !URL.canParse(value) || new URL(value).protocol !== 'file:', {
    message: 'Use an https:// or ssh:// remote repository address; local sources are not allowed here.',
  }).refine(value => !cloneAddressHasCredentials(value), { message: CloneRepoCredentialsMessage }),
});
export type CloneRepoRequest = z.infer<typeof CloneRepoRequestSchema>;

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
