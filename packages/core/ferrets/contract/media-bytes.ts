/**
 * THE MEDIA BYTE ROUTE'S RULES, with no I/O: which names it serves, as what, and which bytes a `Range` asks for.
 *
 * `GET /v1/ferrets/:ferretId/fs/media` serves one file of a ferret's MEDIA folder (`media:<file>` in an `fy-render`
 * block) as raw bytes, in pieces, so a clip or a song larger than the JSON read's 1 MiB ({@link MAX_FILE_BYTES}) can be
 * played. It is the same read as `fs/file?scope=media` (the same pinned walk, gates, fence and `filesystem` _use_ grant);
 * what is new is only how the bytes leave. The rules that make that safe are here so each one has a test:
 *
 *  - A NAME, never a path. The media folder is flat (`writeMedia` refuses anything else), so a request names one bare
 *    file and a `/`, a `\`, a NUL, `.` or `..` is refused before any walk starts ({@link bareMediaName}).
 *  - A FIXED SET OF TYPES. The `Content-Type` comes from the extension, from the table below and nowhere else; a name with
 *    no entry is refused, so the route cannot be made to serve a page or a script from the daemon's origin. SVG is not
 *    in the table: it is active content.
 *  - ONE RANGE, in bounded pieces ({@link MEDIA_CHUNK_BYTES}), so no answer is larger than one session can carry.
 *
 * WHY THIS IS CONTRACT. The daemon serves by these numbers and the app reads by them (a file over the JSON read's
 * mebibyte is fetched in pieces of {@link MEDIA_CHUNK_BYTES}, and one over {@link MAX_MEDIA_BYTES} is not asked for), so
 * one module owns them rather than two that must agree.
 */

import { ApiError, type ApiResponse, bytesResponse, jsonResponse } from '@ferretry/kernel/contract';

/** The largest media file this route serves. Past it the file is not served at all (the row says so), never cut. */
export const MAX_MEDIA_BYTES = 32 * 1024 * 1024;

/** The most one answer carries. A larger range, or an open one (`bytes=0-`), is answered with this much and a `206`. */
export const MEDIA_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Extension → `Content-Type`, the whole allowlist. The extensions are the ones `fy-render` admits for `image`, `video`,
 * `audio` and `pdf` (docs/fy-render.md); the types are the registered ones a browser's media element reads.
 */
export const MEDIA_TYPES: Readonly<Record<string, string>> = {
  aac: 'audio/aac',
  flac: 'audio/flac',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  m4a: 'audio/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  ogv: 'video/ogg',
  opus: 'audio/ogg',
  pdf: 'application/pdf',
  png: 'image/png',
  wav: 'audio/wav',
  weba: 'audio/webm',
  webm: 'video/webm',
  webp: 'image/webp',
};

/** The type a name is served as, from its last extension, or `undefined` when the allowlist has none. */
export function mediaTypeOf(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return undefined;
  const extension = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(MEDIA_TYPES, extension) ? MEDIA_TYPES[extension] : undefined;
}

/** A bare file name, or `undefined`: no separator, no NUL, not `.` or `..`, not empty, not absurdly long. */
export function bareMediaName(value: string | undefined): string | undefined {
  if (value === undefined || value === '' || value.length > 255) return undefined;
  if (/[/\\\0]/u.test(value) || value === '.' || value === '..') return undefined;
  return value;
}

/**
 * The answer for one file's bytes and a `Range` header: `200` for a file that fits one piece, `206` for a range of it,
 * `416` for a range that starts past the end, and `413 range_required` for a larger file asked for with no range. Every
 * one leaves with the headers that keep a served file data: `nosniff`, no framing, no script, same origin only.
 */
export function mediaAnswer(
  bytes: Uint8Array,
  type: string,
  rangeHeader: string | null | undefined,
  name: string,
): ApiResponse {
  const size = bytes.byteLength;
  const safe = {
    'accept-ranges': 'bytes',
    'content-security-policy': "default-src 'none'; sandbox",
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
  };
  const range = parseMediaRange(rangeHeader ?? undefined, size);
  if (range.kind === 'unsatisfiable')
    return jsonResponse({ error: 'the range starts past the end of the file', code: 'range_not_satisfiable' }, 416, {
      ...safe,
      'content-range': `bytes */${size}`,
    });
  if (range.kind === 'part')
    return bytesResponse(bytes.subarray(range.start, range.end + 1), type, 206, {
      ...safe,
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
    });
  if (size > MEDIA_CHUNK_BYTES)
    throw new ApiError(413, `${name} is read in ranges of at most ${MEDIA_CHUNK_BYTES} bytes`, 'range_required');
  return bytesResponse(bytes, type, 200, safe);
}

/** What a `Range` header asks for, decided against the file's size. */
export type MediaRange =
  /** No usable range: the whole file (the header was absent, malformed, in another unit, or named several ranges). */
  | { readonly kind: 'whole' }
  /** Inclusive byte positions, already clamped to the file and to {@link MEDIA_CHUNK_BYTES}. */
  | { readonly kind: 'part'; readonly start: number; readonly end: number }
  /** A range that starts past the end of the file (or asks for the last zero bytes): `416`. */
  | { readonly kind: 'unsatisfiable' };

const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/u;

/**
 * RFC 9110 §14 for the one shape this route honours: `bytes=<first>-<last>`, `bytes=<first>-` and `bytes=-<suffix>`.
 * A header this does not understand is IGNORED (the answer is then the whole file, which the route allows only when it
 * fits one piece), as the RFC permits; several ranges are ignored the same way, because this route never answers
 * `multipart/byteranges`. A well-formed range that cannot be satisfied is `416`.
 */
export function parseMediaRange(header: string | null | undefined, size: number): MediaRange {
  const match = typeof header === 'string' ? RANGE_PATTERN.exec(header.trim()) : null;
  if (match === null) return { kind: 'whole' };
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return { kind: 'whole' };
  const firstNumber = first === '' ? undefined : Number(first);
  const lastNumber = last === '' ? undefined : Number(last);
  if (
    (firstNumber !== undefined && !Number.isSafeInteger(firstNumber)) ||
    (lastNumber !== undefined && !Number.isSafeInteger(lastNumber))
  )
    return { kind: 'whole' };
  if (firstNumber === undefined) {
    // A suffix: the last `lastNumber` bytes. Zero of them, or any of an empty file, cannot be satisfied.
    const suffix = lastNumber as number;
    if (suffix === 0 || size === 0) return { kind: 'unsatisfiable' };
    const start = Math.max(size - suffix, 0);
    return { kind: 'part', start, end: Math.min(size - 1, start + MEDIA_CHUNK_BYTES - 1) };
  }
  // `last < first` is not a range at all (RFC 9110 §14.1.2): ignored, not unsatisfiable.
  if (lastNumber !== undefined && lastNumber < firstNumber) return { kind: 'whole' };
  if (firstNumber >= size) return { kind: 'unsatisfiable' };
  const end = Math.min(lastNumber ?? size - 1, size - 1, firstNumber + MEDIA_CHUNK_BYTES - 1);
  return { kind: 'part', start: firstNumber, end };
}
