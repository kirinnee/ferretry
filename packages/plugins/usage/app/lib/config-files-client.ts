/**
 * THE CONFIGURATION FILES OVER THE DAEMON'S CLIENT (docs/config-files.md), as the budget editor needs them.
 *
 * ASSUMED, NOT DECLARED HERE: the config service's three routes keep today's keys — `GET /v1/config/file?path=`,
 * `PUT /v1/config/file` and `POST /v1/config/confirm` (design Appendix D, G44/G131 name the last two) — and the
 * client reaches them by key like any route. The shell client carries no headers, so the etag an edit was made
 * against travels in the body (`etag`) instead of `If-Match`. This is the ONE file to change when the kernel's
 * routes are declared.
 */
import { z } from 'zod';
import { callRefusal, type UsageClient } from '../shell.ts';

const NonEmpty = z.string().min(1);

const ConfigIssueSchema = z.looseObject({
  path: NonEmpty,
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  severity: z.enum(['error', 'warning']),
  message: NonEmpty,
});

/** One file as it is on disk, with its digest to edit against. */
const ConfigFileViewSchema = z.looseObject({
  path: NonEmpty,
  exists: z.boolean(),
  text: z.string(),
  etag: NonEmpty,
  issues: z.array(ConfigIssueSchema).optional(),
});
export type ConfigFileView = z.infer<typeof ConfigFileViewSchema>;

/** An edit held for the owner: the tighter version stays in effect until it is confirmed. */
const ConfigPendingSchema = z.looseObject({
  path: NonEmpty,
  etag: NonEmpty,
  changes: z.array(NonEmpty).min(1),
});
export type ConfigPending = z.infer<typeof ConfigPendingSchema>;

/** What a write did: `applied` (in effect now), or `pending` (written, held for the owner's confirmation). */
const ConfigFilePutResultSchema = z.looseObject({
  path: NonEmpty,
  etag: NonEmpty,
  outcome: z.enum(['applied', 'pending']),
  pending: ConfigPendingSchema.optional(),
});
export type ConfigFilePutResult = z.infer<typeof ConfigFilePutResultSchema>;

const ConfigConfirmResultSchema = z.looseObject({ path: NonEmpty, confirmed: z.boolean() });

/** One file as it is on disk. */
export async function readConfigFile(client: UsageClient, path: string): Promise<ConfigFileView> {
  return ConfigFileViewSchema.parse(await client.call('GET /v1/config/file', { query: { path } }));
}

/** Write one file against the digest it was edited from; refused unless it checks. */
export async function writeConfigFile(
  client: UsageClient,
  path: string,
  text: string,
  etag: string,
): Promise<ConfigFilePutResult> {
  return ConfigFilePutResultSchema.parse(await client.call('PUT /v1/config/file', { body: { path, text, etag } }));
}

/** What a confirm says when the edit it named is no longer the one waiting. */
const STALE_CONFIRM =
  'That edit is no longer the one waiting — the file changed since. Review it again before confirming.';

/** What an error says, as one sentence — or that the machine did not answer. */
export const reasonOf = (cause: unknown): string => {
  const message = cause instanceof Error ? cause.message.trim() : '';
  return message === '' ? 'This machine did not answer.' : message;
};

/**
 * Confirm one held edit and say what happened, never throwing: `null` is "confirmed", a sentence is why it was
 * not. A passkey, when the daemon asks for one, is raised by the shell around the call.
 */
export async function confirmHeld(client: UsageClient, pending: Pick<ConfigPending, 'path' | 'etag'>): Promise<string | null> {
  try {
    const result = ConfigConfirmResultSchema.parse(
      await client.call('POST /v1/config/confirm', { body: { path: pending.path, etag: pending.etag } }),
    );
    return result.confirmed ? null : STALE_CONFIRM;
  } catch (cause) {
    return reasonOf(cause);
  }
}

/** The daemon's refusal code on an error, when it gave one. */
export const configErrorCode = (error: unknown): string | undefined => callRefusal(error)?.code;
