/**
 * The remote browser's live stream, as the byte stream a §14 stream session carries.
 *
 * ## WHY A FRAME IS CUT INTO CHUNKS
 *
 * A browser frame is one JPEG with its page id in front (the daemon's `FYBF` envelope), and a desktop
 * viewport at the screencast's quality is routinely larger than the ~48 KiB of raw bytes one relay
 * record carries (`relayDataByteBudget`). §14 lets a stream carry a frame larger than a record only as
 * a BYTE STREAM — "a `bytes` record carries a run of an ordered byte stream … there is no reassembly,
 * no fragment marker" at the session layer — so the browser stream defines its own framing on top of
 * that byte stream, here, once, for both ends:
 *
 *   bytes 0..3    ASCII magic "FYBC" — Ferretry browser chunk
 *   byte  4       chunk format version 1
 *   bytes 5..8    frame serial, unsigned big-endian
 *   bytes 9..12   whole envelope length, unsigned big-endian
 *   bytes 13..16  this chunk's offset into the envelope, unsigned big-endian
 *   bytes 17..20  this chunk's payload length, unsigned big-endian
 *   remainder     that many envelope bytes
 *
 * Every chunk is self-delimiting, so a reader parses a byte stream and never relies on one record being
 * one chunk — a carrier may deliver the stream in any runs it likes.
 *
 * ## WHY A LOST CHUNK COSTS ONE FRAME AND NOTHING ELSE
 *
 * A daemon stream DROPS a backed-up binary frame whole (it answers `0`, "not taken") rather than queue
 * it, because a newer frame supersedes it. A dropped chunk therefore leaves a hole at a chunk boundary,
 * never inside one, and the reader sees the next chunk's offset disagree with what it has assembled.
 * It discards that partial frame and waits for the next offset-0 chunk, which the daemon sends when it
 * resends the newest picture under a new serial. The stream stays parseable throughout.
 */

/** ASCII "FYBC". */
export const BROWSER_STREAM_CHUNK_MAGIC: readonly number[] = [0x46, 0x59, 0x42, 0x43];
export const BROWSER_STREAM_CHUNK_VERSION = 1;
export const BROWSER_STREAM_CHUNK_HEADER_BYTES = 21;
/** The largest whole envelope a chunk may announce: an 8 MiB JPEG plus its page-id header. */
export const BROWSER_STREAM_MAX_ENVELOPE_BYTES = 8 * 1024 * 1024 + 1024;
/** The largest serial; the next one after it is 0 again. */
const MAX_SERIAL = 0xffff_ffff;

/**
 * One envelope as the chunks that carry it, each at most `recordBytes` long.
 *
 * Total on purpose: an envelope that is empty or over the ceiling, a serial that does not fit four
 * bytes, or a record too small for a header plus one byte yields NO chunks — the caller has nothing
 * it could honestly send — rather than a throw a frame path would have to remember to catch.
 */
export function encodeBrowserStreamChunks(
  serial: number,
  envelope: Uint8Array,
  recordBytes: number,
): readonly Uint8Array[] {
  const payloadBytes = Math.floor(recordBytes) - BROWSER_STREAM_CHUNK_HEADER_BYTES;
  if (!Number.isInteger(serial) || serial < 0 || serial > MAX_SERIAL) return [];
  if (envelope.byteLength === 0 || envelope.byteLength > BROWSER_STREAM_MAX_ENVELOPE_BYTES) return [];
  if (!Number.isFinite(payloadBytes) || payloadBytes < 1) return [];
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < envelope.byteLength; offset += payloadBytes) {
    const payload = envelope.subarray(offset, offset + payloadBytes);
    const chunk = new Uint8Array(BROWSER_STREAM_CHUNK_HEADER_BYTES + payload.byteLength);
    chunk.set(BROWSER_STREAM_CHUNK_MAGIC, 0);
    chunk[4] = BROWSER_STREAM_CHUNK_VERSION;
    const header = new DataView(chunk.buffer, chunk.byteOffset, BROWSER_STREAM_CHUNK_HEADER_BYTES);
    header.setUint32(5, serial, false);
    header.setUint32(9, envelope.byteLength, false);
    header.setUint32(13, offset, false);
    header.setUint32(17, payload.byteLength, false);
    chunk.set(payload, BROWSER_STREAM_CHUNK_HEADER_BYTES);
    chunks.push(chunk);
  }
  return chunks;
}

