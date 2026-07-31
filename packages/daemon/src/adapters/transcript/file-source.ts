import { watch as watchFileSystem, type FSWatcher } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  TranscriptBatch,
  TranscriptFileCursor,
  TranscriptFollowOptions,
  TranscriptInputObserver,
  TranscriptIssue,
  TranscriptIssueCode,
  TranscriptParser,
  TranscriptReadOptions,
  TranscriptSource,
} from '../../lib/transcript/types.ts';

const READ_CHUNK_BYTES = 64 * 1024;
const CURSOR_ANCHOR_BYTES = 512;

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

/** Caller-tunable read bounds; the defaults are the ones the daemon ships with. */
export interface TranscriptReadLimits {
  readonly maxReadBytes?: number;
  readonly maxPendingBytes?: number;
}

interface ResolvedTranscriptReadLimits {
  readonly maxReadBytes: number;
  readonly maxPendingBytes: number;
}

function resolveLimits(limits: TranscriptReadLimits = {}): ResolvedTranscriptReadLimits {
  const positive = (value: number | undefined, fallback: number): number =>
    value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
  return {
    maxReadBytes: positive(limits.maxReadBytes, DEFAULT_MAX_READ_BYTES),
    maxPendingBytes: positive(limits.maxPendingBytes, DEFAULT_MAX_PENDING_BYTES),
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
    const chunks: Buffer[] = [];
    let position = byteOffset;
    let total = 0;
    let truncated = false;
    try {
      while (total < byteLimit) {
        const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, byteLimit - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position);
        if (bytesRead === 0) break;
        chunks.push(chunk.subarray(0, bytesRead));
        position += bytesRead;
        total += bytesRead;
      }
      if (total === byteLimit) {
        // One byte past the limit separates "the file ends here" from "the cap stopped us".
        const probe = Buffer.allocUnsafe(1);
        const { bytesRead } = await handle.read(probe, 0, 1, position);
        truncated = bytesRead > 0;
      }
    } finally {
      await handle.close();
    }
    return { bytes: Buffer.concat(chunks), truncated };
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
  readonly nextLine: number;
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

function countLines(bytes: Uint8Array): number {
  let lines = 0;
  for (const byte of bytes) if (byte === 0x0a) lines += 1;
  return lines;
}

function lastNewline(bytes: Uint8Array): number {
  for (let index = bytes.byteLength - 1; index >= 0; index -= 1) {
    if (bytes[index] === 0x0a) return index;
  }
  return -1;
}

function firstNewline(bytes: Uint8Array): number {
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0x0a) return index;
  }
  return -1;
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
    nextLine: state.nextLine,
  };
}

function batchOf(
  parser: TranscriptParser,
  file: string,
  state: FollowState,
  reset: boolean,
  events: TranscriptBatch['events'] = [],
  issues: TranscriptBatch['issues'] = [],
  observedInputs: TranscriptBatch['observedInputs'] = [],
): TranscriptBatch {
  return { harness: parser.harness, file, reset, cursor: cursorOf(state), events, observedInputs, issues };
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

  const combined = Buffer.concat([Buffer.from(base.partial), Buffer.from(consumed)]);
  const newline = lastNewline(combined);
  const complete = newline >= 0 ? combined.subarray(0, newline + 1) : Buffer.alloc(0);
  const tail = newline >= 0 ? combined.subarray(newline + 1) : combined;
  // An unterminated record that outgrows the pending limit would otherwise be buffered forever.
  const overflowed = tail.byteLength > limits.maxPendingBytes;
  const partial = overflowed ? Buffer.alloc(0) : tail;
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
  const parsed = parser.parse(
    {
      text: complete.toString('utf8'),
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
    nextLine: base.nextLine + skippedLines + countLines(complete),
    modifiedMs: afterInfo.modifiedMs,
  };
  const issues = [...parsed.issues];
  if (overflowed) {
    issues.push(
      sourceIssue(parser, file, 'oversized-record', 'transcript record exceeds the pending byte limit', {
        line: next.nextLine,
        byteOffset: byteOffset - tail.byteLength,
        byteLength: tail.byteLength,
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
    ...(changed ? { batch: batchOf(parser, file, next, reset, parsed.events, issues, parsed.observedInputs) } : {}),
    more: read.truncated,
  };
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
    const text = Buffer.from(bytes).toString('utf8');
    const parsed = this.parser.parse(
      {
        text,
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
    return batchOf(this.parser, file, state, false, parsed.events, issues, parsed.observedInputs);
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
