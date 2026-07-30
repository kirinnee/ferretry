import { afterEach, describe, it } from 'bun:test';
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  NodeTranscriptFileRuntime,
  NodeTranscriptSource,
  type TranscriptFileRuntime,
} from '../../../src/adapters/transcript/file-source.ts';
import { ClaudeTranscriptParser } from '../../../src/lib/transcript/claude.ts';
import type { TranscriptBatch } from '../../../src/lib/transcript/types.ts';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ferretry-transcript-'));
  temporaryDirectories.push(directory);
  return directory;
}

function userRecord(text: string): Record<string, unknown> {
  return {
    type: 'user',
    sessionId: '11111111-1111-4111-8111-111111111111',
    uuid: `record-${text.replaceAll(' ', '-')}`,
    timestamp: '2026-01-02T03:04:05.000Z',
    message: { role: 'user', content: text },
  };
}

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

async function nextResult(
  iterator: AsyncIterator<TranscriptBatch>,
  label: string,
  timeoutMs = 2_000,
): Promise<IteratorResult<TranscriptBatch>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
  });
  try {
    return await Promise.race([iterator.next(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function nextBatch(iterator: AsyncIterator<TranscriptBatch>, label: string): Promise<TranscriptBatch> {
  const result = await nextResult(iterator, label);
  if (result.done) throw new Error(`iterator finished before ${label}`);
  return result.value;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('NodeTranscriptSource read', () => {
  it('should read and parse the synthetic fixture through the exact file path', async () => {
    // Arrange
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser());
    const input = join(import.meta.dir, '../../fixtures/transcript/claude.jsonl');

    // Act
    const actual = await subject.read(input);

    // Assert
    should(actual.events).have.length(13);
    should(actual.issues).have.length(0);
    should(actual.cursor.byteOffset).be.above(0);
    should(actual.cursor.pendingBytes).equal(0);
  });

  it('should return structured source and truncation issues instead of throwing', async () => {
    // Arrange
    const temporary = await temporaryDirectory();
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser());
    const missing = join(temporary, 'missing.jsonl');
    const directory = join(temporary, 'not-a-file');
    const truncated = join(temporary, 'truncated.jsonl');
    await mkdir(directory);
    await writeFile(truncated, '{"type":"user"');

    // Act
    const actualMissing = await subject.read(missing);
    const actualDirectory = await subject.read(directory);
    const actualTruncated = await subject.read(truncated);

    // Assert
    should(actualMissing.issues.map(issue => issue.code)).deepEqual(['source-missing']);
    should(actualDirectory.issues.map(issue => issue.code)).deepEqual(['source-read-failed']);
    should(actualTruncated.issues.map(issue => issue.code)).deepEqual(['truncated-json']);
    should(actualTruncated.cursor.pendingBytes).be.above(0);
  });
});

describe('NodeTranscriptSource follow', () => {
  it('should retain partial bytes, continue after interleaved JSON, and emit later records once', async () => {
    // Arrange
    const temporary = await temporaryDirectory();
    const file = join(temporary, 'transcript.jsonl');
    await writeFile(file, jsonl(userRecord('first complete record')));
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser());
    const iterator = subject.follow(file, { pollIntervalMs: 20 })[Symbol.asyncIterator]();

    try {
      // Act
      const initial = await nextBatch(iterator, 'initial record');
      const partialLine = JSON.stringify(userRecord('second partial record'));
      await appendFile(file, partialLine);
      const partial = await nextBatch(iterator, 'partial record');
      await appendFile(file, '\n');
      const completed = await nextBatch(iterator, 'completed partial record');
      await appendFile(file, `{interleaved}\n${jsonl(userRecord('valid after interleaving'))}`);
      const malformed = await nextBatch(iterator, 'valid record after malformed record');

      // Assert
      should(initial.events[0]).containDeep({ kind: 'message', text: 'first complete record' });
      should(partial.events).have.length(0);
      should(partial.issues.map(issue => issue.code)).deepEqual(['incomplete-line']);
      should(partial.cursor.pendingBytes).equal(Buffer.byteLength(partialLine));
      should(completed.events[0]).containDeep({ kind: 'message', text: 'second partial record' });
      should(completed.cursor.pendingBytes).equal(0);
      should(malformed.issues.map(issue => issue.code)).deepEqual(['invalid-json']);
      should(malformed.events[0]).containDeep({ kind: 'message', text: 'valid after interleaving' });
    } finally {
      await iterator.return?.(undefined);
    }
  });

  it('should signal cursor resets for truncation and atomic replacement', async () => {
    // Arrange
    const temporary = await temporaryDirectory();
    const file = join(temporary, 'transcript.jsonl');
    await writeFile(file, jsonl(userRecord('a deliberately long initial record')));
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser());
    const iterator = subject.follow(file, { pollIntervalMs: 20 })[Symbol.asyncIterator]();

    try {
      await nextBatch(iterator, 'initial record');

      // Act
      await writeFile(file, jsonl(userRecord('short')));
      const truncated = await nextBatch(iterator, 'truncation reset');
      await rename(file, `${file}.previous`);
      await writeFile(file, jsonl(userRecord('replacement')));
      const replaced = await nextBatch(iterator, 'replacement reset');

      // Assert
      should(truncated.reset).be.true();
      should(truncated.events[0]).containDeep({ text: 'short' });
      should(replaced.reset).be.true();
      should(replaced.events[0]).containDeep({ text: 'replacement' });
    } finally {
      await iterator.return?.(undefined);
    }
  });

  it('should follow a file that appears later and wake through the directory watcher', async () => {
    // Arrange
    const temporary = await temporaryDirectory();
    const file = join(temporary, 'later.jsonl');
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser());
    const iterator = subject.follow(file, { pollIntervalMs: 10_000 })[Symbol.asyncIterator]();

    try {
      const missing = await nextBatch(iterator, 'missing source');

      // Act
      await writeFile(file, jsonl(userRecord('appeared later')));
      const appeared = await nextBatch(iterator, 'directory watch wake');

      // Assert
      should(missing.issues.map(issue => issue.code)).deepEqual(['source-missing']);
      should(appeared.events[0]).containDeep({ text: 'appeared later' });
    } finally {
      await iterator.return?.(undefined);
    }
  });

  it('should support starting at the current end without replaying old records', async () => {
    // Arrange
    const temporary = await temporaryDirectory();
    const file = join(temporary, 'transcript.jsonl');
    await writeFile(file, jsonl(userRecord('already present')));
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser());
    const iterator = subject.follow(file, { startAt: 'end', pollIntervalMs: 20 })[Symbol.asyncIterator]();

    try {
      const initial = await nextBatch(iterator, 'initial end cursor');

      // Act
      await appendFile(file, jsonl(userRecord('new append')));
      const appended = await nextBatch(iterator, 'new append');

      // Assert
      should(initial.events).have.length(0);
      should(appended.events).have.length(1);
      should(appended.events[0]).containDeep({ text: 'new append' });
    } finally {
      await iterator.return?.(undefined);
    }
  });

  it('should finish immediately when already aborted and report a real watch failure as a value', async () => {
    // Arrange
    const temporary = await temporaryDirectory();
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser());
    const controller = new AbortController();
    controller.abort();
    const aborted = subject
      .follow(join(temporary, 'aborted.jsonl'), { signal: controller.signal })
      [Symbol.asyncIterator]();
    const unwatched = subject
      .follow(join(temporary, 'absent-parent', 'missing.jsonl'), { pollIntervalMs: 20 })
      [Symbol.asyncIterator]();

    try {
      // Act
      const abortedResult = await nextResult(aborted, 'aborted iterator');
      const unwatchedResult = await nextBatch(unwatched, 'watch failure');

      // Assert
      should(abortedResult.done).be.true();
      should(unwatchedResult.issues.map(issue => issue.code)).deepEqual(['source-missing', 'source-watch-failed']);
    } finally {
      await unwatched.return?.(undefined);
    }
  });

  it('should surface an asynchronous directory-watch error without stopping polling', async () => {
    // Arrange
    const temporary = await temporaryDirectory();
    const file = join(temporary, 'transcript.jsonl');
    await writeFile(file, jsonl(userRecord('initial')));
    const nodeRuntime = new NodeTranscriptFileRuntime();
    let failWatch: (() => void) | undefined;
    const runtime: TranscriptFileRuntime = {
      info: file => nodeRuntime.info(file),
      readAll: file => nodeRuntime.readAll(file),
      readFrom: (file, byteOffset) => nodeRuntime.readFrom(file, byteOffset),
      watch(_directory, _onChange, onError) {
        failWatch = () => onError(new Error('synthetic watch failure'));
        return { close() {} };
      },
    };
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser(), runtime);
    const iterator = subject.follow(file, { pollIntervalMs: 10_000 })[Symbol.asyncIterator]();

    try {
      await nextBatch(iterator, 'initial record');

      // Act
      failWatch?.();
      const actual = await nextBatch(iterator, 'asynchronous watch failure');

      // Assert
      should(actual.events).have.length(0);
      should(actual.issues.map(issue => issue.code)).deepEqual(['source-watch-failed']);
    } finally {
      await iterator.return?.(undefined);
    }
  });
});

