/**
 * BIG BASE64 PAYLOADS ARE REFERENCED, NEVER MATERIALISED.
 *
 * A pasted screenshot is one transcript record of several megabytes, almost all of it one base64
 * string. Decoding that record and handing it to `JSON.parse` allocated the payload twice more on the
 * daemon's one thread, in one call, and on a machine short of memory every megabyte allocated there is
 * a wait: CI's memory-capped budget measured one 2.75 MB record holding the event loop past 200 ms, 85%
 * of it inside `JSON.parse`. And nothing the daemon reads a transcript for uses those bytes — the logs
 * render an attachment as its kind, the message rows carry text.
 *
 * So a complete record of at least {@link LARGE_RECORD_BYTES} is scanned as bytes first, and every string
 * literal of at least {@link LARGE_STRING_BYTES} that is pure base64 — no escape, so its bytes in the
 * file ARE its value — is replaced by a short placeholder naming where those bytes are. The parser sees
 * the placeholder; {@link resolveLargeStrings} then turns an attachment's placeholder into a byte range
 * (`dataRef`) and any other into a short note, so no placeholder ever leaves this module's callers.
 * The record's raw bytes — the transcript's evidence — are never touched.
 */
import type { TranscriptBytesRef } from './types.ts';

/** Records below this are parsed as they are: the scan would cost more than it saves. */
export const LARGE_RECORD_BYTES = 64 * 1024;
/** The smallest string literal worth referencing: a thumbnail, not an ordinary tool output. */
export const LARGE_STRING_BYTES = 32 * 1024;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
/** A NUL cannot occur unescaped in JSON, so no transcript string can start like a placeholder does. */
const PLACEHOLDER_PREFIX = '\u0000fy-bytes:';
const PLACEHOLDER_JSON_PREFIX = new TextEncoder().encode('\\u0000fy-bytes:');
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isBase64Byte(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    byte === 0x2b || // +
    byte === 0x2f || // /
    byte === 0x3d || // =
    byte === 0x2d || // - (base64url)
    byte === 0x5f // _ (base64url)
  );
}

function isPureBase64(bytes: Uint8Array, from: number, to: number): boolean {
  for (let index = from; index < to; index += 1) if (!isBase64Byte(bytes[index] as number)) return false;
  return true;
}

/** One cut: a base64 literal's contents become a placeholder, or an ignored value becomes `null`. */
interface Cut {
  readonly start: number;
  readonly end: number;
  readonly kind: 'reference' | 'null';
}

const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COLON = 0x3a;
const COMMA = 0x2c;
const NULL_JSON = encoder.encode('null');

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}

/**
 * Every cut `record` needs, in one pass.
 *
 * Outside a string, a quote can only open one, so the record is read literal by literal. The native
 * `indexOf` finds each literal, through two cursors that only move forward — the next quote and the
 * next backslash — so a record full of escapes is still read once. The bytes BETWEEN literals are
 * walked one by one; they are brackets, commas and numbers, which is how the nesting depth is known.
 *
 * A top-level key in `ignored` whose value is an object or an array has that value cut to `null`: the
 * parser declared it never reads it, so the tens of thousands of strings it may hold are never built.
 */
