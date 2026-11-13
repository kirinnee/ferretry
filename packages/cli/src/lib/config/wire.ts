/**
 * The answers of the Kernel's configuration routes, as `fy config` reads them. Parsed, not cast: a daemon that answered
 * an older shape surfaces as a stated failure, not as an undefined field deep inside rendering. None of them carries a
 * secret value: a file's text names secrets as `${secret:NAME}` only.
 */
import { z } from 'zod';

const IssueSchema = z.object({
  path: z.string(),
  line: z.number().int().optional(),
  column: z.number().int().optional(),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  fix: z.string(),
});

const PendingSchema = z.object({
  path: z.string(),
  etag: z.string(),
  changes: z.array(z.string()),
});

/** `GET /v1/config/status`. */
export const StatusViewSchema = z.object({
  directory: z.string(),
  files: z.array(z.object({ path: z.string(), kind: z.string(), schema: z.string(), state: z.string() })),
  issues: z.array(IssueSchema),
  pending: z.array(PendingSchema),
});

/** `GET /v1/config/file?path=`. */
export const FileViewSchema = z.object({
  path: z.string(),
  absolutePath: z.string(),
  exists: z.boolean(),
  text: z.string(),
  etag: z.string(),
  state: z.string(),
  issues: z.array(IssueSchema),
});

/** `PUT /v1/config/file`. */
export const PutResultSchema = z.object({
  path: z.string(),
  etag: z.string(),
  outcome: z.enum(['applied', 'pending']),
  pending: PendingSchema.optional(),
});

/** `POST /v1/config/confirm`. */
export const ConfirmResultSchema = z.object({ path: z.string(), confirmed: z.boolean() });

/** The 422 a file that does not check is refused with: the sentence, and every located problem. */
export const InvalidBodySchema = z.object({
  error: z.string(),
  code: z.literal('config_invalid'),
  issues: z.array(IssueSchema),
});
