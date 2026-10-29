/**
 * Fetching one transcript image's bytes from the daemon that owns the session.
 *
 * The chat names an image by the HANDLE its log line carries (`@ferretry/protocol`
 * `transcript-images.ts`); this reads it back. The answer is JSON — `{ image, base64 }` — because every
 * carrier crosses a tunnel whose answer body is text, so the Blob is built HERE from the base64 and the
 * type the daemon read from the bytes themselves. A transcript image can be megabytes, so the decode runs
 * in bounded slices and yields between them: one `atob` over a whole screenshot would hold the main thread.
 */

import {
  formatTranscriptImageHandle,
  parseTranscriptImageHandle,
  type TranscriptImageHandle,
  TranscriptImageDownloadSchema,
  transcriptImagePath,
} from '@ferretry/protocol';
import type { DaemonConnection } from './daemon-connection.ts';
import { daemonRequest } from './daemon-transport.ts';
import { browserFetch, type DaemonFetch, DaemonResponseError } from './runtime-models.ts';

/** Base64 characters decoded per slice. A multiple of 4, so every slice but the last is whole quanta. */
export const TRANSCRIPT_IMAGE_DECODE_SLICE = 256 * 1024;

const CACHE_ID_PREFIX = 'transcript-image:';

/** The attachment-shaped id a transcript image takes in the gallery's cache, which can never equal a stored attachment's. */
export const transcriptImageCacheId = (handle: string): string => `${CACHE_ID_PREFIX}${handle}`;

/** The handle a cache id spells, or `undefined` for anything that is not a transcript image's. */
export const transcriptImageHandleOf = (cacheId: string): TranscriptImageHandle | undefined =>
  cacheId.startsWith(CACHE_ID_PREFIX) ? parseTranscriptImageHandle(cacheId.slice(CACHE_ID_PREFIX.length)) : undefined;

const failure = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

/** Gives the event loop a turn, so input and paint run between two slices of a big decode. */
const yieldToEventLoop = (): Promise<void> => new Promise(done => setTimeout(done, 0));

/**
 * The bytes of `base64` as the parts of a Blob, decoded one slice at a time. Padding is only legal on
 * the last quantum, which is why a length that is not a whole number of quanta is refused outright.
 */
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
 * Reads one transcript image as a typed Blob from the daemon that owns the session.
 *
 * A 404 means the record is no longer in the transcript, a 415 that its bytes are not an image the chat
 * paints; any other failure surfaces as it came. The Blob's type is the daemon's SNIFFED one, never the
 * transcript's claim.
 */
export const loadTranscriptImageBlob = async (
  daemon: DaemonConnection,
  sessionId: string,
  handle: TranscriptImageHandle,
  signal?: AbortSignal,
  fetcher: DaemonFetch = browserFetch,
): Promise<Blob> => {
  const target = daemonRequest(daemon, transcriptImagePath(sessionId, handle), { signal });
  const response = await fetcher(target.url, target.init);
  if (!response.ok) throw await failure(response);
  const parsed = TranscriptImageDownloadSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success || parsed.data.image.handle !== formatTranscriptImageHandle(handle))
    throw new DaemonResponseError(502, 'the daemon answered the read with no image');
  let parts: Uint8Array<ArrayBuffer>[];
  try {
    parts = await decodeBase64(parsed.data.base64, signal);
  } catch (error) {
    if (signal?.aborted === true) throw error;
    throw new DaemonResponseError(502, 'the daemon answered the read with unreadable bytes');
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
