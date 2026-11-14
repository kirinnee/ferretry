/**
 * THE CONFIGURATION FILES OVER THE KERNEL'S ROUTES (docs/config-files.md), as Settings › Files needs them: what every
 * declared file stands at (`GET /v1/config/status`), one file (`GET /v1/config/file`), an edit against the etag it was
 * read at (`PUT /v1/config/file`) and the owner's confirmation of an edit held for them (`POST /v1/config/confirm`).
 * Gate answers per file who may read, write or confirm it. The shell client carries no headers, so the etag travels in
 * the body. A file names secrets only as `${secret:NAME}`: the kernel refuses a raw value and never returns one.
 */
import { z } from 'zod';
import { callFailure, type KernelClient, reasonOf } from '../lib/client.ts';

export { reasonOf };

const NonEmpty = z.string().min(1);

const ConfigIssueSchema = z.looseObject({
  path: NonEmpty,
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  severity: z.enum(['error', 'warning']),
  message: NonEmpty,
  fix: z.string().optional(),
});
export type ConfigIssue = z.infer<typeof ConfigIssueSchema>;

/** An edit held for the owner: the tighter version stays in effect until it is confirmed. */
const ConfigPendingSchema = z.looseObject({ path: NonEmpty, etag: NonEmpty, changes: z.array(NonEmpty).min(1) });
export type ConfigPending = z.infer<typeof ConfigPendingSchema>;

const CONFIG_FILE_STATES = ['ok', 'invalid', 'pending'] as const;
export type ConfigFileState = (typeof CONFIG_FILE_STATES)[number];

const ConfigFileSummarySchema = z.looseObject({
  path: NonEmpty,
  /** The plugin that declared the file. */
  kind: NonEmpty,
  state: z.enum(CONFIG_FILE_STATES),
});

/** `GET /v1/config/status`. */
const ConfigStatusViewSchema = z.looseObject({
  directory: NonEmpty,
  files: z.array(ConfigFileSummarySchema),
  issues: z.array(ConfigIssueSchema),
  pending: z.array(ConfigPendingSchema),
});
export type ConfigStatusView = z.infer<typeof ConfigStatusViewSchema>;

/** One file as it is on disk, with the etag to edit it against. */
const ConfigFileViewSchema = z.looseObject({
  path: NonEmpty,
  absolutePath: NonEmpty.optional(),
  exists: z.boolean(),
  text: z.string(),
  etag: NonEmpty,
  issues: z.array(ConfigIssueSchema).optional(),
});
export type ConfigFileView = z.infer<typeof ConfigFileViewSchema>;

/** What a write did: `applied` (in effect now), or `pending` (written, held for the owner's confirmation). */
const ConfigFilePutResultSchema = z.looseObject({
  path: NonEmpty,
  etag: NonEmpty,
  outcome: z.enum(['applied', 'pending']),
  pending: ConfigPendingSchema.optional(),
});
export type ConfigFilePutResult = z.infer<typeof ConfigFilePutResultSchema>;

const ConfigConfirmResultSchema = z.looseObject({ path: NonEmpty, confirmed: z.boolean() });

/** The body of a `422 config_invalid` refusal: its sentence and the located issues. */
const ConfigInvalidBodySchema = z.looseObject({ error: NonEmpty, issues: z.array(ConfigIssueSchema) });
type ConfigInvalidBody = z.infer<typeof ConfigInvalidBodySchema>;

export async function readConfigStatus(client: KernelClient): Promise<ConfigStatusView> {
  return ConfigStatusViewSchema.parse(await client.call('GET /v1/config/status'));
}

export async function readConfigFile(client: KernelClient, path: string): Promise<ConfigFileView> {
  return ConfigFileViewSchema.parse(await client.call('GET /v1/config/file', { query: { path } }));
}

/** Writes one file against the etag it was edited from; the daemon refuses a file that moved since. */
export async function writeConfigFile(
  client: KernelClient,
  path: string,
  text: string,
  etag: string,
): Promise<ConfigFilePutResult> {
  return ConfigFilePutResultSchema.parse(await client.call('PUT /v1/config/file', { body: { path, text, etag } }));
}

/** What a confirm says when the edit it named is no longer the one waiting. */
const STALE_CONFIRM =
  'That edit is no longer the one waiting — the file changed since. Review it again before confirming.';

/**
 * Confirms one held edit and says what happened, never throwing: `null` is "confirmed", a sentence is why it was not.
 * A passkey, when the daemon asks for one, is raised by the shell around the call.
 */
export async function confirmHeld(
  client: KernelClient,
  pending: Pick<ConfigPending, 'path' | 'etag'>,
): Promise<string | null> {
  try {
    const result = ConfigConfirmResultSchema.parse(
      await client.call('POST /v1/config/confirm', { body: { path: pending.path, etag: pending.etag } }),
    );
    return result.confirmed ? null : STALE_CONFIRM;
  } catch (cause) {
    return reasonOf(cause);
  }
}

/** The located issues a `422 config_invalid` refusal carries; `undefined` for any other error. */
export const configInvalidBody = (error: unknown): ConfigInvalidBody | undefined => {
  const parsed = ConfigInvalidBodySchema.safeParse((error as { readonly body?: unknown } | null)?.body);
  return parsed.success ? parsed.data : undefined;
};

/** The daemon's refusal code on an error, when it gave one. */
export const configErrorCode = (error: unknown): string | undefined => {
  const code = callFailure(error)?.code;
  return typeof code === 'string' ? code : undefined;
};
