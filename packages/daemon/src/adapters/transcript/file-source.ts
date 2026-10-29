import { type FSWatcher, watch as watchFileSystem } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  TranscriptBatch,
  TranscriptFileCursor,
  TranscriptFollowOptions,
  TranscriptInputObserver,
  TranscriptIssue,
  TranscriptIssueCode,
  TranscriptParseInput,
  TranscriptParser,
  TranscriptParseResult,
  TranscriptReadOptions,
  TranscriptSource,
  TranscriptWindow,
  TranscriptWindowOptions,
  TranscriptWindowStep,
} from '../../lib/transcript/types.ts';
import { countLines, parseTranscriptInSlices, type TranscriptParsePacing } from '../../lib/transcript/sliced.ts';

const READ_CHUNK_BYTES = 64 * 1024;
const CURSOR_ANCHOR_BYTES = 512;

/** The daemon's own pacing: its monotonic clock, and a yield that lets every timer and socket run. */
export const LOOP_PARSE_PACING: TranscriptParsePacing = {
  now: () => performance.now(),
  yieldToLoop: () => new Promise(resolve => setImmediate(resolve)),
};

/**
 * {@link parseTranscriptInSlices} over the bytes of a read, paced by the daemon's own event loop.
 *
 * A bounded read is up to 32 MiB; see `PARSE_SLICE_BYTES` for why it is never parsed in one call.
 */
export async function parseInSlices(
  parser: TranscriptParser,
  input: Omit<TranscriptParseInput, 'text' | 'bytes'> & { readonly bytes: Uint8Array | readonly Uint8Array[] },
  observer: TranscriptInputObserver = parser.createInputObserver(),
): Promise<TranscriptParseResult> {
  return await parseTranscriptInSlices(parser, input, LOOP_PARSE_PACING, observer);
}

/**
 * The most transcript bytes any single read may pull into memory.
 *
 * Transcripts are agent-written and grow for as long as a session lives; long-running ones reach
 * hundreds of megabytes. Reading one wholesale is therefore not an attack, it is ordinary
 * operation — and it takes the daemon down with it. A follower consumes a large file across
 * successive bounded reads instead, so the cap costs latency rather than data.
 */
export const DEFAULT_MAX_READ_BYTES = 32 * 1024 * 1024;

/**
 * The most bytes retained for one unterminated record while waiting for its newline.
 *
 * A record larger than this cannot be parsed into anything useful, so it is discarded and reported
 * rather than buffered until the process dies.
 */
export const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024;

/**
 * How far back from a file's end a `since` window may reach.
 *
 * A window's cost is what was written after its instant, so this is only met by an instant older
 * than a quarter-gigabyte of transcript. It is bounded anyway because the instant comes from a
 * caller and the file from an agent: the window is placed at the limit and says it was.
 */
export const DEFAULT_MAX_WINDOW_BYTES = 256 * 1024 * 1024;

/** Caller-tunable read bounds; the defaults are the ones the daemon ships with. */
export interface TranscriptReadLimits {
  readonly maxReadBytes?: number;
  readonly maxPendingBytes?: number;
  readonly maxWindowBytes?: number;
}

interface ResolvedTranscriptReadLimits {
  readonly maxReadBytes: number;
  readonly maxPendingBytes: number;
  readonly maxWindowBytes: number;
}

function resolveLimits(limits: TranscriptReadLimits = {}): ResolvedTranscriptReadLimits {
  const positive = (value: number | undefined, fallback: number): number =>
    value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
  return {
    maxReadBytes: positive(limits.maxReadBytes, DEFAULT_MAX_READ_BYTES),
    maxPendingBytes: positive(limits.maxPendingBytes, DEFAULT_MAX_PENDING_BYTES),
    maxWindowBytes: positive(limits.maxWindowBytes, DEFAULT_MAX_WINDOW_BYTES),
  };
}

export interface TranscriptFileInfo {
  readonly identity: string;
  readonly size: number;
  readonly modifiedMs: number;
  readonly isFile: boolean;
}

/** The outcome of a read that was allowed to stop early rather than consume the whole file. */
export interface BoundedTranscriptRead {
  readonly bytes: Uint8Array;
  /** True when the read stopped at its limit with bytes still unread. */
  readonly truncated: boolean;
}

export interface TranscriptWatchHandle {
  close(): void;
}

interface TranscriptClock {
  now(): string;
}

class SystemTranscriptClock implements TranscriptClock {
  now(): string {
    return new Date().toISOString();
  }
}

/**
 * Node primitives injected into the transcript source for deterministic fault tests.
 *
 * Every method that could touch an unbounded number of bytes takes an explicit limit, so no
 * implementation of this port is able to offer the source an unbounded read.
 */
export interface TranscriptFileRuntime {
  info(file: string): Promise<TranscriptFileInfo | undefined>;
  countNewlines(file: string, byteLength: number): Promise<number>;
  readTrailingLine(file: string, byteLength: number, byteLimit: number): Promise<BoundedTranscriptRead>;
  readRange(file: string, byteOffset: number, byteLength: number): Promise<Uint8Array>;
  readFrom(file: string, byteOffset: number, byteLimit: number): Promise<BoundedTranscriptRead>;
  watch(directory: string, onChange: () => void, onError: (error: Error) => void): TranscriptWatchHandle;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/** Production runtime for exact-path transcript IO. */
export class NodeTranscriptFileRuntime implements TranscriptFileRuntime {
  async info(file: string): Promise<TranscriptFileInfo | undefined> {
    try {
      const details = await stat(file);
      return {
        identity: `${details.dev.toString()}:${details.ino.toString()}`,
        size: details.size,
        modifiedMs: details.mtimeMs,
        isFile: details.isFile(),
      };
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
      throw error;
    }
  }

