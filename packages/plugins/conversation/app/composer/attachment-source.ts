/**
 * Fetching one attachment's bytes from the daemon that owns them.
 *
 * Attachment ids are daemon-local, so with two pairings the same pair of ids names two different files — the read
 * goes through the client of the daemon that owns the ferret, never a page-global one.
 */

import { AttachmentDownloadSchema } from '../../contract/index.ts';
import { normalizeAttachmentMime } from './attachments.ts';
import { type ConversationCaller, DaemonCallError, type DaemonFerretScope } from './seam.ts';
import { assertClientDaemon } from './seam-attachments.ts';

const base64Bytes = (base64: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

/**
 * Reads an attachment as a typed blob from the daemon that owns the ferret.
 *
 * The download route answers JSON — `{ attachment, base64 }` (`AttachmentDownloadSchema`) — never raw
 * bytes, because the same request must survive a relay or tunnel whose `res` record carries TEXT. So
 * the blob is built HERE, from the base64 and the attachment's own mime: an `application/json` blob
 * is something no `<img>` can paint, on every carrier alike.
 */
export const loadAttachmentBlob = async (
  client: ConversationCaller,
  scope: DaemonFerretScope,
  attachmentId: string,
  signal?: AbortSignal,
): Promise<Blob> => {
  signal?.throwIfAborted();
  assertClientDaemon(client, scope, 'attachment');
  const answer = await client.call('GET /v1/ferrets/:ferretId/attachments/:attachmentId', {
    params: { ferretId: scope.ferretId, attachmentId },
  });
  signal?.throwIfAborted();
  const parsed = AttachmentDownloadSchema.safeParse(answer);
  if (!parsed.success) throw new DaemonCallError(502, '', 'the daemon answered the download with no attachment');
  try {
    return new Blob([base64Bytes(parsed.data.base64)], {
      type: normalizeAttachmentMime(parsed.data.attachment.mime) || 'application/octet-stream',
    });
  } catch {
    throw new DaemonCallError(502, '', 'the daemon answered the download with unreadable bytes');
  }
};
