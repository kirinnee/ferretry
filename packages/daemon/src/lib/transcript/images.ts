/**
 * WHICH IMAGES A TRANSCRIPT EVENT HOLDS, IN ORDER — the one owner of that question.
 *
 * Two programs must agree on "image number N of this record": the log renderer, which prints
 * `[fy-image <handle> <type>]` where an image was, and the image route, which resolves that handle back
 * to bytes (`@ferretry/protocol`'s `transcript-images.ts` owns the handle and marker spelling). If each
 * walked events on its own idea of what counts, a handle the renderer printed could name a different
 * image — or none — when the route re-parsed the record. Both call {@link recordImages}.
 *
 * AN IMAGE COUNTS ONLY WHEN IT HAS BYTES TO SERVE: inline base64 (`data`), a byte range of a record too
 * large to hold (`dataRef`, `large-strings.ts`), or a `data:` URL. An image the transcript only links to
 * (`https://…`) is not addressable and stays the word it always was.
 *
 * NOTHING HERE DECODES OR COPIES A PAYLOAD. The renderer calls this for every event of a tail, so it
 * reads shapes and keeps references — a megabyte `data:` URL is sliced (a view in V8), never rebuilt.
 */
import {
  isTranscriptImageMediaType,
  MAX_TRANSCRIPT_IMAGE_ORDINAL,
  MAX_TRANSCRIPT_IMAGE_RECORD_BYTES,
  type TranscriptImageHandle,
  type TranscriptImageMediaType,
} from '@ferretry/protocol';
import type { TranscriptBytesRef, TranscriptEvent, TranscriptJsonValue } from './types.ts';

/** One image an event holds: where its base64 is, and what the transcript CLAIMED it is. */
export interface EventImage {
  /** What the transcript declared. A hint a model wrote, never proof: the route sniffs the bytes. */
  readonly mediaType?: string;
  /** The base64 text, standard or URL-safe alphabet, padded or not. */
  readonly data?: string;
  /** Where the base64 sits in the transcript file, when the record was too large to hold it. */
  readonly dataRef?: TranscriptBytesRef;
  readonly alt?: string;
}

/** An {@link EventImage} with the handle that names it. */
export interface RecordImage extends EventImage {
  readonly handle: TranscriptImageHandle;
}

/** How deep a tool result's content is searched for image blocks. Real shapes are one or two deep. */
const MAX_CONTENT_DEPTH = 3;
const IMAGE_BLOCK_TYPES: ReadonlySet<string> = new Set(['image', 'input_image', 'output_image']);
const DATA_URL_HEAD = /^data:([^;,]*)((?:;[^;,]*)*),/u;

type JsonObject = { readonly [key: string]: TranscriptJsonValue };

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonBlank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const bytesRef = (value: unknown): TranscriptBytesRef | undefined => {
  if (!isObject(value)) return undefined;
  const { byteOffset, byteLength } = value;
  if (typeof byteOffset !== 'number' || typeof byteLength !== 'number') return undefined;
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) return undefined;
  if (!Number.isSafeInteger(byteLength) || byteLength < 1) return undefined;
  return { byteOffset, byteLength };
};

/** The base64 payload of a `data:` URL, or `undefined` for any other text — including a non-base64 one. */
function dataUrlImage(url: string): { readonly mediaType?: string; readonly data: string } | undefined {
  if (!url.startsWith('data:')) return undefined;
  // The header is short by construction; only it is examined, never the payload.
  const head = DATA_URL_HEAD.exec(url.slice(0, 256));
  if (head === null) return undefined;
  const parameters = (head[2] ?? '').split(';');
  if (!parameters.includes('base64')) return undefined;
  const data = url.slice(head[0].length);
  if (!nonBlank(data)) return undefined;
  const mediaType = (head[1] ?? '').trim().toLowerCase();
  return mediaType === '' ? { data } : { mediaType, data };
}

/** An image block as a harness wrote it into a tool result, when it holds bytes. */
function blockImage(block: JsonObject): EventImage | undefined {
  const source = isObject(block.source) ? block.source : {};
  const mediaType = [block.media_type, block.mediaType, block.mime_type, block.mimeType, source.media_type]
    .concat([source.mediaType, source.mime_type, source.mimeType])
    .find(nonBlank);
  const alt = [block.name, block.filename, source.name].find(nonBlank);
  const labelled = (image: EventImage): EventImage => ({
    ...image,
    ...(alt === undefined ? {} : { alt }),
  });

  const dataRef = bytesRef(block.dataRef) ?? bytesRef(source.dataRef);
  if (dataRef !== undefined) return labelled({ ...(mediaType === undefined ? {} : { mediaType }), dataRef });

  const data = [block.data, source.data].find(nonBlank);
  if (data !== undefined) return labelled({ ...(mediaType === undefined ? {} : { mediaType }), data });

  const urlValue = block.image_url ?? block.url ?? source.url ?? source.uri;
  const url = isObject(urlValue) ? urlValue.url : urlValue;
  const fromUrl = typeof url === 'string' ? dataUrlImage(url) : undefined;
  if (fromUrl === undefined) return undefined;
  const declared = mediaType ?? fromUrl.mediaType;
  return labelled({ ...(declared === undefined ? {} : { mediaType: declared }), data: fromUrl.data });
}

