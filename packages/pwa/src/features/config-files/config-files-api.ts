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
  type ConfigStatusView,
  ConfigStatusViewSchema,
  type IFyApiClient,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';

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
