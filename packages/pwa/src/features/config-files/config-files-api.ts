/**
 * The configuration files over HTTP (docs/config-files.md), as the Files panel needs them.
 *
 * Every call takes a client rather than building one: the files belong to ONE machine, and the app's
 * client pool is what carries a call there — direct first, the relay as the automatic fallback — and
 * what asks for a passkey when the daemon refuses for want of one, then sends the call once more.
 */

import {
  CONFIG_IF_MATCH_HEADER,
  type ConfigConfirmResult,
  ConfigConfirmResultSchema,
  type ConfigFilePutResult,
  ConfigFilePutResultSchema,
  type ConfigFileView,
  ConfigFileViewSchema,
  type ConfigInvalidBody,
  ConfigInvalidBodySchema,
  type ConfigPending,
  type ConfigStatusView,
  ConfigStatusViewSchema,
  type IFyApiClient,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';

/** The only client capability the Files panel uses. */
export type ConfigFilesClient = Pick<IFyApiClient, 'request'>;

/** What this machine's files are, which of them are wrong, and which edits wait for the owner. */
export async function readConfigStatus(client: ConfigFilesClient): Promise<ConfigStatusView> {
  return await client.request('/v1/config/status', ConfigStatusViewSchema);
}

/** One file as it is on disk, with its digest to edit against. */
export async function readConfigFile(client: ConfigFilesClient, path: string): Promise<ConfigFileView> {
  return await client.request(`/v1/config/file?path=${encodeURIComponent(path)}`, ConfigFileViewSchema);
}

/** Write one file against the digest it was edited from; refused unless it checks. */
export async function writeConfigFile(
  client: ConfigFilesClient,
  path: string,
  text: string,
  etag: string,
): Promise<ConfigFilePutResult> {
  return await client.request('/v1/config/file', ConfigFilePutResultSchema, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', [CONFIG_IF_MATCH_HEADER]: etag },
    body: JSON.stringify({ path, text }),
  });
}

/** Put ONE held edit into effect, named by the digest the owner reviewed. */
export async function confirmConfigChange(
  client: ConfigFilesClient,
  path: string,
  etag: string,
): Promise<ConfigConfirmResult> {
  return await client.request('/v1/config/confirm', ConfigConfirmResultSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, etag }),
  });
}

/** What an error says, as one sentence — or that the machine did not answer. */
export const reasonOf = (cause: unknown): string => {
  const message = cause instanceof Error ? cause.message.trim() : '';
  return message === '' ? 'This machine did not answer.' : message;
};

/** What a confirm says when the edit it named is no longer the one waiting. */
export const STALE_CONFIRM =
  'That edit is no longer the one waiting — the file changed since. Review it again before confirming.';

/**
 * Confirm one held edit from wherever it was made and say what happened, never throwing: `null` is
 * "confirmed", a sentence is why it was not. Confirming from another device asks for a passkey for
 * that act alone; the client pool raises that prompt and sends the confirmation once more, so the
 * caller never sees it.
 */
export async function confirmHeld(
  createClient: (connection: DaemonConnection) => Promise<ConfigFilesClient>,
  connection: DaemonConnection,
  pending: Pick<ConfigPending, 'path' | 'etag'>,
): Promise<string | null> {
  try {
    const result = await confirmConfigChange(await createClient(connection), pending.path, pending.etag);
    return result.confirmed ? null : STALE_CONFIRM;
  } catch (cause) {
    return reasonOf(cause);
  }
}

/**
 * The located issues a `422 config_invalid` refusal carries, or `undefined` when the error is anything
 * else, in which case only its sentence is shown.
 */
export const configInvalidBody = (error: unknown): ConfigInvalidBody | undefined => {
  const parsed = ConfigInvalidBodySchema.safeParse(error instanceof FyHttpError ? error.body : undefined);
  return parsed.success ? parsed.data : undefined;
};

/** The daemon's refusal code on an error, when it gave one. */
export const configErrorCode = (error: unknown): string | undefined => {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};