function contentImages(content: TranscriptJsonValue, depth: number, found: EventImage[]): void {
  if (depth > MAX_CONTENT_DEPTH) return;
  if (Array.isArray(content)) {
    for (const item of content) contentImages(item, depth + 1, found);
    return;
  }
  if (!isObject(content)) return;
  if (typeof content.type === 'string' && IMAGE_BLOCK_TYPES.has(content.type)) {
    const image = blockImage(content);
    if (image !== undefined) found.push(image);
    return;
  }
  // A result wrapper (`{ content: [...] }`, an MCP `{ Ok: { content } }`) is looked through, not dumped.
  for (const key of ['content', 'Ok', 'result', 'output'] as const) {
    const inner = content[key];
    if (inner !== undefined) contentImages(inner, depth + 1, found);
  }
}

/** The images one event holds, in the order they appear. Total: an event that holds none answers `[]`. */
export function eventImages(event: TranscriptEvent): readonly EventImage[] {
  if (event.kind === 'attachment') {
    const attachment = event.attachment;
    if (attachment.kind !== 'image') return [];
    const mediaType = nonBlank(attachment.mediaType) ? attachment.mediaType : undefined;
    const alt = nonBlank(attachment.name) ? attachment.name : undefined;
    const base = { ...(mediaType === undefined ? {} : { mediaType }), ...(alt === undefined ? {} : { alt }) };
    if (attachment.dataRef !== undefined) {
      const dataRef = bytesRef(attachment.dataRef);
      return dataRef === undefined ? [] : [{ ...base, dataRef }];
    }
    if (nonBlank(attachment.data)) return [{ ...base, data: attachment.data }];
    const fromUrl = nonBlank(attachment.uri) ? dataUrlImage(attachment.uri) : undefined;
    if (fromUrl === undefined) return [];
    const declared = mediaType ?? fromUrl.mediaType;
    return [{ ...base, ...(declared === undefined ? {} : { mediaType: declared }), data: fromUrl.data }];
  }
  if (event.kind === 'tool-result') {
    const found: EventImage[] = [];
    contentImages(event.result.content, 0, found);
    return found;
  }
  return [];
}

const handleable = (byteOffset: number | undefined, byteLength: number | undefined): boolean =>
  byteOffset !== undefined &&
  byteLength !== undefined &&
  Number.isSafeInteger(byteOffset) &&
  byteOffset >= 0 &&
  Number.isSafeInteger(byteLength) &&
  byteLength >= 1 &&
  byteLength <= MAX_TRANSCRIPT_IMAGE_RECORD_BYTES &&
  Number.isSafeInteger(byteOffset + byteLength);

/**
 * Every event's images, named, aligned with `events` (`result[i]` is event `i`'s).
 *
 * The ordinal counts per RECORD: events of one record share its `byteOffset` and `byteLength`, so the
 * Nth image across them in event order is image N of that record. An event without record metadata gets
 * no handle — there is no record to name — and an ordinal past the protocol's ceiling gets none either.
 *
 * `events` must hold every image-bearing event of each record it covers, from the record's first event:
 * a window that begins inside a record would number its first image 0 and name the wrong one.
 * `partialFirstRecord` says the window may have been cut that way, and its first record is left unnamed.
 */
export function numberRecordImages(
  events: readonly TranscriptEvent[],
  options: { readonly partialFirstRecord?: boolean } = {},
): readonly (readonly RecordImage[])[] {
  const counters = new Map<string, number>();
  const first = events[0];
  const skipped =
    options.partialFirstRecord === true && first !== undefined ? `${first.byteOffset}:${first.byteLength}` : undefined;
  return events.map(event => {
    const images = eventImages(event);
    if (images.length === 0 || !handleable(event.byteOffset, event.byteLength)) return [];
    const recordOffset = event.byteOffset as number;
    const recordLength = event.byteLength as number;
    const key = `${recordOffset}:${recordLength}`;
    if (key === skipped) return [];
    let ordinal = counters.get(key) ?? 0;
    const named: RecordImage[] = [];
    for (const image of images) {
      if (ordinal <= MAX_TRANSCRIPT_IMAGE_ORDINAL)
        named.push({ ...image, handle: { recordOffset, recordLength, ordinal } });
      ordinal += 1;
    }
    counters.set(key, ordinal);
    return named;
  });
}

/** The named images of `events`, flat and in order. */
export const recordImages = (
  events: readonly TranscriptEvent[],
  options: { readonly partialFirstRecord?: boolean } = {},
): readonly RecordImage[] => numberRecordImages(events, options).flat();

/** What a marker says the type is: the declared type when it is one a chat paints, otherwise nothing. */
export const markerMediaType = (image: EventImage): TranscriptImageMediaType | undefined => {
  const declared = image.mediaType?.toLowerCase();
  return isTranscriptImageMediaType(declared) ? declared : undefined;
};
