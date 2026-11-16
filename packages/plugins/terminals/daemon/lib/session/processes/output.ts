/**
 * BOUNDED, FOLLOWABLE READS OF AN OUTPUT FILE. Pure: no IO.
 *
 * A build log can be gigabytes and a watcher writes forever, so no read returns more than `max` bytes:
 * the first read is the file's tail, and every later one is what was written after the previous read's
 * end. A follower that fell further behind than one read skips the gap and is told so; a file that
 * shrank below where the follower was (truncated, replaced) starts again from its tail.
 */

export interface ReadWindow {
  readonly from: number;
  readonly to: number;
  /** Bytes before `from` that the reader did not ask to skip. */
  readonly skipped: boolean;
  /** The file is shorter than `after`: what the reader holds no longer describes it. */
  readonly reset: boolean;
}

export function readWindow(size: number, after: number | undefined, max: number): ReadWindow {
  const tail = Math.max(0, size - max);
  if (after === undefined) return { from: tail, to: size, skipped: tail > 0, reset: false };
  if (after > size) return { from: tail, to: size, skipped: tail > 0, reset: true };
  if (size - after > max) return { from: tail, to: size, skipped: true, reset: false };
  return { from: after, to: size, skipped: false, reset: false };
}

/** The most a live read holds back waiting for a line to end, before it delivers the fragment anyway. */
export const PARTIAL_LINE_HOLD_MAX = 64 * 1024;

const LF = 0x0a;
const CR = 0x0d;

/**
 * How many of `bytes` to deliver now.
 *
 * WHOLE LINES ONLY WHILE THE PROCESS RUNS. Delivering a fragment would split a UTF-8 character, and —
 * the reason that matters — a secret value written across two reads would be masked in neither, since
 * redaction can only recognise a value it sees whole. So a live read stops after its last line ending
 * (`\n`, or the `\r` a progress bar redraws with) and the next read starts there. A process that will
 * write no more, or a fragment longer than {@link PARTIAL_LINE_HOLD_MAX}, is delivered as it is.
 */
export function deliverableLength(bytes: Uint8Array, complete: boolean): number {
  if (complete || bytes.byteLength === 0) return bytes.byteLength;
  for (let index = bytes.byteLength - 1; index >= 0; index--) {
    const byte = bytes[index];
    if (byte === LF || byte === CR) return index + 1;
  }
  return bytes.byteLength > PARTIAL_LINE_HOLD_MAX ? bytes.byteLength : 0;
}

/**
 * Bytes at the front of a read that started mid-file and so may begin inside a UTF-8 character: its
 * continuation bytes (`10xxxxxx`) are dropped rather than shown as a replacement character.
 */
export function leadingContinuationBytes(bytes: Uint8Array, skipped: boolean): number {
  if (!skipped) return 0;
  let index = 0;
  while (index < Math.min(3, bytes.byteLength) && ((bytes[index] as number) & 0xc0) === 0x80) index++;
  return index;
}