describe('NodeTranscriptFileRuntime', () => {
  it('should read only bytes after the requested offset', async () => {
    // Arrange
    const temporary = await temporaryDirectory();
    const file = join(temporary, 'bytes.txt');
    await writeFile(file, 'prefix-suffix');
    const subject = new NodeTranscriptFileRuntime();

    // Act
    const actual = await subject.readFrom(file, Buffer.byteLength('prefix-'));

    // Assert
    should(Buffer.from(actual).toString('utf8')).equal('suffix');
  });

  it('should map missing metadata to undefined while propagating other runtime faults through the source', async () => {
    // Arrange
    const subject = new NodeTranscriptFileRuntime();
    const missing = join(await temporaryDirectory(), 'missing.jsonl');
    const fault: TranscriptFileRuntime = {
      async info() {
        throw new Error('synthetic metadata fault');
      },
      async readAll() {
        return new Uint8Array();
      },
      async readFrom() {
        return new Uint8Array();
      },
      watch() {
        return { close() {} };
      },
    };

    // Act
    const actualMissing = await subject.info(missing);
    const actualFault = await new NodeTranscriptSource(new ClaudeTranscriptParser(), fault).read(missing);

    // Assert
    should(actualMissing).be.undefined();
    should(actualFault.issues.map(issue => issue.code)).deepEqual(['source-read-failed']);
  });
});
