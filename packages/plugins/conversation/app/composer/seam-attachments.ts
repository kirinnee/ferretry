/**
 * THE ATTACHMENTS' AND MENUS' STAND-INS: names the attachment gallery and the reference menus take from files other
 * porters own, copied here (today's code, renamed to the words) until those files land, so each is replaced by an
 * import in one place.
 *
 *   - loadTranscriptImageBlob, transcriptImageCacheId, transcriptImageHandleOf, transcriptImageErrorMessage
 *       ....... GAP(C3): copies of today's `lib/transcript-image-source.ts` (C3's `chat/transcript-image-source.ts`)
 */

import {
  formatTranscriptImageHandle,
  parseTranscriptImageHandle,
  TranscriptImageDownloadSchema,
  type TranscriptImageHandle,
} from '../../contract/index.ts';
import { daemonOfClient } from '@ferretry/app';
import { type ConversationCaller, DaemonCallError } from './seam.ts';

// ─── transcript images (copy of today's lib/transcript-image-source.ts) ───────────────────────────────────────────

/** Base64 characters decoded per slice. A multiple of 4, so every slice but the last is whole quanta. */
const TRANSCRIPT_IMAGE_DECODE_SLICE = 256 * 1024;

const CACHE_ID_PREFIX = 'transcript-image:';

/** The attachment-shaped id a transcript image takes in the gallery's cache, which can never equal a stored attachment's. */
export const transcriptImageCacheId = (handle: string): string => `${CACHE_ID_PREFIX}${handle}`;

/** The handle a cache id spells, or `undefined` for anything that is not a transcript image's. */
export const transcriptImageHandleOf = (cacheId: string): TranscriptImageHandle | undefined =>
  cacheId.startsWith(CACHE_ID_PREFIX) ? parseTranscriptImageHandle(cacheId.slice(CACHE_ID_PREFIX.length)) : undefined;

/** Gives the event loop a turn, so input and paint run between two slices of a big decode. */
const yieldToEventLoop = (): Promise<void> => new Promise(done => setTimeout(done, 0));

const decodeBase64 = async (base64: string, signal: AbortSignal | undefined): Promise<Uint8Array<ArrayBuffer>[]> => {
  if (base64.length % 4 !== 0) throw new Error('base64 length is not a whole number of quanta');
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (let start = 0; start < base64.length; start += TRANSCRIPT_IMAGE_DECODE_SLICE) {
    signal?.throwIfAborted();
    const binary = atob(base64.slice(start, start + TRANSCRIPT_IMAGE_DECODE_SLICE));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    parts.push(bytes);
    if (start + TRANSCRIPT_IMAGE_DECODE_SLICE < base64.length) await yieldToEventLoop();
  }
  signal?.throwIfAborted();
  return parts;
};

/**
 * Reads one transcript image as a typed Blob from the daemon that owns the ferret. A 404 means the record is no
 * longer in the transcript, a 415 that its bytes are not an image the chat paints. The Blob's type is the daemon's
 * SNIFFED one, never the transcript's claim.
 */
export const loadTranscriptImageBlob = async (
  client: ConversationCaller,
  ferretId: string,
  handle: TranscriptImageHandle,
  signal?: AbortSignal,
): Promise<Blob> => {
  const answer = await client.call('GET /v1/ferrets/:ferretId/transcript-images/:handle', {
    params: { ferretId, handle: formatTranscriptImageHandle(handle) },
  });
  const parsed = TranscriptImageDownloadSchema.safeParse(answer);
  if (!parsed.success || parsed.data.image.handle !== formatTranscriptImageHandle(handle))
    throw new DaemonCallError(502, '', 'the daemon answered the read with no image');
  let parts: Uint8Array<ArrayBuffer>[];
  try {
    parts = await decodeBase64(parsed.data.base64, signal);
  } catch (error) {
    if (signal?.aborted === true) throw error;
    throw new DaemonCallError(502, '', 'the daemon answered the read with unreadable bytes');
  }
  return new Blob(parts, { type: parsed.data.image.mediaType });
};

/** Why an image is not on screen, in words a reader can act on. Never echoes a daemon path or message. */
export const transcriptImageErrorMessage = (error: unknown): string => {
  const status =
    error !== null && typeof error === 'object' ? (error as { readonly status?: unknown }).status : undefined;
  if (status === 404) return 'no longer in the transcript';
  if (status === 415) return 'not a supported image';
  return 'could not be loaded';
};

// ─── the daemon a scope belongs to ────────────────────────────────────────────────────────────────────────────────

/**
 * A read or upload goes through ONE daemon's client; a scope naming another daemon is a caller bug that would put a
 * file on (or read it from) the wrong machine, so it is refused before anything is sent. A client the shell did not
 * make (a suite's fake) names no daemon and is trusted with its scope.
 */
export const assertClientDaemon = (client: object, scope: { readonly daemonId: string }, what: string): void => {
  const owner = daemonOfClient(client);
  if (owner !== undefined && owner !== scope.daemonId)
    throw new Error(`${what} scope must belong to the requested daemon`);
};
