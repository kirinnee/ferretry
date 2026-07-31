import { watch as watchFileSystem, type FSWatcher } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  TranscriptBatch,
  TranscriptFileCursor,
  TranscriptFollowOptions,
  TranscriptIssue,
  TranscriptIssueCode,
  TranscriptParser,
  TranscriptReadOptions,
  TranscriptSource,
} from '../../lib/transcript/types.ts';

const READ_CHUNK_BYTES = 64 * 1024;
const CURSOR_ANCHOR_BYTES = 512;

export interface TranscriptFileInfo {
  readonly identity: string;
  readonly size: number;
  readonly modifiedMs: number;
  readonly isFile: boolean;
}

export interface TranscriptWatchHandle {
  close(): void;
}

/** Node primitives injected into the transcript source for deterministic fault tests. */
export interface TranscriptFileRuntime {
  info(file: string): Promise<TranscriptFileInfo | undefined>;
  readAll(file: string): Promise<Uint8Array>;
  countNewlines(file: string, byteLength: number): Promise<number>;
  readTrailingLine(file: string, byteLength: number): Promise<Uint8Array>;
  readRange(file: string, byteOffset: number, byteLength: number): Promise<Uint8Array>;
  readFrom(file: string, byteOffset: number): Promise<Uint8Array>;
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

