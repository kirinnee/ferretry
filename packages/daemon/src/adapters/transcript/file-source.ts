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
  readonly availability: 'unknown' | 'present' | 'missing' | 'error';
  readonly identity?: string;
  readonly byteOffset: number;
  readonly partial: Uint8Array;
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
    availability: 'missing',
    byteOffset: 0,
    partial: new Uint8Array(),
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
            state.availability === 'present',
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
    const next = { ...state, initialized: true, availability: 'error' as const };
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

  if (!state.initialized && options.startAt === 'end') {
    const next: FollowState = {
      initialized: true,
      availability: 'present',
      identity: info.identity,
      byteOffset: info.size,
      partial: new Uint8Array(),
      nextLine: 1,
      modifiedMs: info.modifiedMs,
    };
    return { state: next, batch: batchOf(parser, file, next, false) };
  }

  const reset =
    state.availability === 'present' &&
    (state.identity !== info.identity ||
      info.size < state.byteOffset ||
      (info.size === state.byteOffset && state.byteOffset > 0 && state.modifiedMs !== info.modifiedMs));
  const base: FollowState = reset
    ? {
        initialized: true,
        availability: 'present',
        identity: info.identity,
        byteOffset: 0,
        partial: new Uint8Array(),
        nextLine: 1,
        modifiedMs: info.modifiedMs,
      }
    : {
        ...state,
        initialized: true,
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
  });
  const byteOffset = base.byteOffset + appended.byteLength;
  const afterInfo = await runtime.info(file).catch(() => undefined);
  const next: FollowState = {
    initialized: true,
    availability: 'present',
    identity: info.identity,
    byteOffset,
    partial: Buffer.from(partial),
    nextLine: base.nextLine + countLines(complete),
    modifiedMs: afterInfo?.identity === info.identity ? afterInfo.modifiedMs : info.modifiedMs,
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
    let info: TranscriptFileInfo | undefined;
    try {
      info = await this.runtime.info(file);
    } catch {
      const state: FollowState = {
        initialized: true,
        availability: 'error',
        byteOffset: 0,
        partial: new Uint8Array(),
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
        availability: 'unknown',
        byteOffset: 0,
        partial: new Uint8Array(),
        nextLine: 1,
      }).batch!;
    if (!info.isFile) {
      const state: FollowState = {
        initialized: true,
        availability: 'error',
        identity: info.identity,
        byteOffset: 0,
        partial: new Uint8Array(),
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
        availability: 'error',
        identity: info.identity,
        byteOffset: 0,
        partial: new Uint8Array(),
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

    const text = Buffer.from(bytes).toString('utf8');
    const parsed = this.parser.parse({ text, source: file, sessionId: options.sessionId, endOfInput: true });
    const state: FollowState = {
      initialized: true,
      availability: 'present',
      identity: info.identity,
      byteOffset: bytes.byteLength,
      partial: Buffer.from(parsed.remainder),
      nextLine: countLines(bytes) + 1,
      modifiedMs: info.modifiedMs,
    };
    return batchOf(this.parser, file, state, false, parsed.events, parsed.issues);
  }

  async *follow(file: string, options: TranscriptFollowOptions = {}): AsyncGenerator<TranscriptBatch> {
    if (isAborted(options.signal)) return;
    const wake = createWakeController();
    const watchIssues: TranscriptIssue[] = [];
    let watcher: TranscriptWatchHandle | undefined;
    let watchFailed = false;
    let state: FollowState = {
      initialized: false,
      availability: 'unknown',
      byteOffset: 0,
      partial: new Uint8Array(),
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