/** The serial after `serial`, wrapping inside four bytes. */
export const nextBrowserStreamSerial = (serial: number): number => (serial >= MAX_SERIAL ? 0 : serial + 1);

/** A frame part-way through assembly. */
interface AssemblingFrame {
  readonly serial: number;
  readonly total: number;
  readonly received: number;
  readonly parts: readonly Uint8Array[];
}

/**
 * Where a reader is in the stream: the bytes of a chunk it has not finished reading, and the frame it
 * is assembling. Immutable; every step answers a new one.
 */
export interface BrowserStreamAssembly {
  readonly pending: Uint8Array;
  readonly frame: AssemblingFrame | undefined;
}

export const EMPTY_BROWSER_STREAM_ASSEMBLY: BrowserStreamAssembly = { pending: new Uint8Array(0), frame: undefined };

export type BrowserStreamStep =
  | { readonly ok: true; readonly assembly: BrowserStreamAssembly; readonly envelopes: readonly Uint8Array[] }
  | { readonly ok: false; readonly message: string };

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  let length = 0;
  for (const part of parts) length += part.byteLength;
  const whole = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    whole.set(part, offset);
    offset += part.byteLength;
  }
  return whole;
};

/**
 * The next frame state after one chunk: started, extended, completed, or discarded.
 *
 * Offset 0 always starts a frame, abandoning whatever was partly assembled — that is the recovery from
 * a dropped chunk. Any other chunk must continue the frame in hand exactly; one that does not is the
 * far side of a hole, and the partial frame is discarded rather than painted with a gap in it.
 */
const stepFrame = (
  frame: AssemblingFrame | undefined,
  serial: number,
  total: number,
  offset: number,
  payload: Uint8Array,
): { readonly frame: AssemblingFrame | undefined; readonly envelope?: Uint8Array } => {
  const current: AssemblingFrame | undefined = offset === 0 ? { serial, total, received: 0, parts: [] } : frame;
  if (current === undefined || current.serial !== serial || current.total !== total || current.received !== offset)
    return { frame: undefined };
  const next: AssemblingFrame = {
    serial,
    total,
    received: current.received + payload.byteLength,
    parts: [...current.parts, payload],
  };
  return next.received === total ? { frame: undefined, envelope: concat(next.parts) } : { frame: next };
};

/**
 * Feeds one run of the stream to the reader and answers every envelope it completed.
 *
 * A header that is not a chunk — wrong magic, an unknown version, a length that contradicts itself —
 * is NOT skipped: a byte stream that lost its framing cannot find it again honestly, so the step fails
 * and the caller ends the stream, whose own repair is a fresh attach.
 */
export function assembleBrowserStream(assembly: BrowserStreamAssembly, bytes: Uint8Array): BrowserStreamStep {
  let buffer = assembly.pending.byteLength === 0 ? bytes : concat([assembly.pending, bytes]);
  let frame = assembly.frame;
  const envelopes: Uint8Array[] = [];
  while (buffer.byteLength >= BROWSER_STREAM_CHUNK_HEADER_BYTES) {
    if (BROWSER_STREAM_CHUNK_MAGIC.some((byte, index) => buffer[index] !== byte))
      return { ok: false, message: 'browser stream chunk magic does not match' };
    if (buffer[4] !== BROWSER_STREAM_CHUNK_VERSION)
      return { ok: false, message: 'unsupported browser stream chunk version' };
    const header = new DataView(buffer.buffer, buffer.byteOffset, BROWSER_STREAM_CHUNK_HEADER_BYTES);
    const serial = header.getUint32(5, false);
    const total = header.getUint32(9, false);
    const offset = header.getUint32(13, false);
    const length = header.getUint32(17, false);
    if (total === 0 || total > BROWSER_STREAM_MAX_ENVELOPE_BYTES || length === 0 || offset + length > total)
      return { ok: false, message: 'browser stream chunk header contradicts itself' };
    const end = BROWSER_STREAM_CHUNK_HEADER_BYTES + length;
    if (buffer.byteLength < end) break;
    const step = stepFrame(frame, serial, total, offset, buffer.slice(BROWSER_STREAM_CHUNK_HEADER_BYTES, end));
    frame = step.frame;
    if (step.envelope !== undefined) envelopes.push(step.envelope);
    buffer = buffer.subarray(end);
  }
  return { ok: true, assembly: { pending: buffer.slice(), frame }, envelopes };
}