function cutsOf(record: Uint8Array, ignored: ReadonlySet<string>): readonly Cut[] {
  const cuts: Cut[] = [];
  let depth = 0;
  /** The last literal read, and the depth it was read at: a key, if a colon follows. */
  let lastLiteral: { readonly from: number; readonly to: number; readonly depth: number } | undefined;
  /** True between an ignored key's colon and its value's first byte. */
  let ignoreNext = false;
  /** Where the ignored value being skipped began, and the depth it closes back to. */
  let skipping: { readonly from: number; readonly depth: number } | undefined;
  const structure = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      const byte = record[index] as number;
      if (isWhitespace(byte) || byte === COMMA) continue;
      if (byte === COLON) {
        ignoreNext =
          skipping === undefined &&
          lastLiteral?.depth === 1 &&
          ignored.has(decoder.decode(record.subarray(lastLiteral.from, lastLiteral.to)));
        continue;
      }
      if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
        if (ignoreNext) skipping = { from: index, depth };
        depth += 1;
      } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
        depth -= 1;
        if (skipping !== undefined && depth === skipping.depth) {
          cuts.push({ start: skipping.from, end: index + 1, kind: 'null' });
          skipping = undefined;
        }
      }
      ignoreNext = false;
      lastLiteral = undefined;
    }
  };
  let position = 0;
  let quote = record.indexOf(QUOTE);
  let backslash = record.indexOf(BACKSLASH);
  const after = (cursor: number, byte: number, from: number): number =>
    cursor >= 0 && cursor < from ? record.indexOf(byte, from) : cursor;
  while (quote >= 0) {
    structure(position, quote);
    const from = quote + 1;
    let scan = from;
    let escaped = false;
    quote = after(quote, QUOTE, scan);
    backslash = after(backslash, BACKSLASH, scan);
    while (quote >= 0 && backslash >= 0 && backslash < quote) {
      escaped = true;
      scan = backslash + 2;
      quote = after(quote, QUOTE, scan);
      backslash = after(backslash, BACKSLASH, scan);
    }
    // A literal that never closes: the record is cut off, and parsing it will say so.
    if (quote < 0) return cuts.filter(cut => cut.kind === 'reference');
    ignoreNext = false;
    lastLiteral = { from, to: quote, depth };
    if (skipping === undefined && !escaped && quote - from >= LARGE_STRING_BYTES && isPureBase64(record, from, quote)) {
      cuts.push({ start: from, end: quote, kind: 'reference' });
    }
    position = quote + 1;
    quote = after(quote, QUOTE, position);
  }
  structure(position, record.byteLength);
  // An ignored value still open at the end is a record cut off: nothing of it is cut.
  return cuts;
}

/**
 * `record` lightened: each large base64 literal replaced by a placeholder for its bytes in the file, and
 * each top-level value under a key in `ignoredKeys` replaced by `null` — or `record` itself when
 * nothing applies. `recordByteOffset` is where the record starts in the transcript.
 */
export function referenceLargeStrings(
  record: Uint8Array,
  recordByteOffset: number,
  ignoredKeys: readonly string[] = [],
): Uint8Array {
  if (record.byteLength < LARGE_RECORD_BYTES) return record;
  const cuts = cutsOf(record, new Set(ignoredKeys));
  if (cuts.length === 0) return record;
  const pieces: Uint8Array[] = [];
  let from = 0;
  for (const cut of cuts) {
    pieces.push(record.subarray(from, cut.start));
    if (cut.kind === 'null') pieces.push(NULL_JSON);
    else {
      pieces.push(PLACEHOLDER_JSON_PREFIX);
      pieces.push(encoder.encode(`${String(recordByteOffset + cut.start)}:${String(cut.end - cut.start)}`));
    }
    from = cut.end;
  }
  pieces.push(record.subarray(from));
  const skeleton = new Uint8Array(pieces.reduce((total, piece) => total + piece.byteLength, 0));
  let at = 0;
  for (const piece of pieces) {
    skeleton.set(piece, at);
    at += piece.byteLength;
  }
  return skeleton;
}

/** The byte range a placeholder names, or `undefined` for any other value. */
export function placeholderRef(value: unknown): TranscriptBytesRef | undefined {
  if (typeof value !== 'string' || !value.startsWith(PLACEHOLDER_PREFIX)) return undefined;
  const [offset, length] = value.slice(PLACEHOLDER_PREFIX.length).split(':').map(Number);
  return { byteOffset: offset as number, byteLength: length as number };
}

/** What a referenced payload reads as anywhere but an attachment's `data`: a tool result's image block. */
function note(ref: TranscriptBytesRef): string {
  return `[base64 data: ${String(ref.byteLength)} bytes at byte ${String(ref.byteOffset)} of the transcript]`;
}

/**
 * `value` with every placeholder resolved: an object whose `data` is one becomes `dataRef` (an
 * attachment keeps where its payload is), any other becomes a short note. Objects and arrays are
 * rebuilt only along the paths that held one; everything else is returned as it was.
 */
export function resolveLargeStrings<Value>(value: Value): Value {
  const ref = placeholderRef(value);
  if (ref !== undefined) return note(ref) as Value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map(item => {
      const resolved = resolveLargeStrings(item);
      if (resolved !== item) changed = true;
      return resolved;
    });
    return (changed ? next : value) as Value;
  }
  if (typeof value !== 'object' || value === null) return value;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const dataRef = key === 'data' ? placeholderRef(item) : undefined;
    if (dataRef !== undefined) {
      next.dataRef = dataRef;
      changed = true;
      continue;
    }
    const resolved = resolveLargeStrings(item);
    if (resolved !== item) changed = true;
    next[key] = resolved;
  }
  return (changed ? next : value) as Value;
}