  async countNewlines(file: string, byteLength: number): Promise<number> {
    const handle = await open(file, 'r');
    let position = 0;
    let lines = 0;
    try {
      while (position < byteLength) {
        const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, byteLength - position));
        const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position);
        if (bytesRead === 0) break;
        lines += countLines(chunk.subarray(0, bytesRead));
        position += bytesRead;
      }
    } finally {
      await handle.close();
    }
    return lines;
  }

  async readTrailingLine(file: string, byteLength: number, byteLimit: number): Promise<BoundedTranscriptRead> {
    if (byteLength === 0) return { bytes: new Uint8Array(), truncated: false };
    if (byteLimit < 1) return { bytes: new Uint8Array(), truncated: true };
    const handle = await open(file, 'r');
    const chunks: Buffer[] = [];
    let position = byteLength;
    let total = 0;
    let bounded = false;
    try {
      while (position > 0) {
        if (total >= byteLimit) {
          bounded = true;
          break;
        }
        const length = Math.min(READ_CHUNK_BYTES, position, byteLimit - total);
        position -= length;
        const chunk = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(chunk, 0, length, position);
        const bytes = chunk.subarray(0, bytesRead);
        const newline = lastNewline(bytes);
        chunks.unshift(newline >= 0 ? bytes.subarray(newline + 1) : bytes);
        total += bytesRead;
        // A short read means the file shrank underneath us; the bytes in hand start the line.
        if (newline >= 0 || bytesRead < length) return { bytes: Buffer.concat(chunks), truncated: false };
      }
    } finally {
      await handle.close();
    }
    // Reaching offset zero found the line's true start; stopping at the limit did not.
    return { bytes: Buffer.concat(chunks), truncated: bounded };
  }

  async readRange(file: string, byteOffset: number, byteLength: number): Promise<Uint8Array> {
    if (byteLength === 0) return new Uint8Array();
    const handle = await open(file, 'r');
    const buffer = Buffer.allocUnsafe(byteLength);
    let total = 0;
    try {
      while (total < byteLength) {
        const { bytesRead } = await handle.read(buffer, total, byteLength - total, byteOffset + total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
    } finally {
      await handle.close();
    }
    return buffer.subarray(0, total);
  }

  async readFrom(file: string, byteOffset: number, byteLimit: number): Promise<BoundedTranscriptRead> {
    if (byteLimit < 1) return { bytes: new Uint8Array(), truncated: true };
    const handle = await open(file, 'r');
    try {
      // Sized from the file once, so a read is ONE buffer filled in place. Gathering it in chunks and
      // joining them allocated and copied every byte of up to 32 MiB a second time, in one synchronous
      // call — and on a host short of memory, the allocation is where the event loop waits. Bytes
      // appended after the measurement are left for the next read, as if this one had finished first.
      const { size } = await handle.stat();
      const buffer = Buffer.allocUnsafe(Math.max(0, Math.min(byteLimit, size - byteOffset)));
      let total = 0;
      while (total < buffer.byteLength) {
        const length = Math.min(READ_CHUNK_BYTES, buffer.byteLength - total);
        const { bytesRead } = await handle.read(buffer, total, length, byteOffset + total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      let truncated = false;
      if (total === byteLimit) {
        // One byte past the limit separates "the file ends here" from "the cap stopped us".
        const probe = Buffer.allocUnsafe(1);
        const { bytesRead } = await handle.read(probe, 0, 1, byteOffset + total);
        truncated = bytesRead > 0;
      }
      return { bytes: buffer.subarray(0, total), truncated };
    } finally {
      await handle.close();
    }
  }

  watch(directory: string, onChange: () => void, onError: (error: Error) => void): TranscriptWatchHandle {
    const watcher: FSWatcher = watchFileSystem(directory, { persistent: false }, onChange);
    watcher.on('error', onError);
    return { close: () => watcher.close() };
  }
}

interface FollowState {
  readonly initialized: boolean;
  /** Whether the first usable file must still establish its cursor at EOF. */
  readonly seekToEnd: boolean;
  /** True after a cursor has been established against a regular file. */
  readonly positioned: boolean;
  readonly availability: 'unknown' | 'present' | 'missing' | 'error';
  readonly identity?: string;
  readonly byteOffset: number;
  readonly partial: Uint8Array;
  /** Set after an oversized record was discarded: bytes are dropped until the next newline so the
   *  record's tail is never mistaken for a line of its own. */
  readonly skipToNewline: boolean;
  readonly anchor: Uint8Array;
  /** Relative to where the cursor was placed when `linesUnknown`, so it is never reported then. */
  readonly nextLine: number;
  /** Set when the cursor was placed mid-file, where no line number is known without a full scan. */
  readonly linesUnknown?: true;
  readonly modifiedMs?: number;
}

/** A cursor for a file the follower has not opened yet. */
function unpositionedState(overrides: Partial<FollowState> = {}): FollowState {
  return {
    initialized: true,
    seekToEnd: false,
    positioned: false,
    availability: 'error',
    byteOffset: 0,
    partial: new Uint8Array(),
    skipToNewline: false,
    anchor: new Uint8Array(),
    nextLine: 1,
    ...overrides,
  };
}

interface FollowReconcileResult {
  readonly state: FollowState;
  readonly batch?: TranscriptBatch;
  /** True when the bounded read stopped short of the file's end, so the loop must not idle. */
  readonly more?: boolean;
}

interface WakeController {
  wake(): void;
  wait(timeoutMs: number, signal?: AbortSignal): Promise<void>;
  close(): void;
}

function createWakeController(): WakeController {
  let dirty = false;
  let closed = false;
  let settle: (() => void) | undefined;

  return {
    wake(): void {
      dirty = true;
      settle?.();
    },
    async wait(timeoutMs: number, signal?: AbortSignal): Promise<void> {
      if (dirty) {
        dirty = false;
        return;
      }
      if (closed || signal?.aborted === true) return;

      await new Promise<void>(resolve => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (): void => {
          if (timer !== undefined) clearTimeout(timer);
          signal?.removeEventListener('abort', finish);
          settle = undefined;
          resolve();
        };
        settle = finish;
        timer = setTimeout(finish, timeoutMs);
        signal?.addEventListener('abort', finish, { once: true });
      });
      dirty = false;
    },
    close(): void {
      closed = true;
      settle?.();
    },
  };
}

function lastNewline(bytes: Uint8Array): number {
  return bytes.lastIndexOf(0x0a);
}

function firstNewline(bytes: Uint8Array): number {
  return bytes.indexOf(0x0a);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function advanceAnchor(anchor: Uint8Array, appended: Uint8Array): Uint8Array {
  // Only the anchor's own width can ever survive, so a bounded read's worth of bytes is never copied.
  if (appended.byteLength >= CURSOR_ANCHOR_BYTES) {
    return Buffer.from(appended.subarray(appended.byteLength - CURSOR_ANCHOR_BYTES));
  }
  const combined = Buffer.concat([Buffer.from(anchor), Buffer.from(appended)]);
  return Buffer.from(combined.subarray(Math.max(0, combined.byteLength - CURSOR_ANCHOR_BYTES)));
}

async function readAnchor(runtime: TranscriptFileRuntime, file: string, byteOffset: number): Promise<Uint8Array> {
  const length = Math.min(CURSOR_ANCHOR_BYTES, byteOffset);
  return await runtime.readRange(file, byteOffset - length, length);
}

async function cursorMatches(
  runtime: TranscriptFileRuntime,
  file: string,
  info: TranscriptFileInfo,
  state: FollowState,
): Promise<boolean> {
  if (!state.positioned) return true;
  if (state.identity !== undefined && state.identity !== info.identity) return false;
  if (info.size < state.byteOffset) return false;
  if (state.byteOffset === 0) return true;
  return bytesEqual(await readAnchor(runtime, file, state.byteOffset), state.anchor);
}

function sourceIssue(
  parser: TranscriptParser,
  file: string,
  code: Extract<
    TranscriptIssueCode,
    | 'incomplete-line'
    | 'oversized-record'
    | 'source-missing'
    | 'source-read-failed'
    | 'source-truncated'
    | 'source-watch-failed'
  >,
  message: string,
  extras: Pick<TranscriptIssue, 'line' | 'byteOffset' | 'byteLength'> = {},
): TranscriptIssue {
  return {
    harness: parser.harness,
    code,
    message,
    recoverable: true,
    source: file,
    ...extras,
  };
}

function cursorOf(state: FollowState): TranscriptFileCursor {
  return {
    identity: state.identity,
    byteOffset: state.byteOffset,
    pendingBytes: state.partial.byteLength,
    ...(state.linesUnknown === true ? {} : { nextLine: state.nextLine }),
  };
}

/** A line number counted from mid-file names some other line, so it is dropped rather than served. */
function withoutLine<T extends { readonly line?: number }>(value: T): T {
  if (value.line === undefined) return value;
  const { line: _line, ...rest } = value;
  return rest as T;
}

/**
 * `rawRecords` is CARRIED, never computed here.
 *
 * The parser is the one owner of where a physical record starts and ends, so this adapter hands it
 * the bytes and passes on whatever it says the records were. Splitting the buffer a second time
 * would be a second answer to that question, and a one-record drift between the two answers would
 * silently bind every point to its neighbour's content.
 */
function batchOf(
  parser: TranscriptParser,
  file: string,
  state: FollowState,
  reset: boolean,
  events: TranscriptBatch['events'] = [],
  issues: TranscriptBatch['issues'] = [],
  observedInputs: TranscriptBatch['observedInputs'] = [],
  rawRecords?: TranscriptBatch['rawRecords'],
): TranscriptBatch {
  const lines = state.linesUnknown !== true;
  return {
    harness: parser.harness,
    file,
    reset,
    cursor: cursorOf(state),
    events: lines ? events : events.map(withoutLine),
    observedInputs,
    issues: lines ? issues : issues.map(withoutLine),
    ...(rawRecords === undefined ? {} : { rawRecords }),
  };
}

function missingResult(
  parser: TranscriptParser,
  file: string,
  state: FollowState,
  observer?: TranscriptInputObserver,
): FollowReconcileResult {
  const changed = state.availability !== 'missing';
  if (changed && state.positioned) observer?.reset();
  const next: FollowState = unpositionedState({ positioned: state.positioned, availability: 'missing' });
  return {
    state: next,
    ...(changed
      ? {
          batch: batchOf(
            parser,
            file,
            next,
            state.positioned && state.identity !== undefined,
            [],
            [sourceIssue(parser, file, 'source-missing', 'transcript file is not available')],
          ),
        }
      : {}),
  };
}

async function reconcileFollow(
  parser: TranscriptParser,
  runtime: TranscriptFileRuntime,
  file: string,
  options: TranscriptFollowOptions,
  state: FollowState,
  observer: TranscriptInputObserver,
  clock: TranscriptClock,
  limits: ResolvedTranscriptReadLimits,
): Promise<FollowReconcileResult> {
  let info: TranscriptFileInfo | undefined;
  try {
    info = await runtime.info(file);
  } catch {
    if (state.availability === 'error') return { state };
    const next = { ...state, initialized: true, availability: 'error' as const };
    return {
      state: next,
      batch: batchOf(
        parser,
        file,
        next,
        false,
        [],
        [sourceIssue(parser, file, 'source-read-failed', 'transcript file metadata could not be read')],
      ),
    };
  }
  if (info === undefined) return missingResult(parser, file, state, observer);
  if (!info.isFile) {
    if (state.availability === 'error') return { state };
    const next = { ...state, initialized: true, seekToEnd: false, availability: 'error' as const };
    return {
      state: next,
      batch: batchOf(
        parser,
        file,
        next,
        false,
        [],
        [sourceIssue(parser, file, 'source-read-failed', 'transcript source is not a regular file')],
      ),
    };
  }

  if (state.seekToEnd) {
    let anchor: Uint8Array;
    let nextLine: number;
    let trailing: BoundedTranscriptRead;
    try {
      [anchor, nextLine, trailing] = await Promise.all([
        readAnchor(runtime, file, info.size),
        runtime.countNewlines(file, info.size).then(lines => lines + 1),
        runtime.readTrailingLine(file, info.size, limits.maxPendingBytes),
      ]);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return missingResult(parser, file, state, observer);
      const next = { ...state, initialized: true, availability: 'error' as const };
      return {
        state: next,
        batch: batchOf(
          parser,
          file,
          next,
          false,
          [],
          [sourceIssue(parser, file, 'source-read-failed', 'transcript cursor could not be established')],
        ),
      };
    }
    let afterInfo: TranscriptFileInfo | undefined;
    try {
      afterInfo = await runtime.info(file);
    } catch {
      if (state.availability === 'error') return { state };
      const next = { ...state, initialized: true, availability: 'error' as const };
      return {
        state: next,
        batch: batchOf(
          parser,
          file,
          next,
          false,
          [],
          [sourceIssue(parser, file, 'source-read-failed', 'transcript cursor could not be verified')],
        ),
      };
    }
    if (afterInfo === undefined) return missingResult(parser, file, state, observer);
    if (afterInfo.identity !== info.identity || afterInfo.size < info.size) {
      if (state.availability === 'error') return { state };
      const next = { ...state, initialized: true, seekToEnd: false, availability: 'error' as const };
      return {
        state: next,
        batch: batchOf(
          parser,
          file,
          next,
          false,
          [],
          [sourceIssue(parser, file, 'source-read-failed', 'transcript changed while its cursor was established')],
        ),
      };
    }
    // A trailing record too large to hold is not carried forward: its tail is skipped instead, so
    // the follower resumes on the next whole record rather than on a fragment.
    const oversized = trailing.truncated;
    const partial = oversized ? new Uint8Array() : trailing.bytes;
    const next: FollowState = {
      initialized: true,
      seekToEnd: false,
      positioned: true,
      availability: 'present',
      identity: info.identity,
      byteOffset: info.size,
      partial,
      skipToNewline: oversized,
      anchor,
      nextLine,
      modifiedMs: info.modifiedMs,
    };
    const issues = oversized
      ? [
          sourceIssue(parser, file, 'oversized-record', 'trailing transcript record exceeds the pending byte limit', {
            line: next.nextLine,
            byteOffset: info.size - trailing.bytes.byteLength,
            byteLength: trailing.bytes.byteLength,
          }),
        ]
      : partial.byteLength > 0
        ? [
            sourceIssue(parser, file, 'incomplete-line', 'trailing transcript line is incomplete', {
              line: next.nextLine,
              byteOffset: info.size - partial.byteLength,
              byteLength: partial.byteLength,
            }),
          ]
        : [];
    return { state: next, batch: batchOf(parser, file, next, false, [], issues) };
  }

  let reset: boolean;
  try {
    reset = !(await cursorMatches(runtime, file, info, state));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return missingResult(parser, file, state, observer);
    const next = { ...state, initialized: true, availability: 'error' as const };
    return {
      state: next,
      batch: batchOf(
        parser,
        file,
        next,
        false,
        [],
        [sourceIssue(parser, file, 'source-read-failed', 'transcript cursor could not be verified')],
      ),
    };
  }
  const base: FollowState = reset
    ? {
        initialized: true,
        seekToEnd: false,
        positioned: true,
        availability: 'present',
        identity: info.identity,
        byteOffset: 0,
        partial: new Uint8Array(),
        skipToNewline: false,
        anchor: new Uint8Array(),
        nextLine: 1,
        modifiedMs: info.modifiedMs,
      }
    : {
        ...state,
        initialized: true,
        seekToEnd: false,
        positioned: true,
        availability: 'present',
        identity: info.identity,
        modifiedMs: info.modifiedMs,
      };
  if (reset) observer.reset();

  let read: BoundedTranscriptRead;
  try {
    read = await runtime.readFrom(file, base.byteOffset, limits.maxReadBytes);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return missingResult(parser, file, state, observer);
    const next = { ...base, availability: 'error' as const };
    return {
      state: next,
      batch: batchOf(
        parser,
        file,
        next,
        reset,
        [],
        [sourceIssue(parser, file, 'source-read-failed', 'transcript bytes could not be read')],
      ),
    };
  }

  const appended = read.bytes;
  // Bytes belonging to a record already reported as oversized are dropped up to its terminator, so
  // its tail can never be handed to the parser as a record of its own.
  const resumeAt = base.skipToNewline ? firstNewline(appended) : -1;
  const skipping = base.skipToNewline && resumeAt < 0;
  const consumed = !base.skipToNewline
    ? appended
    : skipping
      ? appended.subarray(appended.byteLength)
      : appended.subarray(resumeAt + 1);
  const skippedBytes = appended.byteLength - consumed.byteLength;
  const skippedLines = base.skipToNewline && resumeAt >= 0 ? 1 : 0;

  // The record carried over from the last read is joined to its own end in this one, and nothing else
  // is: every later record is parsed where the read put it. Joining the WHOLE read to the carried
  // bytes copied up to 32 MiB in one synchronous call on every read that followed a partial line —
  // and on a host short of memory that allocation, not the parse, is where the event loop waited.
  const lastFeed = lastNewline(consumed);
  const firstFeed = lastFeed < 0 ? -1 : firstNewline(consumed);
  const tailLength = lastFeed < 0 ? base.partial.byteLength + consumed.byteLength : consumed.byteLength - lastFeed - 1;
  // An unterminated record that outgrows the pending limit would otherwise be buffered forever.
  const overflowed = tailLength > limits.maxPendingBytes;
  const complete: readonly Uint8Array[] =
    lastFeed < 0
      ? []
      : [
          base.partial.byteLength === 0
            ? consumed.subarray(0, firstFeed + 1)
            : Buffer.concat([base.partial, consumed.subarray(0, firstFeed + 1)]),
          consumed.subarray(firstFeed + 1, lastFeed + 1),
        ];
  const partial = overflowed
    ? new Uint8Array()
    : lastFeed < 0
      ? Buffer.concat([base.partial, consumed])
      : consumed.subarray(lastFeed + 1);
  const byteOffset = base.byteOffset + appended.byteLength;
  let afterInfo: TranscriptFileInfo | undefined;
  try {
    afterInfo = await runtime.info(file);
  } catch {
    if (state.availability === 'error') return { state };
    const next = { ...state, initialized: true, availability: 'error' as const };
    return {
      state: next,
      batch: batchOf(
        parser,
        file,
        next,
        reset,
        [],
        [sourceIssue(parser, file, 'source-read-failed', 'transcript metadata could not be verified after reading')],
      ),
    };
  }
  if (afterInfo === undefined) return missingResult(parser, file, state, observer);
  if (afterInfo.identity !== info.identity || afterInfo.size < byteOffset) {
    return { state };
  }
  const parsed = await parseInSlices(
    parser,
    {
      // The very bytes of the read, so the parser can report each record's exact slice instead of a
      // re-encoding of what a decoder made of it.
      bytes: complete,
      source: file,
      sessionId: options.sessionId,
      endOfInput: false,
      startLine: base.nextLine + skippedLines,
      startByteOffset: base.byteOffset + skippedBytes - base.partial.byteLength,
      observedAt: clock.now(),
    },
    observer,
  );
  const next: FollowState = {
    initialized: true,
    seekToEnd: false,
    positioned: true,
    availability: 'present',
    identity: info.identity,
    byteOffset,
    partial: Buffer.from(partial),
    skipToNewline: skipping || overflowed,
    anchor: advanceAnchor(base.anchor, appended),
    nextLine: base.nextLine + skippedLines + complete.reduce((lines, piece) => lines + countLines(piece), 0),
    ...(base.linesUnknown === true ? { linesUnknown: true as const } : {}),
    modifiedMs: afterInfo.modifiedMs,
  };
  const issues = [...parsed.issues];
  if (overflowed) {
    issues.push(
      sourceIssue(parser, file, 'oversized-record', 'transcript record exceeds the pending byte limit', {
        line: next.nextLine,
        byteOffset: byteOffset - tailLength,
        byteLength: tailLength,
      }),
    );
  } else if (partial.byteLength > 0 && (appended.byteLength > 0 || reset)) {
    issues.push(
      sourceIssue(parser, file, 'incomplete-line', 'trailing transcript line is incomplete', {
        line: next.nextLine,
        byteOffset: byteOffset - partial.byteLength,
        byteLength: partial.byteLength,
      }),
    );
  }
  if (read.truncated) {
    issues.push(
      sourceIssue(parser, file, 'source-truncated', 'transcript read stopped at the bounded read limit', {
        byteOffset,
        byteLength: Math.max(0, afterInfo.size - byteOffset),
      }),
    );
  }

  const changed = !state.initialized || reset || appended.byteLength > 0 || state.availability !== 'present';
  return {
    state: next,
    ...(changed
      ? { batch: batchOf(parser, file, next, reset, parsed.events, issues, parsed.observedInputs, parsed.rawRecords) }
      : {}),
    more: read.truncated,
  };
}

const SEEK_CHUNK_BYTES = 1024 * 1024;
const TIMESTAMP_KEY = Buffer.from('"timestamp":"');
/** The longest ISO instant a harness writes, with room to spare; anything longer is not one. */
const TIMESTAMP_VALUE_BYTES = 40;

/**
 * The latest harness timestamp anywhere in `bytes`, or nothing when it holds none.
 *
 * Read off the raw bytes rather than parsed, because the scan exists to AVOID decoding what it skips.
 * Both harnesses stamp their records with a top-level `"timestamp":"<ISO>"` — Claude at a record's
 * end, Codex at its start — and the quote of a key inside a JSON string is escaped, so only a real
 * key matches. A nested key with an older instant can only lower the answer for a chunk that is
 * already old; a newer one only makes the scan go further back, which costs bytes and never records.
 */
function latestStamp(bytes: Uint8Array): number | undefined {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let latest: number | undefined;
  let at = buffer.indexOf(TIMESTAMP_KEY);
  while (at >= 0) {
    const start = at + TIMESTAMP_KEY.byteLength;
    const end = buffer.indexOf(0x22, start);
    if (end < 0) break;
    const instant = end - start <= TIMESTAMP_VALUE_BYTES ? Date.parse(buffer.toString('latin1', start, end)) : NaN;
    if (Number.isFinite(instant) && (latest === undefined || instant > latest)) latest = instant;
    at = buffer.indexOf(TIMESTAMP_KEY, end);
  }
  return latest;
}

/** The first record boundary at or after `from`, or `size` when no newline follows it. */
async function boundaryFrom(runtime: TranscriptFileRuntime, file: string, from: number, size: number): Promise<number> {
  let position = from;
  while (position < size) {
    const bytes = await runtime.readRange(file, position, Math.min(SEEK_CHUNK_BYTES, size - position));
    if (bytes.byteLength === 0) break;
    const feed = firstNewline(bytes);
    if (feed >= 0) return position + feed + 1;
    position += bytes.byteLength;
  }
  return size;
}

/**
 * Where a `since` window starts: scanning BACK from the end, a chunk at a time, to the first chunk
 * whose every harness timestamp is older than `since`, and starting on a record boundary inside it.
 *
 * Records are appended in time order, so everything after that boundary is either older (and harmless
 * to read) or newer (and wanted). The scan reads what was written since `since` plus at most one
 * chunk, and it never reaches past `limit` bytes from the end: a window that would have to is placed
 * at the limit instead and reported `capped`, so a caller can say the older part was not read.
 */
async function seekSince(
  runtime: TranscriptFileRuntime,
  file: string,
  size: number,
  since: number,
  limit: number,
): Promise<{ readonly byteOffset: number; readonly capped: boolean }> {
  const floor = Math.max(0, size - limit);
  let end = size;
  while (end > floor) {
    const begin = Math.max(floor, end - SEEK_CHUNK_BYTES);
    const bytes = await runtime.readRange(file, begin, end - begin);
    const latest = latestStamp(bytes);
    const feed = latest !== undefined && latest < since ? firstNewline(bytes) : -1;
    if (feed >= 0) return { byteOffset: begin + feed + 1, capped: false };
    end = begin;
  }
  if (floor === 0) return { byteOffset: 0, capped: false };
  return { byteOffset: await boundaryFrom(runtime, file, floor, size), capped: true };
}

/** The pull-based window over one file; see `TranscriptWindow`. */
class NodeTranscriptWindow implements TranscriptWindow {
  private state: FollowState | undefined;
  /** An issue placement owes the first batch, held until a step has a batch to carry it. */
  private owed: TranscriptIssue | undefined;
  private readonly observer: TranscriptInputObserver;

  constructor(
    private readonly parser: TranscriptParser,
    private readonly runtime: TranscriptFileRuntime,
    private readonly clock: TranscriptClock,
    private readonly limits: ResolvedTranscriptReadLimits,
    readonly file: string,
    private readonly options: TranscriptWindowOptions,
  ) {
    this.observer = parser.createInputObserver();
  }

  async next(): Promise<TranscriptWindowStep> {
    if (this.state === undefined) {
      const placed = await this.place();
      if (placed !== undefined) return { batch: placed, more: false };
    }
    const reconciled = await reconcileFollow(
      this.parser,
      this.runtime,
      this.file,
      this.options,
      this.state as FollowState,
      this.observer,
      this.clock,
      this.limits,
    );
    this.state = reconciled.state;
    const owed = this.owed;
    this.owed = undefined;
    const batch =
      owed === undefined
        ? reconciled.batch
        : reconciled.batch === undefined
          ? batchOf(this.parser, this.file, reconciled.state, false, [], [owed])
          : { ...reconciled.batch, issues: [owed, ...reconciled.batch.issues] };
    return { ...(batch === undefined ? {} : { batch }), more: reconciled.more === true };
  }

  /**
   * Puts the cursor where the window starts, or answers with why it cannot be placed yet.
   *
   * A window that cannot be placed stays unplaced, so the next step tries again: falling back to the
   * beginning would read the very bytes the window exists to skip.
   */
  private async place(): Promise<TranscriptBatch | undefined> {
    const start = this.options.start;
    const since = start.at === 'since' ? Date.parse(start.instant) : NaN;
    const tail = start.at === 'tail' && Number.isFinite(start.bytes) ? Math.max(0, Math.floor(start.bytes)) : NaN;
    if (!Number.isFinite(since) && !Number.isFinite(tail)) {
      this.state = unpositionedState({ initialized: false, availability: 'unknown' });
      return undefined;
    }
    const failed = (message: string): TranscriptBatch =>
      batchOf(
        this.parser,
        this.file,
        unpositionedState(),
        false,
        [],
        [sourceIssue(this.parser, this.file, 'source-read-failed', message)],
      );
    let info: TranscriptFileInfo | undefined;
    try {
      info = await this.runtime.info(this.file);
    } catch {
      return failed('transcript file metadata could not be read');
    }
    if (info === undefined)
      return missingResult(this.parser, this.file, unpositionedState({ initialized: false, availability: 'unknown' }))
        .batch;
    if (!info.isFile) return failed('transcript source is not a regular file');
    let seek: { readonly byteOffset: number; readonly capped: boolean };
    let anchor: Uint8Array;
    try {
      seek = Number.isFinite(tail)
        ? {
            // One byte early, so a window that lands exactly on a boundary keeps the record starting there.
            byteOffset:
              info.size <= tail ? 0 : await boundaryFrom(this.runtime, this.file, info.size - tail - 1, info.size),
            capped: false,
          }
        : await seekSince(this.runtime, this.file, info.size, since, this.limits.maxWindowBytes);
      anchor = await readAnchor(this.runtime, this.file, seek.byteOffset);
    } catch {
      return failed('transcript window could not be placed');
    }
    this.state = {
      initialized: true,
      seekToEnd: false,
      positioned: true,
      availability: 'present',
      identity: info.identity,
      byteOffset: seek.byteOffset,
      partial: new Uint8Array(),
      skipToNewline: false,
      anchor,
      nextLine: 1,
      ...(seek.byteOffset === 0 ? {} : { linesUnknown: true as const }),
      modifiedMs: info.modifiedMs,
    };
    if (seek.capped)
      this.owed = sourceIssue(
        this.parser,
        this.file,
        'source-truncated',
        'transcript window reached its byte limit before the requested instant',
        { byteOffset: 0, byteLength: seek.byteOffset },
      );
    return undefined;
  }
}

/** Exact-path reader and live follower; harness behavior is supplied only through `TranscriptParser`. */
export class NodeTranscriptSource implements TranscriptSource {
  readonly harness: TranscriptParser['harness'];
  private readonly limits: ResolvedTranscriptReadLimits;

  constructor(
    private readonly parser: TranscriptParser,
    private readonly runtime: TranscriptFileRuntime = new NodeTranscriptFileRuntime(),
    private readonly clock: TranscriptClock = new SystemTranscriptClock(),
    limits: TranscriptReadLimits = {},
  ) {
    this.harness = parser.harness;
    this.limits = resolveLimits(limits);
  }

  async read(file: string, options: TranscriptReadOptions = {}): Promise<TranscriptBatch> {
    return await this.readConsistent(file, options, true, this.parser.createInputObserver());
  }

  window(file: string, options: TranscriptWindowOptions): TranscriptWindow {
    return new NodeTranscriptWindow(this.parser, this.runtime, this.clock, this.limits, file, options);
  }

  private async readConsistent(
    file: string,
    options: TranscriptReadOptions,
    canRetryIdentityChange: boolean,
    observer: TranscriptInputObserver,
  ): Promise<TranscriptBatch> {
    let info: TranscriptFileInfo | undefined;
    try {
      info = await this.runtime.info(file);
    } catch {
      return batchOf(
        this.parser,
        file,
        unpositionedState(),
        false,
        [],
        [sourceIssue(this.parser, file, 'source-read-failed', 'transcript file metadata could not be read')],
      );
    }
    if (info === undefined)
      return missingResult(this.parser, file, unpositionedState({ initialized: false, availability: 'unknown' }))
        .batch!;
    if (!info.isFile) {
      return batchOf(
        this.parser,
        file,
        unpositionedState({ identity: info.identity, modifiedMs: info.modifiedMs }),
        false,
        [],
        [sourceIssue(this.parser, file, 'source-read-failed', 'transcript source is not a regular file')],
      );
    }

    // The bounded read is the whole point: `info.size` is attacker-and-agent-controlled and grows
    // without limit, so the file is consumed up to a cap and the shortfall is reported.
    let read: BoundedTranscriptRead;
    try {
      read = await this.runtime.readFrom(file, 0, this.limits.maxReadBytes);
    } catch (error) {
      const code = errorCode(error) === 'ENOENT' ? 'source-missing' : 'source-read-failed';
      return batchOf(
        this.parser,
        file,
        unpositionedState({ identity: info.identity, modifiedMs: info.modifiedMs }),
        false,
        [],
        [
          sourceIssue(
            this.parser,
            file,
            code,
            code === 'source-missing' ? 'transcript file is not available' : 'transcript bytes could not be read',
          ),
        ],
      );
    }

    let afterInfo: TranscriptFileInfo | undefined;
    try {
      afterInfo = await this.runtime.info(file);
    } catch {
      return batchOf(
        this.parser,
        file,
        unpositionedState({ identity: info.identity, modifiedMs: info.modifiedMs }),
        false,
        [],
        [
          sourceIssue(
            this.parser,
            file,
            'source-read-failed',
            'transcript metadata could not be verified after reading',
          ),
        ],
      );
    }
    if (afterInfo === undefined) {
      return missingResult(this.parser, file, unpositionedState()).batch!;
    }
    if (!afterInfo.isFile || afterInfo.identity !== info.identity || afterInfo.size < read.bytes.byteLength) {
      if (canRetryIdentityChange) {
        observer.reset();
        return await this.readConsistent(file, options, false, observer);
      }
      return batchOf(
        this.parser,
        file,
        unpositionedState({ identity: afterInfo.identity, modifiedMs: afterInfo.modifiedMs }),
        false,
        [],
        [sourceIssue(this.parser, file, 'source-read-failed', 'transcript changed while being read')],
      );
    }
    info = afterInfo;

    // A capped read stops mid-record, so it is cut back to the last record terminator. The cursor it
    // reports is therefore a legal resume point: `follow` continues from exactly there.
    const bytes = read.truncated ? read.bytes.subarray(0, lastNewline(read.bytes) + 1) : read.bytes;
    const parsed = await parseInSlices(
      this.parser,
      {
        // The bounded bytes themselves, never a decoding. Record-exact evidence can only come from
        // these: a decode replaces every invalid sequence irreversibly, and two different malformed
        // records would otherwise commit to one value and become able to replace each other.
        bytes,
        source: file,
        sessionId: options.sessionId,
        endOfInput: !read.truncated,
        observedAt: this.clock.now(),
      },
      observer,
    );
    const pending = parsed.remainder.length > 0 ? Buffer.from(bytes.subarray(lastNewline(bytes) + 1)) : Buffer.alloc(0);
    const pendingOffset = bytes.byteLength - pending.byteLength;
    const issues = parsed.issues.map(issue =>
      issue.code === 'truncated-json' && issue.byteOffset === pendingOffset
        ? { ...issue, byteLength: pending.byteLength }
        : issue,
    );
    if (read.truncated) {
      issues.push(
        sourceIssue(this.parser, file, 'source-truncated', 'transcript exceeds the bounded read limit', {
          byteOffset: bytes.byteLength,
          byteLength: Math.max(0, info.size - bytes.byteLength),
        }),
      );
    }
    const state: FollowState = {
      initialized: true,
      seekToEnd: false,
      positioned: true,
      availability: 'present',
      identity: info.identity,
      byteOffset: bytes.byteLength,
      partial: pending,
      skipToNewline: false,
      anchor: advanceAnchor(new Uint8Array(), bytes),
      nextLine:
        countLines(bytes) + 1 + (bytes.byteLength > 0 && bytes.at(-1) !== 0x0a && pending.byteLength === 0 ? 1 : 0),
      modifiedMs: info.modifiedMs,
    };
    return batchOf(this.parser, file, state, false, parsed.events, issues, parsed.observedInputs, parsed.rawRecords);
  }

  async *follow(file: string, options: TranscriptFollowOptions = {}): AsyncGenerator<TranscriptBatch> {
    if (isAborted(options.signal)) return;
    const wake = createWakeController();
    const observer = this.parser.createInputObserver();
    const watchIssues: TranscriptIssue[] = [];
    let watcher: TranscriptWatchHandle | undefined;
    let watchFailed = false;
    let state: FollowState = unpositionedState({
      initialized: false,
      seekToEnd: options.startAt === 'end',
      availability: 'unknown',
    });
    const armWatch = (): void => {
      if (watcher !== undefined) return;
      try {
        watcher = this.runtime.watch(
          dirname(file),
          () => wake.wake(),
          () => {
            watchIssues.push(
              sourceIssue(this.parser, file, 'source-watch-failed', 'transcript directory watch failed'),
            );
            watcher?.close();
            watcher = undefined;
            watchFailed = true;
            wake.wake();
          },
        );
        watchFailed = false;
      } catch {
        if (!watchFailed) {
          watchIssues.push(
            sourceIssue(this.parser, file, 'source-watch-failed', 'transcript directory could not be watched'),
          );
        }
        watchFailed = true;
      }
    };

    const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 2_000);
    try {
      while (!isAborted(options.signal)) {
        armWatch();
        const reconciled = await reconcileFollow(
          this.parser,
          this.runtime,
          file,
          options,
          state,
          observer,
          this.clock,
          this.limits,
        );
        if (isAborted(options.signal)) break;
        state = reconciled.state;
        if (reconciled.batch !== undefined || watchIssues.length > 0) {
          const batch = reconciled.batch ?? batchOf(this.parser, file, state, false);
          const issues = [...batch.issues, ...watchIssues.splice(0)];
          yield { ...batch, issues };
        }
        // A read that stopped at its cap left bytes behind: resume at once instead of idling.
        if (reconciled.more === true) wake.wake();
        await wake.wait(pollIntervalMs, options.signal);
      }
    } finally {
      wake.close();
      watcher?.close();
    }
  }
}
