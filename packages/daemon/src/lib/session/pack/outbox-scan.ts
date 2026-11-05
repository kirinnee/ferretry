import { newestMessageTo, type OutboxLookup, type SentMessage } from './subtree.ts';

/** How much of an outbox's end is read per step. */
export const OUTBOX_CHUNK_BYTES = 64 * 1024;

/** The most of an outbox's end ever read for one lookup: a report longer than this is not found. */
export const OUTBOX_SCAN_BYTES = 1024 * 1024;

/** A file read at an offset, as the scan sees it. */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

/**
 * The newest message sent to `to`, found by reading COMPLETE lines from the end of an outbox backwards, one
 * chunk at a time, until the recipient turns up or `maxBytes` have been read. A record longer than a chunk is
 * assembled across chunks rather than cut, so one big report never hides the message under it; a long
 * conversation costs only the chunks it takes to reach the newest line to `to`.
 */
export async function newestMessageScanning(
  source: ByteSource,
  to: string,
  chunkBytes: number = OUTBOX_CHUNK_BYTES,
  maxBytes: number = OUTBOX_SCAN_BYTES,
): Promise<SentMessage | undefined> {
  return (await scanOutbox(source, to, chunkBytes, maxBytes)).message;
}

/** {@link newestMessageScanning}, also saying how many bytes it read, so a caller can charge them to a budget. */
export async function scanOutbox(
  source: ByteSource,
  to: string,
  chunkBytes: number = OUTBOX_CHUNK_BYTES,
  maxBytes: number = OUTBOX_SCAN_BYTES,
): Promise<OutboxLookup> {
  let position = source.size;
  let scanned = 0;
  // The start of a line whose beginning is still earlier in the file; always the front of the next window.
  let partial: Buffer = Buffer.alloc(0);
  while (position > 0 && scanned < maxBytes) {
    const length = Math.min(chunkBytes, position, maxBytes - scanned);
    position -= length;
    scanned += length;
    const window = Buffer.concat([await source.read(position, length), partial]);
    // Bytes, not text, so a multi-byte character cut by a chunk edge is never split before it is decoded.
    const firstBreak = position === 0 ? -1 : window.indexOf(0x0a);
    if (position > 0 && firstBreak === -1) {
      partial = window;
      continue;
    }
    partial = position === 0 ? Buffer.alloc(0) : window.subarray(0, firstBreak);
    const complete = window.subarray(firstBreak + 1);
    const found = newestMessageTo(complete.toString('utf8'), to);
    if (found !== undefined) return { message: found, scanned };
  }
  return { message: undefined, scanned };
}
