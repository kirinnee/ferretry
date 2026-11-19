import { z } from 'zod';

/**
 * Ferretry's `gh` (r9 B9): the daemon runs `gh` as the account the caller's folder is linked to, and answers its masked
 * output. Use, never read: the answer has no field that could hold a token, and the request names no account's secret.
 *
 * NOT here (a declared GAP, docs/secrets.md "Ferretry's `gh`"): stdin and file slots. The seam under this route
 * (`GitAccountsApi.run`) refuses every flag that reads a local file, so there is nothing to send them to.
 */
export const MAX_GH_ARGS = 64;
export const MAX_GH_ARG_LENGTH = 16 * 1024;
/** The most output of either stream one run answers (the same bound as `fy secret use`). */
export const MAX_GH_OUTPUT_BYTES = 4 * 1024 * 1024;

export const GhRunRequestSchema = z.strictObject({
  /** `gh`'s arguments, without the program name. */
  argv: z.array(z.string().max(MAX_GH_ARG_LENGTH)).min(1).max(MAX_GH_ARGS),
  /** The folder the caller is working in; an absolute path. It decides the account and the repository. */
  cwd: z
    .string()
    .min(1)
    .max(4_096)
    .refine(path => path.startsWith('/') && !path.includes('\0'), { message: 'cwd is an absolute path' }),
  /** A login or an account id. Only the owner may choose; a ferret never does. */
  account: z.string().min(1).max(128).optional(),
});
export type GhRunRequest = z.infer<typeof GhRunRequestSchema>;

/** What ran (both streams already masked), or the one sentence that says why it did not and what to do instead. */
export const GhRunAnswerSchema = z.union([
  z.strictObject({
    exitCode: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
  }),
  z.strictObject({ refused: z.string().min(1).max(1_000) }),
]);
export type GhRunAnswer = z.infer<typeof GhRunAnswerSchema>;