  async readAll(file: string): Promise<Uint8Array> {
    return await readFile(file);
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

  async readTrailingLine(file: string, byteLength: number): Promise<Uint8Array> {
    if (byteLength === 0) return new Uint8Array();
    const handle = await open(file, 'r');
    const chunks: Buffer[] = [];
    let position = byteLength;
    try {
      while (position > 0) {
        const length = Math.min(READ_CHUNK_BYTES, position);
        position -= length;
        const chunk = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(chunk, 0, length, position);
        const bytes = chunk.subarray(0, bytesRead);
        const newline = lastNewline(bytes);
        chunks.unshift(newline >= 0 ? bytes.subarray(newline + 1) : bytes);
        if (newline >= 0 || bytesRead < length) break;
      }
    } finally {
      await handle.close();
    }
    return Buffer.concat(chunks);
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

  async readFrom(file: string, byteOffset: number): Promise<Uint8Array> {
    const handle = await open(file, 'r');
    const chunks: Buffer[] = [];
    let position = byteOffset;
    try {
      while (true) {
        const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
        const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position);
        if (bytesRead === 0) break;
        chunks.push(chunk.subarray(0, bytesRead));
        position += bytesRead;
      }
    } finally {
      await handle.close();
    }
    return Buffer.concat(chunks);
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
  readonly anchor: Uint8Array;
  readonly nextLine: number;
  readonly modifiedMs?: number;
}

interface FollowReconcileResult {
  readonly state: FollowState;
  readonly batch?: TranscriptBatch;
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

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function advanceAnchor(anchor: Uint8Array, appended: Uint8Array): Uint8Array {
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
    'incomplete-line' | 'source-missing' | 'source-read-failed' | 'source-watch-failed'
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
): TranscriptBatch {
  return { harness: parser.harness, file, reset, cursor: cursorOf(state), events, issues };
}

function missingResult(parser: TranscriptParser, file: string, state: FollowState): FollowReconcileResult {
  const changed = state.availability !== 'missing';
  const next: FollowState = {
    initialized: true,
    seekToEnd: false,
    positioned: state.positioned,
    availability: 'missing',
    byteOffset: 0,
    partial: new Uint8Array(),
    anchor: new Uint8Array(),
    nextLine: 1,
  };
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
  if (info === undefined) return missingResult(parser, file, state);
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
    let partial: Uint8Array;
    try {
      [anchor, nextLine, partial] = await Promise.all([
        readAnchor(runtime, file, info.size),
        runtime.countNewlines(file, info.size).then(lines => lines + 1),
        runtime.readTrailingLine(file, info.size),
      ]);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return missingResult(parser, file, state);
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
      const next = { ...state, initialized: true, seekToEnd: false, availability: 'error' as const };
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
    if (afterInfo === undefined) return missingResult(parser, file, state);
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
    const next: FollowState = {
      initialized: true,
      seekToEnd: false,
      positioned: true,
      availability: 'present',
      identity: info.identity,
      byteOffset: info.size,
      partial,
      anchor,
      nextLine,
      modifiedMs: info.modifiedMs,
    };
    const issues =
      partial.byteLength > 0
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
    if (errorCode(error) === 'ENOENT') return missingResult(parser, file, state);
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

  let appended: Uint8Array;
  try {
    appended = await runtime.readFrom(file, base.byteOffset);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return missingResult(parser, file, state);
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

  const combined = Buffer.concat([Buffer.from(base.partial), Buffer.from(appended)]);
  const newline = lastNewline(combined);
  const complete = newline >= 0 ? combined.subarray(0, newline + 1) : Buffer.alloc(0);
  const partial = newline >= 0 ? combined.subarray(newline + 1) : combined;
  const parsed = parser.parse({
    text: complete.toString('utf8'),
    source: file,
    sessionId: options.sessionId,
    endOfInput: false,
    startLine: base.nextLine,
    startByteOffset: base.byteOffset - base.partial.byteLength,
  });
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
  if (afterInfo === undefined) return missingResult(parser, file, state);
  if (afterInfo.identity !== info.identity || afterInfo.size < byteOffset) {
    return { state };
  }
  const next: FollowState = {
    initialized: true,
    seekToEnd: false,
    positioned: true,
    availability: 'present',
    identity: info.identity,
    byteOffset,
    partial: Buffer.from(partial),
    anchor: advanceAnchor(base.anchor, appended),
    nextLine: base.nextLine + countLines(complete),
    modifiedMs: afterInfo.modifiedMs,
  };
  const issues = [...parsed.issues];
  if (partial.byteLength > 0 && (appended.byteLength > 0 || reset)) {
    issues.push(
      sourceIssue(parser, file, 'incomplete-line', 'trailing transcript line is incomplete', {
        line: next.nextLine,
        byteOffset: byteOffset - partial.byteLength,
        byteLength: partial.byteLength,
      }),
    );
  }

  const changed = !state.initialized || reset || appended.byteLength > 0 || state.availability !== 'present';
  return {
    state: next,
    ...(changed ? { batch: batchOf(parser, file, next, reset, parsed.events, issues) } : {}),
  };
}

/** Exact-path reader and live follower; harness behavior is supplied only through `TranscriptParser`. */
export class NodeTranscriptSource implements TranscriptSource {
  readonly harness: TranscriptParser['harness'];

  constructor(
    private readonly parser: TranscriptParser,
    private readonly runtime: TranscriptFileRuntime = new NodeTranscriptFileRuntime(),
  ) {
    this.harness = parser.harness;
  }

  async read(file: string, options: TranscriptReadOptions = {}): Promise<TranscriptBatch> {
    return await this.readConsistent(file, options, true);
  }

  private async readConsistent(
    file: string,
    options: TranscriptReadOptions,
    canRetryIdentityChange: boolean,
  ): Promise<TranscriptBatch> {
    let info: TranscriptFileInfo | undefined;
    try {
      info = await this.runtime.info(file);
    } catch {
      const state: FollowState = {
        initialized: true,
        seekToEnd: false,
        positioned: false,
        availability: 'error',
        byteOffset: 0,
        partial: new Uint8Array(),
        anchor: new Uint8Array(),
        nextLine: 1,
      };
      return batchOf(
        this.parser,
        file,
        state,
        false,
        [],
        [sourceIssue(this.parser, file, 'source-read-failed', 'transcript file metadata could not be read')],
      );
    }
    if (info === undefined)
      return missingResult(this.parser, file, {
        initialized: false,
        seekToEnd: false,
        positioned: false,
        availability: 'unknown',
        byteOffset: 0,
        partial: new Uint8Array(),
        anchor: new Uint8Array(),
        nextLine: 1,
      }).batch!;
    if (!info.isFile) {
      const state: FollowState = {
        initialized: true,
        seekToEnd: false,
        positioned: false,
        availability: 'error',
        identity: info.identity,
        byteOffset: 0,
        partial: new Uint8Array(),
        anchor: new Uint8Array(),
        nextLine: 1,
        modifiedMs: info.modifiedMs,
      };
      return batchOf(
        this.parser,
        file,
        state,
        false,
        [],
        [sourceIssue(this.parser, file, 'source-read-failed', 'transcript source is not a regular file')],
      );
    }

    let bytes: Uint8Array;
    try {
      bytes = await this.runtime.readAll(file);
    } catch (error) {
      const code = errorCode(error) === 'ENOENT' ? 'source-missing' : 'source-read-failed';
      const state: FollowState = {
        initialized: true,
        seekToEnd: false,
        positioned: false,
        availability: 'error',
        identity: info.identity,
        byteOffset: 0,
        partial: new Uint8Array(),
        anchor: new Uint8Array(),
        nextLine: 1,
        modifiedMs: info.modifiedMs,
      };
      return batchOf(
        this.parser,
        file,
        state,
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
      const state: FollowState = {
        initialized: true,
        seekToEnd: false,
        positioned: false,
        availability: 'error',
        identity: info.identity,
        byteOffset: 0,
        partial: new Uint8Array(),
        anchor: new Uint8Array(),
        nextLine: 1,
        modifiedMs: info.modifiedMs,
      };
      return batchOf(
        this.parser,
        file,
        state,
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
      return missingResult(this.parser, file, {
        initialized: true,
        seekToEnd: false,
        positioned: false,
        availability: 'error',
        byteOffset: 0,
        partial: new Uint8Array(),
        anchor: new Uint8Array(),
        nextLine: 1,
      }).batch!;
    }
    if (!afterInfo.isFile || afterInfo.identity !== info.identity || afterInfo.size < bytes.byteLength) {
      if (canRetryIdentityChange) return await this.readConsistent(file, options, false);
      const state: FollowState = {
        initialized: true,
        seekToEnd: false,
        positioned: false,
        availability: 'error',
        identity: afterInfo.identity,
        byteOffset: 0,
        partial: new Uint8Array(),
        anchor: new Uint8Array(),
        nextLine: 1,
        modifiedMs: afterInfo.modifiedMs,
      };
      return batchOf(
        this.parser,
        file,
        state,
        false,
        [],
        [sourceIssue(this.parser, file, 'source-read-failed', 'transcript changed while being read')],
      );
    }
    info = afterInfo;

    const text = Buffer.from(bytes).toString('utf8');
    const parsed = this.parser.parse({ text, source: file, sessionId: options.sessionId, endOfInput: true });
    const pending = parsed.remainder.length > 0 ? Buffer.from(bytes.subarray(lastNewline(bytes) + 1)) : Buffer.alloc(0);
    const pendingOffset = bytes.byteLength - pending.byteLength;
    const issues = parsed.issues.map(issue =>
      issue.code === 'truncated-json' && issue.byteOffset === pendingOffset
        ? { ...issue, byteLength: pending.byteLength }
        : issue,
    );
    const state: FollowState = {
      initialized: true,
      seekToEnd: false,
      positioned: true,
      availability: 'present',
      identity: info.identity,
      byteOffset: bytes.byteLength,
      partial: pending,
      anchor: advanceAnchor(new Uint8Array(), bytes),
      nextLine:
        countLines(bytes) + 1 + (bytes.byteLength > 0 && bytes.at(-1) !== 0x0a && pending.byteLength === 0 ? 1 : 0),
      modifiedMs: info.modifiedMs,
    };
    return batchOf(this.parser, file, state, false, parsed.events, issues);
  }

  async *follow(file: string, options: TranscriptFollowOptions = {}): AsyncGenerator<TranscriptBatch> {
    if (isAborted(options.signal)) return;
    const wake = createWakeController();
    const watchIssues: TranscriptIssue[] = [];
    let watcher: TranscriptWatchHandle | undefined;
    let watchFailed = false;
    let state: FollowState = {
      initialized: false,
      seekToEnd: options.startAt === 'end',
      positioned: false,
      availability: 'unknown',
      byteOffset: 0,
      partial: new Uint8Array(),
      anchor: new Uint8Array(),
      nextLine: 1,
    };
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
        const reconciled = await reconcileFollow(this.parser, this.runtime, file, options, state);
        if (isAborted(options.signal)) break;
        state = reconciled.state;
        if (reconciled.batch !== undefined || watchIssues.length > 0) {
          const batch = reconciled.batch ?? batchOf(this.parser, file, state, false);
          const issues = [...batch.issues, ...watchIssues.splice(0)];
          yield { ...batch, issues };
        }
        await wake.wait(pollIntervalMs, options.signal);
      }
    } finally {
      wake.close();
      watcher?.close();
    }
  }
}
