import { z } from 'zod';

/**
 * A project is a folder that can hold several git repositories and be linked to several git accounts (r9 B5).
 *
 * An account here is a plain id string: this plugin does not know what an account is (B1's `git-accounts` owns that), so
 * a link is only the id the caller gave. A link outlives the account it names; {@link accountLinks} says which ones
 * point at an account that is gone.
 */

/** The most accounts one project links, and the most repositories one scan answers. */
export const MAX_PROJECT_ACCOUNTS = 32;
export const MAX_PROJECT_REPOS = 50;

/** The code hosts a repository can be recognised on. A closed union so another host is one more member. */
export const GIT_PROVIDERS = ['github'] as const;
export type GitProvider = (typeof GIT_PROVIDERS)[number];

/** One account id: text, no control characters, no padding. It is an identity of someone else's plugin, never a secret. */
export const ProjectAccountIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(id => id === id.trim() && !/\p{Cc}/u.test(id), {
    message: 'an account id has no padding space or control character',
  });

/** One git repository inside a project folder. */
export const ProjectRepoSchema = z.strictObject({
  /** Relative to the project folder, `/`-separated, no `..`; `.` is the project folder itself. */
  path: z
    .string()
    .min(1)
    .max(1024)
    .refine(
      path =>
        path === '.' ||
        (!path.startsWith('/') && !path.split('/').some(part => part === '' || part === '..' || part === '.')),
      {
        message: 'a repository path is relative to the project and has no . or .. in it',
      },
    ),
  /** Where `origin` points, as `https://<host>/<owner>/<name>`. Never the remote as written: it may carry a token. */
  remote: z.string().min(1).max(2048).optional(),
  provider: z.enum(GIT_PROVIDERS).optional(),
  /** The account this repository uses instead of the project's first one. Kept across scans, by path. */
  account: ProjectAccountIdSchema.optional(),
});
export type ProjectRepo = z.infer<typeof ProjectRepoSchema>;

/** `PUT /v1/projects/:id/accounts`: the whole list, in order (the first is the project's default). */
export const SetProjectAccountsRequestSchema = z.strictObject({
  accounts: z.array(ProjectAccountIdSchema).max(MAX_PROJECT_ACCOUNTS),
});
export type SetProjectAccountsRequest = z.infer<typeof SetProjectAccountsRequestSchema>;

/** `GET /v1/projects/:id/repos`: what a scan of the project folder found now. */
export const ProjectReposAnswerSchema = z.strictObject({
  repos: z.array(ProjectRepoSchema).max(MAX_PROJECT_REPOS),
  /** The scan stopped at a bound (too many repositories or folders): there may be more. */
  truncated: z.boolean(),
});
export type ProjectReposAnswer = z.infer<typeof ProjectReposAnswerSchema>;

/** One account link as a screen shows it: `removed` when the account no longer exists. */
export interface AccountLink {
  readonly id: string;
  readonly removed: boolean;
}

/**
 * The project's account links against the accounts that exist now. A link whose account is gone stays, and reads
 * "account removed", so the project never silently loses a choice the owner made.
 */
export const accountLinks = (
  linked: readonly string[] | undefined,
  existing: readonly string[],
): readonly AccountLink[] => {
  const known = new Set(existing);
  return (linked ?? []).map(id => ({ id, removed: !known.has(id) }));
};
