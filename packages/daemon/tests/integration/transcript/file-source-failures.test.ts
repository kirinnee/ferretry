import { describe, it } from 'bun:test';
import should from 'should';
import {
  NodeTranscriptSource,
  type BoundedTranscriptRead,
  type TranscriptFileInfo,
  type TranscriptFileRuntime,
} from '../../../src/adapters/transcript/file-source.ts';
import { ClaudeTranscriptParser } from '../../../src/lib/transcript/claude.ts';
import type { TranscriptBatch } from '../../../src/lib/transcript/types.ts';

const FILE = '/synthetic/transcript.jsonl';
const clock = { now: () => '2026-01-02T03:04:05.000Z' };

function userLine(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    sessionId: '11111111-1111-4111-8111-111111111111',
    uuid: `record-${text.replaceAll(' ', '-')}`,
    timestamp: '2026-01-02T03:04:05.000Z',
    message: { role: 'user', content: text },
  })}\n`;
}

function failure(code?: string): Error {
  return Object.assign(new Error('synthetic fault'), code === undefined ? {} : { code });
}

/**
 * An in-memory file behind the runtime port, with one hook per port call so a test can change the
 * file, or fail a call, at an exact point of the source's own call sequence rather than on a timer.
 */
class MemoryRuntime implements TranscriptFileRuntime {
  content = new Uint8Array();
  identity = 'file-a';
  isFile = true;
  infoCalls = 0;
  readFromCalls = 0;
  onInfo: (call: number, runtime: MemoryRuntime) => TranscriptFileInfo | undefined | 'real' = () => 'real';
  failReadFrom: Error | undefined;
  failCountNewlines: Error | undefined;
  failReadTrailingLine: Error | undefined;
  failReadRange: Error | undefined;
  trailingTruncatedAt: number | undefined;

  set(text: string): void {
    this.content = Buffer.from(text);
  }

  append(text: string): void {
    this.content = Buffer.concat([this.content, Buffer.from(text)]);
  }

  private describe(): TranscriptFileInfo {
    return { identity: this.identity, size: this.content.byteLength, modifiedMs: this.infoCalls, isFile: this.isFile };
  }

  async info(): Promise<TranscriptFileInfo | undefined> {
    this.infoCalls += 1;
    const scripted = this.onInfo(this.infoCalls, this);
    return scripted === 'real' ? this.describe() : scripted;
  }

  async countNewlines(_file: string, byteLength: number): Promise<number> {
    if (this.failCountNewlines !== undefined) throw this.failCountNewlines;
    return this.content.subarray(0, byteLength).filter(byte => byte === 0x0a).length;
  }

  async readTrailingLine(_file: string, byteLength: number, byteLimit: number): Promise<BoundedTranscriptRead> {
    if (this.failReadTrailingLine !== undefined) throw this.failReadTrailingLine;
    const head = Buffer.from(this.content.subarray(0, byteLength));
    const trailing = head.subarray(head.lastIndexOf(0x0a) + 1);
    return trailing.byteLength > byteLimit
      ? { bytes: trailing.subarray(trailing.byteLength - byteLimit), truncated: true }
      : { bytes: trailing, truncated: false };
  }

  async readRange(_file: string, byteOffset: number, byteLength: number): Promise<Uint8Array> {
    if (this.failReadRange !== undefined) throw this.failReadRange;
    return this.content.subarray(byteOffset, byteOffset + byteLength);
  }

  async readFrom(_file: string, byteOffset: number): Promise<BoundedTranscriptRead> {
    this.readFromCalls += 1;
    if (this.failReadFrom !== undefined) throw this.failReadFrom;
    return { bytes: this.content.subarray(byteOffset), truncated: false };
  }

  watch(): { close(): void } {
    return { close() {} };
  }
}

function sourceOver(runtime: MemoryRuntime, maxPendingBytes?: number): NodeTranscriptSource {
  return new NodeTranscriptSource(
    new ClaudeTranscriptParser(),
    runtime,
    clock,
    maxPendingBytes === undefined ? {} : { maxPendingBytes },
  );
}

/**
 * Follows until the file's `info` hook aborts, and returns every batch delivered before that.
 *
 * The abort is raised from inside the port, at a call number the test names, so the run ends on the
 * source's own progress and not on a clock; the guard only turns a never-ending follow into a failure.
 */
async function followUntilStopped(
  subject: NodeTranscriptSource,
  runtime: MemoryRuntime,
  options: { readonly startAt?: 'end'; readonly stopAtInfoCall: number },
): Promise<readonly TranscriptBatch[]> {
  const controller = new AbortController();
  const script = runtime.onInfo;
  runtime.onInfo = (call, self) => {
    if (call >= options.stopAtInfoCall) controller.abort();
    return script(call, self);
  };
  const iterator = subject
    .follow(FILE, {
      pollIntervalMs: 10,
      signal: controller.signal,
      ...(options.startAt === undefined ? {} : { startAt: options.startAt }),
    })
    [Symbol.asyncIterator]();
  const batches: TranscriptBatch[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('the follow never stopped')), 5_000);
  });
  try {
    for (;;) {
      const result = await Promise.race([iterator.next(), guard]);
      if (result.done) return batches;
      batches.push(result.value);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

function issuesOf(batches: readonly TranscriptBatch[]): readonly { code: string; message: string }[] {
  return batches.flatMap(batch => batch.issues.map(issue => ({ code: issue.code, message: issue.message })));
}

describe('NodeTranscriptSource read when the file misbehaves', () => {
  it('should say the file is gone when it vanishes between its metadata and its bytes', async () => {
    // Arrange
    const runtime = new MemoryRuntime();
    runtime.set(userLine('hello'));
    runtime.failReadFrom = failure('ENOENT');

    // Act
    const actual = await sourceOver(runtime).read(FILE);

    // Assert
    should(issuesOf([actual])).deepEqual([{ code: 'source-missing', message: 'transcript file is not available' }]);
    should(actual.events).be.empty();
  });

  it('should report unreadable bytes, not a missing file, for any other read failure', async () => {
    // Arrange
    const runtime = new MemoryRuntime();
    runtime.set(userLine('hello'));
    runtime.failReadFrom = failure();

    // Act
    const actual = await sourceOver(runtime).read(FILE);

    // Assert
    should(issuesOf([actual])).deepEqual([
      { code: 'source-read-failed', message: 'transcript bytes could not be read' },
    ]);
  });

  it('should report that it could not verify the file when the metadata check after the read fails', async () => {
    // Arrange
    const runtime = new MemoryRuntime();
    runtime.set(userLine('hello'));
    runtime.onInfo = call => {
      if (call === 2) throw failure();
      return 'real';
    };

    // Act
    const actual = await sourceOver(runtime).read(FILE);

    // Assert
    should(issuesOf([actual])).deepEqual([
      { code: 'source-read-failed', message: 'transcript metadata could not be verified after reading' },
    ]);
    should(actual.events).be.empty();
  });

  it('should say the file is gone when it disappears while being read', async () => {
    // Arrange
    const runtime = new MemoryRuntime();
    runtime.set(userLine('hello'));
    runtime.onInfo = call => (call === 2 ? undefined : 'real');

    // Act
    const actual = await sourceOver(runtime).read(FILE);

    // Assert
    should(issuesOf([actual])).deepEqual([{ code: 'source-missing', message: 'transcript file is not available' }]);
  });

  it('should retry once when the file is replaced mid-read, then refuse bytes from a file that keeps changing', async () => {
    // Arrange: every metadata check after a read sees a different file than the one the read began on.
    const runtime = new MemoryRuntime();
    runtime.set(userLine('hello'));
    runtime.onInfo = (call, self) => {
      self.identity = `file-${call}`;
      return 'real';
    };

    // Act
    const actual = await sourceOver(runtime).read(FILE);

    // Assert
    should(runtime.readFromCalls).equal(2);
    should(issuesOf([actual])).deepEqual([
      { code: 'source-read-failed', message: 'transcript changed while being read' },
    ]);
    should(actual.events).be.empty();
  });
});

describe('NodeTranscriptSource follow when the file misbehaves', () => {
  it('should report a missing file once and stay quiet while it stays missing', async () => {
    // Arrange
    const runtime = new MemoryRuntime();
    runtime.onInfo = () => undefined;

    // Act
    const actual = await followUntilStopped(sourceOver(runtime), runtime, { stopAtInfoCall: 4 });

    // Assert
    should(issuesOf(actual)).deepEqual([{ code: 'source-missing', message: 'transcript file is not available' }]);
  });

  it('should report a path that is not a regular file once, then stay quiet', async () => {
    // Arrange
    const runtime = new MemoryRuntime();
    runtime.isFile = false;

    // Act
    const actual = await followUntilStopped(sourceOver(runtime), runtime, { stopAtInfoCall: 4 });

    // Assert
    should(issuesOf(actual)).deepEqual([
      { code: 'source-read-failed', message: 'transcript source is not a regular file' },
    ]);
  });

  it('should report that no cursor could be set at the end of a file it cannot read the end of', async () => {
    // Arrange / Act: whichever of the three reads that locate the end fails, the follower says the same thing.
    const outcomes = await Promise.all(
      (['failReadRange', 'failCountNewlines', 'failReadTrailingLine'] as const).map(async fault => {
        const runtime = new MemoryRuntime();
        runtime.set(userLine('hello'));
        runtime[fault] = failure();
        return await followUntilStopped(sourceOver(runtime), runtime, { startAt: 'end', stopAtInfoCall: 2 });
      }),
    );

    // Assert
    for (const batches of outcomes) {
      should(issuesOf(batches)).deepEqual([
        { code: 'source-read-failed', message: 'transcript cursor could not be established' },
      ]);
    }
  });

  it('should report that the cursor could not be verified when the bytes behind it cannot be read back', async () => {
    // Arrange: a first poll positions the cursor mid-file; the next one must re-read the bytes before it.
    const runtime = new MemoryRuntime();
    runtime.set(userLine('first'));
    runtime.onInfo = call => {
      if (call === 3) runtime.failReadRange = failure();
      return 'real';
    };

    // Act
    const actual = await followUntilStopped(sourceOver(runtime), runtime, { stopAtInfoCall: 4 });

    // Assert
    should(actual).have.length(2);
    should(actual[0]?.events).have.length(1);
    should(issuesOf(actual)).deepEqual([
      { code: 'source-read-failed', message: 'transcript cursor could not be verified' },
    ]);
  });

  it('should report unreadable bytes when reading the appended bytes fails for a reason other than absence', async () => {
    // Arrange
    const runtime = new MemoryRuntime();
    runtime.set(userLine('first'));
    runtime.failReadFrom = failure();

    // Act
    const actual = await followUntilStopped(sourceOver(runtime), runtime, { stopAtInfoCall: 2 });

    // Assert
    should(issuesOf(actual)).deepEqual([{ code: 'source-read-failed', message: 'transcript bytes could not be read' }]);
  });

  it('should report that it could not verify the file when the metadata check after a read fails', async () => {
    // Arrange
    const runtime = new MemoryRuntime();
    runtime.set(userLine('first'));
    runtime.onInfo = call => {
      if (call === 2) throw failure();
      return 'real';
    };

    // Act
    const actual = await followUntilStopped(sourceOver(runtime), runtime, { stopAtInfoCall: 3 });

    // Assert
    should(issuesOf(actual)).deepEqual([
      { code: 'source-read-failed', message: 'transcript metadata could not be verified after reading' },
    ]);
  });

  it('should drop the tail of an oversized trailing record and resume on the next whole record', async () => {
    // Arrange: the file ends in an unterminated record far larger than the pending limit.
    const runtime = new MemoryRuntime();
    runtime.set('x'.repeat(20));
    runtime.onInfo = call => {
      // The tail keeps arriving with no terminator, then the record ends and a whole one follows.
      if (call === 3) runtime.append('y'.repeat(5));
      if (call === 5) runtime.append(`zzz\n${userLine('after the skip')}`);
      return 'real';
    };

    // Act
    const actual = await followUntilStopped(sourceOver(runtime, 8), runtime, { startAt: 'end', stopAtInfoCall: 7 });

    // Assert
    const events = actual.flatMap(batch => batch.events);
    should(events).have.length(1);
    should(events[0]).containDeep({ kind: 'message', text: 'after the skip' });
    should(issuesOf(actual).map(issue => issue.code)).deepEqual(['oversized-record']);
  });
});
