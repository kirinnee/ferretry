/**
 * Putting one file the reader chose onto the daemon that owns the ferret, so a send can name it.
 *
 * The route takes the bytes INLINE as base64 in a JSON body (`AttachmentUploadRequestSchema`): the
 * daemon's transport is JSON end to end, and the same request travels a relay unchanged. The answer
 * is the daemon's own `AttachmentView`, validated before anything trusts its id — an id is what the
 * send names, and an unvalidated one would be a send naming nothing.
 *
 * A refusal is surfaced through `attachmentErrorMessage`, which owns the copy and refuses to echo a
 * daemon path back into the page.
 */

import { type AttachmentView, AttachmentViewSchema } from '../../contract/index.ts';
import { normalizeAttachmentMime } from './attachments.ts';
import { type ConversationCaller, DaemonCallError, type DaemonFerretScope } from './seam.ts';
import { assertClientDaemon } from './seam-attachments.ts';

/** Bytes to base64 in bounded chunks: a spread of a 20 MiB array would overflow the call stack. */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(binary);
};

/** The file as the route reads it: a name, a declared type, and the bytes. */
export type UploadableFile = Pick<File, 'name' | 'type' | 'arrayBuffer'>;

/** `POST /v1/ferrets/:ferretId/attachments` on the daemon whose client this is. A refusal is the daemon's own. */
export const uploadAttachment = async (
  client: ConversationCaller,
  scope: DaemonFerretScope,
  file: UploadableFile,
): Promise<AttachmentView> => {
  assertClientDaemon(client, scope, 'attachment');
  const body = {
    filename: file.name,
    mime: normalizeAttachmentMime(file.type) || 'application/octet-stream',
    base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
  };
  const answer = await client.call('POST /v1/ferrets/:ferretId/attachments', {
    params: { ferretId: scope.ferretId },
    body,
  });
  const parsed = AttachmentViewSchema.safeParse(answer);
  if (!parsed.success) throw new DaemonCallError(502, '', 'the daemon answered the upload with no attachment');
  return parsed.data;
};
