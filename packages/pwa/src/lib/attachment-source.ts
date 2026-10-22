/**
 * Fetching one attachment's bytes from the daemon that owns them.
 *
 * The original (`ui/src/lib/api.ts`) had a page-global `api.attachment(
 * sessionId, attachmentId)`. Attachment ids are daemon-local, so with two
 * pairings the same pair of ids names two different files — the read has to
 * carry its daemon or it is a coin flip.
 */

import { AttachmentDownloadSchema } from '@ferretry/protocol';
import { attachmentApiPath, normalizeAttachmentMime } from './attachments.ts';
import type { DaemonConnection } from './daemon-connection.ts';
import type { DaemonSessionScope } from './daemon-scope.ts';
import { daemonRequest } from './daemon-transport.ts';
import { browserFetch, type DaemonFetch, DaemonResponseError } from './runtime-models.ts';

const failure = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

const base64Bytes = (base64: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

/**
 * Reads an attachment as a typed blob from the daemon that owns the session.
 *
 * The download route answers JSON — `{ attachment, base64 }` (`AttachmentDownloadSchema`) — never raw
 * bytes, because the same request must survive a relay or tunnel whose `res` record carries TEXT. So
 * the blob is built HERE, from the base64 and the attachment's own mime: reading `response.blob()`
 * would hand back an `application/json` blob that no `<img>` can paint, on every carrier alike.
 */
export const loadAttachmentBlob = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  attachmentId: string,
  signal?: AbortSignal,
  fetcher: DaemonFetch = browserFetch,
): Promise<Blob> => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('attachment scope must belong to the requested daemon');
  const target = daemonRequest(daemon, attachmentApiPath(scope.sessionId, attachmentId), { signal });
  const response = await fetcher(target.url, target.init);
  if (!response.ok) throw await failure(response);
  const parsed = AttachmentDownloadSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new DaemonResponseError(502, 'the daemon answered the download with no attachment');
  try {
    return new Blob([base64Bytes(parsed.data.base64)], {
      type: normalizeAttachmentMime(parsed.data.attachment.mime) || 'application/octet-stream',
    });
  } catch {
    throw new DaemonResponseError(502, 'the daemon answered the download with unreadable bytes');
  }
};
