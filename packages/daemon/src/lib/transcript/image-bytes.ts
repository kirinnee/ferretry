/**
 * WHAT A TRANSCRIPT'S IMAGE BYTES REALLY ARE, found without decoding them.
 *
 * A transcript is written by a model and its tools, so its claims about an image — the media type it
 * names, the base64 it holds — are claims. This module reads the base64 itself and answers three things
 * the image route serves: whether it is base64 at all, how many bytes it decodes to, and what the first
 * bytes say it is (a PNG, JPEG, GIF or WebP by magic number). The transcript's `media_type` is never
 * consulted: a `text/html` payload labelled `image/png` is refused, and a PNG labelled `image/jpeg` is
 * served as the PNG it is.
 *
 * NOTHING DECODES THE WHOLE IMAGE. A screenshot is megabytes; decoding it would allocate it a third
 * time on the daemon's one thread, for a client that decodes it again. Length comes from the base64's
 * length and padding, the type from the first sixteen characters, and the only full pass is the
 * character check — a table lookup, run in slices with a yield between them (`LOOP` pacing, as
 * `sliced.ts`), so a multi-megabyte record never holds the event loop past its budget.
 */
import type { TranscriptImageMediaType } from '@ferretry/protocol/transcript-images';

/** Characters checked per slice before the loop is given back. 512 KiB is well under a millisecond. */
const SLICE_BYTES = 512 * 1024;
/** The fewest base64 characters that can carry any magic number below (a WebP's twelve bytes). */
const SNIFF_CHARS = 16;

const PAD = 0x3d;
const PLUS = 0x2b;
const SLASH = 0x2f;
const DASH = 0x2d;
const UNDERSCORE = 0x5f;

/** 1 for the standard alphabet, 2 for the URL-safe two, 0 for anything that is not base64. */
const ALPHABET = ((): Uint8Array => {
  const table = new Uint8Array(256);
  const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let index = 0; index < standard.length; index += 1) table[standard.charCodeAt(index)] = 1;
  table[DASH] = 2;
  table[UNDERSCORE] = 2;
  return table;
})();

const yieldToLoop = async (): Promise<void> => await new Promise<void>(resolve => setImmediate(resolve));

/** The image type `head` (the first decoded bytes) is, by its magic number. */
export function sniffImageType(head: Uint8Array): TranscriptImageMediaType | undefined {
  const at = (index: number): number => head[index] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a)
    return at(6) === 0x1a && at(7) === 0x0a ? 'image/png' : undefined;
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38 && (at(4) === 0x37 || at(4) === 0x39))
    return at(5) === 0x61 ? 'image/gif' : undefined;
  if (
    at(0) === 0x52 && // R
    at(1) === 0x49 && // I
    at(2) === 0x46 && // F
    at(3) === 0x46 && // F
    at(8) === 0x57 && // W
    at(9) === 0x45 && // E
    at(10) === 0x42 && // B
    at(11) === 0x50 // P
  )
    return 'image/webp';
  return undefined;
}

/** `text` as bytes when every code unit is ASCII, otherwise `undefined`: no base64 holds anything else. */
function asciiBytes(text: string): Uint8Array | undefined {
  // The native UTF-8 length equals the UTF-16 length exactly when every unit is below 0x80.
  if (Buffer.byteLength(text, 'utf8') !== text.length) return undefined;
  return Buffer.from(text, 'latin1');
}

/** An image proved to be one: its type from its bytes, its decoded size, and its base64 spelled the standard way. */
export interface InspectedImage {
  readonly mediaType: TranscriptImageMediaType;
  readonly byteLength: number;
  /** Standard alphabet, padded: what a browser's `atob` and a `data:` URL both accept. */
  readonly base64: string;
}

/**
 * The image `source` holds, or `undefined` when it is not base64 of a PNG, JPEG, GIF or WebP.
 *
 * Accepts the standard and URL-safe alphabets, padded or not, and answers the standard padded one. A
 * space, a newline, a `=` anywhere but the end, or a length no base64 has all refuse: the route serves
 * what it can prove, not what a lenient decoder would forgive.
 */
export async function inspectImageBase64(source: string | Uint8Array): Promise<InspectedImage | undefined> {
  const bytes = typeof source === 'string' ? asciiBytes(source) : source;
  if (bytes === undefined) return undefined;

  const padStart = bytes.indexOf(PAD);
  const dataLength = padStart < 0 ? bytes.byteLength : padStart;
  const padding = bytes.byteLength - dataLength;
  if (padding > 2 || dataLength < SNIFF_CHARS || dataLength % 4 === 1) return undefined;
  if (padding > 0 && bytes.byteLength % 4 !== 0) return undefined;
  for (let index = dataLength; index < bytes.byteLength; index += 1) if (bytes[index] !== PAD) return undefined;

  let urlSafe = false;
  for (let from = 0; from < dataLength; from += SLICE_BYTES) {
    const to = Math.min(dataLength, from + SLICE_BYTES);
    for (let index = from; index < to; index += 1) {
      const kind = ALPHABET[bytes[index] as number];
      if (kind === 0) return undefined;
      if (kind === 2) urlSafe = true;
    }
    if (to < dataLength) await yieldToLoop();
  }

  const head = Buffer.from(Buffer.from(bytes.subarray(0, SNIFF_CHARS)).toString('latin1'), 'base64');
  const mediaType = sniffImageType(head);
  if (mediaType === undefined) return undefined;

  let standard = bytes;
  if (urlSafe) {
    const copy = Buffer.from(bytes.subarray(0, dataLength));
    for (let from = 0; from < copy.byteLength; from += SLICE_BYTES) {
      const to = Math.min(copy.byteLength, from + SLICE_BYTES);
      for (let index = from; index < to; index += 1) {
        const byte = copy[index];
        if (byte === DASH) copy[index] = PLUS;
        else if (byte === UNDERSCORE) copy[index] = SLASH;
      }
      if (to < copy.byteLength) await yieldToLoop();
    }
    standard = copy;
  }
  const text = Buffer.from(standard.buffer, standard.byteOffset, Math.min(standard.byteLength, dataLength)).toString(
    'latin1',
  );
  const missing = (4 - (dataLength % 4)) % 4;
  return {
    mediaType,
    byteLength: Math.floor((dataLength * 3) / 4),
    base64: missing === 0 ? text : `${text}${'='.repeat(missing)}`,
  };
}
