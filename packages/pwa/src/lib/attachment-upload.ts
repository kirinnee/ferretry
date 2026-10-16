/**
 * Putting one file the reader chose onto the daemon that owns the session, so a send can name it.
 *
 * The route takes the bytes INLINE as base64 in a JSON body (`AttachmentUploadRequestSchema`): the
 * daemon's transport is JSON end to end, and the same request travels a relay unchanged. The answer
 * is the daemon's own `AttachmentView`, validated before anything trusts its id — an id is what the
 * send names, and an unvalidated one would be a send naming nothing.
 *
 * A refusal is surfaced through `attachmentErrorMessage`, which owns the copy and refuses to echo a
 * daemon path back into the page.
 */

import { type AttachmentView, AttachmentViewSchema } from '@ferretry/protocol';
import { normalizeAttachmentMime } from './attachments.ts';
import type { DaemonConnection } from './daemon-connection.ts';
import type { DaemonSessionScope } from './daemon-scope.ts';
import { daemonRequest } from './daemon-transport.ts';
import { browserFetch, type DaemonFetch, DaemonResponseError } from './runtime-models.ts';

/** Bytes to base64 in bounded chunks: a spread of a 20 MiB array would overflow the call stack. */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(binary);
};

/** A refused upload, restated with the daemon's own sentence and code when it sent them. */
const refusal = (status: number, payload: unknown): DaemonResponseError => {
  const error = payload as { readonly error?: unknown; readonly code?: unknown } | null;
  return new DaemonResponseError(
    status,
    typeof error?.error === 'string' ? error.error : `HTTP ${status}`,
    typeof error?.code === 'string' ? error.code : undefined,
  );
};

/** The file as the route reads it: a name, a declared type, and the bytes. */
export type UploadableFile = Pick<File, 'name' | 'type' | 'arrayBuffer'>;

export const uploadAttachment = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  file: UploadableFile,
  fetcher: DaemonFetch = browserFetch,
): Promise<AttachmentView> => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('attachment scope must belong to the requested daemon');
  const body = JSON.stringify({
    filename: file.name,
    mime: normalizeAttachmentMime(file.type) || 'application/octet-stream',
    base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
  });
  const target = daemonRequest(daemon, `/v1/sessions/${encodeURIComponent(scope.sessionId)}/attachments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const response = await fetcher(target.url, target.init);
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) throw refusal(response.status, payload);
  const parsed = AttachmentViewSchema.safeParse(payload);
  if (!parsed.success) throw new DaemonResponseError(502, 'the daemon answered the upload with no attachment');
  return parsed.data;
};
