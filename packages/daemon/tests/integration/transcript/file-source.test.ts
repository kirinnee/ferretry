import { afterEach, describe, it } from 'bun:test';
import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  DEFAULT_MAX_PENDING_BYTES,
  DEFAULT_MAX_READ_BYTES,
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

/** A record whose serialized length is tunable to the byte, for chunk-boundary cases. */
function paddedRecord(text: string, padding: number): Record<string, unknown> {
  return { ...userRecord(text), message: { role: 'user', content: `${text}${'x'.repeat(padding)}` } };
}

function queueRemoval(text: string, timestamp: string): Record<string, unknown> {
  return { type: 'queue-operation', operation: 'remove', content: text, timestamp };
}

function queuedCommand(text: string, timestamp: string): Record<string, unknown> {
  return {
    type: 'attachment',
    uuid: `queued-${text.replaceAll(' ', '-')}`,
    timestamp,
    attachment: {
      type: 'queued_command',
      prompt: text,
      commandMode: 'prompt',
      origin: { kind: 'human' },
      timestamp,
    },
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
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser(), new NodeTranscriptFileRuntime(), {
      now: () => '2026-01-02T03:04:12.000Z',
    });
    const input = join(import.meta.dir, '../../fixtures/transcript/claude.jsonl');

    // Act
    const actual = await subject.read(input);

    // Assert
    should(actual.events).have.length(13);
    should(actual.observedInputs.map(input => input.text)).deepEqual([
      'Please inspect the synthetic fixture.',
      'The fixture includes an image.',
      'Continue with the synthetic case.',
    ]);
    should(actual.observedInputs[2]?.observedAt).equal('2026-01-02T03:04:12.000Z');
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

  it('should retain the exact raw byte length of a torn UTF-8 tail', async () => {
    // Arrange
    const temporary = await temporaryDirectory();
    const prefix = Buffer.from('{"type":"user","message":{"role":"user","content":"');
    const codePoint = Buffer.from('😀');
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser());

    for (const retainedBytes of [1, 2, 3]) {
      const file = join(temporary, `torn-${retainedBytes}.jsonl`);
      const raw = Buffer.concat([prefix, codePoint.subarray(0, retainedBytes)]);
      await writeFile(file, raw);

      // Act
      const actual = await subject.read(file);

      // Assert
      should(actual.issues).containDeep([{ code: 'truncated-json', byteOffset: 0, byteLength: raw.byteLength }]);
      should(actual.cursor.byteOffset).equal(raw.byteLength);
      should(actual.cursor.pendingBytes).equal(raw.byteLength);
    }
  });

  it('should retry a one-shot read when the path changes identity', async () => {
    // Arrange
    const bytes = Buffer.from(jsonl(userRecord('stable one-shot replacement')));
    let infoCalls = 0;
    const runtime: TranscriptFileRuntime = {
      async info() {
        infoCalls += 1;
        return {
          identity: infoCalls === 1 ? 'old-identity' : 'new-identity',
          size: bytes.byteLength,
          modifiedMs: infoCalls,
          isFile: true,
        };
      },
      async countNewlines() {
        return 1;
      },
      async readTrailingLine() {
        return { bytes: new Uint8Array(), truncated: false };
      },
      async readRange(_file, byteOffset, byteLength) {
        return bytes.subarray(byteOffset, byteOffset + byteLength);
      },
      async readFrom(_file, byteOffset) {
        return { bytes: bytes.subarray(byteOffset), truncated: false };
      },
      watch() {
        return { close() {} };
      },
    };
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser(), runtime);

    // Act
    const actual = await subject.read('/synthetic/transcript.jsonl');

    // Assert
    should(actual.cursor.identity).equal('new-identity');
    should(actual.events).containDeep([{ kind: 'message', text: 'stable one-shot replacement' }]);
    should(infoCalls).equal(4);
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
      should(initial.observedInputs.map(input => input.text)).deepEqual(['first complete record']);
      should(partial.events).have.length(0);
      should(partial.observedInputs).be.empty();
      should(partial.issues.map(issue => issue.code)).deepEqual(['incomplete-line']);
      should(partial.cursor.pendingBytes).equal(Buffer.byteLength(partialLine));
      should(completed.events[0]).containDeep({ kind: 'message', text: 'second partial record' });
      should(completed.observedInputs.map(input => input.text)).deepEqual(['second partial record']);
      should(completed.cursor.pendingBytes).equal(0);
      should(malformed.issues.map(issue => issue.code)).deepEqual(['invalid-json']);
      should(malformed.issues[0]?.byteOffset).equal(completed.cursor.byteOffset);
      should(malformed.events[0]).containDeep({ kind: 'message', text: 'valid after interleaving' });
      should(malformed.observedInputs.map(input => input.text)).deepEqual(['valid after interleaving']);
    } finally {
      await iterator.return?.(undefined);
    }
  });

  it('should carry queue-removal state across appends and emit delivery proof separately from history', async () => {
    // Arrange
    const temporary = await temporaryDirectory();
    const file = join(temporary, 'queued.jsonl');
    await writeFile(file, '');
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser(), new NodeTranscriptFileRuntime(), {
      now: () => '2026-01-02T03:04:20.000Z',
    });
    const iterator = subject.follow(file, { pollIntervalMs: 20 })[Symbol.asyncIterator]();

    try {
      await nextBatch(iterator, 'empty initial transcript');
      const prompt = 'Queued synthetic prompt.';
      await appendFile(file, jsonl(queueRemoval(prompt, '2026-01-02T03:04:10.000Z')));
      const removal = await nextBatch(iterator, 'queue removal');

      // Act
      await appendFile(file, jsonl(queuedCommand(prompt, '2026-01-02T03:04:08.000Z')));
      const drained = await nextBatch(iterator, 'queued prompt drain');

      // Assert
      should(removal.events).be.empty();
      should(removal.observedInputs).be.empty();
      should(drained.events).containDeep([{ kind: 'message', text: prompt, inputSource: 'native-queue' }]);
      should(drained.observedInputs).containDeep([
        {
          text: prompt,
          proof: 'native-queue-drain',
          observedAt: '2026-01-02T03:04:10.000Z',
          originatedAt: '2026-01-02T03:04:08.000Z',
        },
      ]);
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

  it('should reset after a same-file rewrite that grows beyond the previous cursor', async () => {
    // Arrange
    const temporary = await temporaryDirectory();
    const file = join(temporary, 'transcript.jsonl');
    await writeFile(file, jsonl(userRecord('short initial record')));
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser());
    const iterator = subject.follow(file, { pollIntervalMs: 20 })[Symbol.asyncIterator]();

    try {
      await nextBatch(iterator, 'initial record');
      const replacement = `${jsonl(userRecord(`replacement ${'long '.repeat(40)}`))}${jsonl(
        userRecord('second replacement record'),
      )}`;

      // Act
      await writeFile(file, replacement);
      const actual = await nextBatch(iterator, 'same-file rewrite');

      // Assert
      should(actual.reset).be.true();
      should(actual.issues).be.empty();
      should(actual.events.map(event => (event.kind === 'message' ? event.text : undefined))).deepEqual([
        `replacement ${'long '.repeat(40)}`,
        'second replacement record',
      ]);
    } finally {
      await iterator.return?.(undefined);
    }
  });

  it('should revalidate the cursor after a transient metadata failure', async () => {
    // Arrange
    const temporary = await temporaryDirectory();
    const file = join(temporary, 'transcript.jsonl');
    await writeFile(file, jsonl(userRecord('initial before metadata failure')));
    const nodeRuntime = new NodeTranscriptFileRuntime();
    let failMetadata = false;
    const runtime: TranscriptFileRuntime = {
      async info(file) {
        if (failMetadata) {
          failMetadata = false;
          throw new Error('synthetic metadata failure');
        }
        return await nodeRuntime.info(file);
      },
      countNewlines: (file, byteLength) => nodeRuntime.countNewlines(file, byteLength),
      readTrailingLine: (file, byteLength, byteLimit) => nodeRuntime.readTrailingLine(file, byteLength, byteLimit),
      readRange: (file, byteOffset, byteLength) => nodeRuntime.readRange(file, byteOffset, byteLength),
      readFrom: (file, byteOffset, byteLimit) => nodeRuntime.readFrom(file, byteOffset, byteLimit),
      watch() {
        return { close() {} };
      },
    };
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser(), runtime);
    const iterator = subject.follow(file, { pollIntervalMs: 20 })[Symbol.asyncIterator]();

    try {
      await nextBatch(iterator, 'initial record');
      failMetadata = true;
      await writeFile(file, jsonl(userRecord('replacement after metadata failure')));

      // Act
      const failed = await nextBatch(iterator, 'metadata failure');
      const recovered = await nextBatch(iterator, 'metadata recovery');

      // Assert
      should(failed.issues.map(issue => issue.code)).deepEqual(['source-read-failed']);
      should(recovered.reset).be.true();
      should(recovered.events).containDeep([{ kind: 'message', text: 'replacement after metadata failure' }]);
    } finally {
      await iterator.return?.(undefined);
    }
  });

  it('should discard bytes read across an identity change instead of emitting them twice', async () => {
    // Arrange
    const bytes = Buffer.from(jsonl(userRecord('replacement read once')));
    let infoCalls = 0;
    const runtime: TranscriptFileRuntime = {
      async info() {
        infoCalls += 1;
        return {
          identity: infoCalls === 1 ? 'old-identity' : 'new-identity',
          size: bytes.byteLength,
          modifiedMs: infoCalls,
          isFile: true,
        };
      },
      async countNewlines() {
        return 1;
      },
      async readTrailingLine() {
        return { bytes: new Uint8Array(), truncated: false };
      },
      async readRange(_file, byteOffset, byteLength) {
        return bytes.subarray(byteOffset, byteOffset + byteLength);
      },
      async readFrom(_file, byteOffset) {
        return { bytes: bytes.subarray(byteOffset), truncated: false };
      },
      watch() {
        return { close() {} };
      },
    };
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser(), runtime);
    const iterator = subject.follow('/synthetic/transcript.jsonl', { pollIntervalMs: 10 })[Symbol.asyncIterator]();

    try {
      // Act
      const actual = await nextBatch(iterator, 'stable replacement');

      // Assert
      should(actual.cursor.identity).equal('new-identity');
      should(actual.events).containDeep([{ kind: 'message', text: 'replacement read once' }]);
      should(actual.events).have.length(1);
    } finally {
      await iterator.return?.(undefined);
    }
  });

  it('should not let a discarded identity-race read mutate delivery-proof state', async () => {
    // Arrange
    const prompt = 'Replacement queue prompt.';
    const oldBytes = Buffer.from(jsonl(queueRemoval(prompt, '2026-01-02T03:04:10.000Z')));
    const newBytes = Buffer.from(jsonl(queuedCommand(prompt, '2026-01-02T03:04:08.000Z')));
    let infoCalls = 0;
    let readCalls = 0;
    const runtime: TranscriptFileRuntime = {
      async info() {
        infoCalls += 1;
        const initial = infoCalls === 1;
        return {
          identity: initial ? 'old-identity' : 'new-identity',
          size: initial ? oldBytes.byteLength : newBytes.byteLength,
          modifiedMs: infoCalls,
          isFile: true,
        };
      },
      async countNewlines() {
        return 1;
      },
      async readTrailingLine() {
        return { bytes: new Uint8Array(), truncated: false };
      },
      async readRange() {
        return new Uint8Array();
      },
      async readFrom(_file, byteOffset) {
        readCalls += 1;
        const bytes = readCalls === 1 ? oldBytes : newBytes;
        return { bytes: bytes.subarray(byteOffset), truncated: false };
      },
      watch() {
        return { close() {} };
      },
    };
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser(), runtime, {
      now: () => '2026-01-02T03:04:20.000Z',
    });
    const iterator = subject.follow('/synthetic/transcript.jsonl', { pollIntervalMs: 10 })[Symbol.asyncIterator]();

    try {
      // Act
      const actual = await nextBatch(iterator, 'replacement delivery proof');

      // Assert
      should(actual.events).containDeep([{ kind: 'message', text: prompt }]);
      should(actual.observedInputs).containDeep([
        { text: prompt, proof: 'native-queue-drain', observedAt: '2026-01-02T03:04:20.000Z' },
      ]);
      should(actual.observedInputs[0]?.observedAt).not.equal('2026-01-02T03:04:10.000Z');
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
      const malformedOffset = appended.cursor.byteOffset;
      await appendFile(file, '{bad}\n');
      const malformed = await nextBatch(iterator, 'malformed append');

      // Assert
      should(initial.events).have.length(0);
      should(initial.cursor.nextLine).equal(2);
      should(appended.events).have.length(1);
      should(appended.events[0]).containDeep({ text: 'new append' });
      should(malformed.issues).containDeep([{ code: 'invalid-json', line: 3, byteOffset: malformedOffset }]);
    } finally {
      await iterator.return?.(undefined);
    }
  });

  it('should retry an end cursor after transient verification failure without replaying existing records', async () => {
    // Arrange
    const bytes = Buffer.from(jsonl(userRecord('already present during cursor retry')));
    let infoCalls = 0;
    let readFromCalls = 0;
    const runtime: TranscriptFileRuntime = {
      async info() {
        infoCalls += 1;
        if (infoCalls === 2) throw new Error('synthetic verification failure');
        return { identity: 'stable', size: bytes.byteLength, modifiedMs: infoCalls, isFile: true };
      },
      async countNewlines() {
        return 1;
      },
      async readTrailingLine() {
        return { bytes: new Uint8Array(), truncated: false };
      },
      async readRange(_file, byteOffset, byteLength) {
        return bytes.subarray(byteOffset, byteOffset + byteLength);
      },
      async readFrom(_file, byteOffset) {
        readFromCalls += 1;
        return { bytes: bytes.subarray(byteOffset), truncated: false };
      },
      watch() {
        return { close() {} };
      },
    };
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser(), runtime);
    const iterator = subject
      .follow('/synthetic/transcript.jsonl', { startAt: 'end', pollIntervalMs: 10 })
      [Symbol.asyncIterator]();

    try {
      // Act
      const failed = await nextBatch(iterator, 'end cursor verification failure');
      const recovered = await nextBatch(iterator, 'end cursor verification recovery');

      // Assert
      should(failed.issues.map(issue => issue.code)).deepEqual(['source-read-failed']);
      should(recovered.events).be.empty();
      should(recovered.observedInputs).be.empty();
      should(recovered.cursor.byteOffset).equal(bytes.byteLength);
      should(readFromCalls).equal(0);
    } finally {
      await iterator.return?.(undefined);
    }
  });

  it('should read a replacement from byte zero when it changes while establishing an end cursor', async () => {
    for (const change of ['identity', 'truncation'] as const) {
      // Arrange
      const bytes = Buffer.from(jsonl(userRecord(`${change} replacement during end cursor setup`)));
      const initialSize = change === 'truncation' ? bytes.byteLength + 64 : bytes.byteLength;
      let infoCalls = 0;
      const runtime: TranscriptFileRuntime = {
        async info() {
          infoCalls += 1;
          const initial = infoCalls === 1;
          return {
            identity: initial && change === 'identity' ? 'old-identity' : 'new-identity',
            size: initial ? initialSize : bytes.byteLength,
            modifiedMs: infoCalls,
            isFile: true,
          };
        },
        async countNewlines() {
          return 1;
        },
        async readTrailingLine() {
          return { bytes: new Uint8Array(), truncated: false };
        },
        async readRange(_file, byteOffset, byteLength) {
          return bytes.subarray(byteOffset, byteOffset + byteLength);
        },
        async readFrom(_file, byteOffset) {
          return { bytes: bytes.subarray(byteOffset), truncated: false };
        },
        watch() {
          return { close() {} };
        },
      };
      const subject = new NodeTranscriptSource(new ClaudeTranscriptParser(), runtime);
      const iterator = subject
        .follow('/synthetic/transcript.jsonl', { startAt: 'end', pollIntervalMs: 10 })
        [Symbol.asyncIterator]();

      try {
        // Act
        const changed = await nextBatch(iterator, `${change} during end cursor setup`);
        const recovered = await nextBatch(iterator, `${change} replacement recovery`);

        // Assert
        should(changed.issues.map(issue => issue.code)).deepEqual(['source-read-failed']);
        should(recovered.events).containDeep([
          { kind: 'message', text: `${change} replacement during end cursor setup` },
        ]);
        should(recovered.cursor.byteOffset).equal(bytes.byteLength);
      } finally {
        await iterator.return?.(undefined);
      }
    }
  });

  it('should treat records created after an end-follow subscription as new', async () => {
    // Arrange
    const temporary = await temporaryDirectory();
    const file = join(temporary, 'later.jsonl');
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser());
    const iterator = subject.follow(file, { startAt: 'end', pollIntervalMs: 20 })[Symbol.asyncIterator]();

    try {
      await nextBatch(iterator, 'missing source');

      // Act
      await writeFile(file, jsonl(userRecord('present at discovery')));
      const discovered = await nextBatch(iterator, 'initial end cursor');
      await appendFile(file, jsonl(userRecord('appended after discovery')));
      const appended = await nextBatch(iterator, 'append after discovery');

      // Assert
      should(discovered.events).containDeep([{ kind: 'message', text: 'present at discovery' }]);
      should(appended.events).containDeep([{ kind: 'message', text: 'appended after discovery' }]);
    } finally {
      await iterator.return?.(undefined);
    }
  });

  it('should retain a split UTF-8 line that completes after an end-follow subscription', async () => {
    // Arrange
    const temporary = await temporaryDirectory();
    const file = join(temporary, 'partial-at-end.jsonl');
    const record = Buffer.from(jsonl(userRecord('split 😀 record')));
    const codePoint = Buffer.from('😀');
    const splitAt = record.indexOf(codePoint) + 2;
    await writeFile(file, record.subarray(0, splitAt));
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser());
    const iterator = subject.follow(file, { startAt: 'end', pollIntervalMs: 20 })[Symbol.asyncIterator]();

    try {
      const initial = await nextBatch(iterator, 'initial partial cursor');

      // Act
      await appendFile(file, record.subarray(splitAt));
      const completed = await nextBatch(iterator, 'completed UTF-8 record');

      // Assert
      should(initial.events).be.empty();
      should(initial.issues).containDeep([{ code: 'incomplete-line', byteOffset: 0, byteLength: splitAt, line: 1 }]);
      should(initial.cursor.pendingBytes).equal(splitAt);
      should(completed.events).containDeep([{ kind: 'message', text: 'split 😀 record' }]);
      should(completed.issues).be.empty();
      should(completed.cursor.pendingBytes).equal(0);
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

  it('should not yield after an abort during IO and should close the watcher', async () => {
    // Arrange
    let markInfoStarted: (() => void) | undefined;
    let releaseInfo: (() => void) | undefined;
    let closeCount = 0;
    const infoStarted = new Promise<void>(resolve => {
      markInfoStarted = resolve;
    });
    const infoGate = new Promise<void>(resolve => {
      releaseInfo = resolve;
    });
    const runtime: TranscriptFileRuntime = {
      async info() {
        markInfoStarted?.();
        await infoGate;
        return undefined;
      },
      async countNewlines() {
        return 0;
      },
      async readTrailingLine() {
        return { bytes: new Uint8Array(), truncated: false };
      },
      async readRange() {
        return new Uint8Array();
      },
      async readFrom() {
        return { bytes: new Uint8Array(), truncated: false };
      },
      watch() {
        return {
          close() {
            closeCount += 1;
          },
        };
      },
    };
    const controller = new AbortController();
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser(), runtime);
    const iterator = subject
      .follow('/synthetic/transcript.jsonl', { signal: controller.signal })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    await infoStarted;

    // Act
    controller.abort();
    releaseInfo?.();
    const actual = await pending;

    // Assert
    should(actual.done).be.true();
    should(closeCount).equal(1);
  });

  it('should surface an asynchronous directory-watch error without stopping polling', async () => {
    // Arrange
    const temporary = await temporaryDirectory();
    const file = join(temporary, 'transcript.jsonl');
    await writeFile(file, jsonl(userRecord('initial')));
    const nodeRuntime = new NodeTranscriptFileRuntime();
    let failWatch: (() => void) | undefined;
    let notifyWatch: (() => void) | undefined;
    let watchCount = 0;
    let closeCount = 0;
    const runtime: TranscriptFileRuntime = {
      info: file => nodeRuntime.info(file),
      countNewlines: (file, byteLength) => nodeRuntime.countNewlines(file, byteLength),
      readTrailingLine: (file, byteLength, byteLimit) => nodeRuntime.readTrailingLine(file, byteLength, byteLimit),
      readRange: (file, byteOffset, byteLength) => nodeRuntime.readRange(file, byteOffset, byteLength),
      readFrom: (file, byteOffset, byteLimit) => nodeRuntime.readFrom(file, byteOffset, byteLimit),
      watch(_directory, onChange, onError) {
        watchCount += 1;
        notifyWatch = onChange;
        if (watchCount === 1) failWatch = () => onError(new Error('synthetic watch failure'));
        return {
          close() {
            closeCount += 1;
          },
        };
      },
    };
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser(), runtime);
    const iterator = subject.follow(file, { pollIntervalMs: 10_000 })[Symbol.asyncIterator]();

    try {
      await nextBatch(iterator, 'initial record');

      // Act
      failWatch?.();
      const actual = await nextBatch(iterator, 'asynchronous watch failure');
      await appendFile(file, jsonl(userRecord('after watch recovery')));
      const pendingRecovery = nextBatch(iterator, 'polling after watch recovery');
      await Promise.resolve();
      notifyWatch?.();
      const recovered = await pendingRecovery;

      // Assert
      should(actual.events).have.length(0);
      should(actual.issues.map(issue => issue.code)).deepEqual(['source-watch-failed']);
      should(recovered.events).containDeep([{ kind: 'message', text: 'after watch recovery' }]);
      should(watchCount).equal(2);
      should(closeCount).equal(1);
    } finally {
      await iterator.return?.(undefined);
    }
    should(closeCount).equal(2);
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
    const actual = await subject.readFrom(file, Buffer.byteLength('prefix-'), DEFAULT_MAX_READ_BYTES);

    // Assert
    should(Buffer.from(actual.bytes).toString('utf8')).equal('suffix');
    should(actual.truncated).be.false();
  });

  it('should report truncation only when bytes really remain past the limit', async () => {
    // Arrange
    const temporary = await temporaryDirectory();
    const file = join(temporary, 'limits.txt');
    await writeFile(file, 'abcdef');
    const subject = new NodeTranscriptFileRuntime();

    // Act
    const exact = await subject.readFrom(file, 0, 6);
    const short = await subject.readFrom(file, 0, 5);
    const spare = await subject.readFrom(file, 0, DEFAULT_MAX_READ_BYTES);

    // Assert
    should(exact).deepEqual({ bytes: Buffer.from('abcdef'), truncated: false });
    should(short).deepEqual({ bytes: Buffer.from('abcde'), truncated: true });
    should(spare.truncated).be.false();
  });

  it('should read nothing at all rather than open the file for a non-positive limit', async () => {
    // Arrange
    const temporary = await temporaryDirectory();
    const file = join(temporary, 'unreadable.txt');
    await writeFile(file, 'abcdef');
    const subject = new NodeTranscriptFileRuntime();

    // Act
    const noBytes = await subject.readFrom(file, 0, 0);
    const noTrailing = await subject.readTrailingLine(file, 6, 0);

    // Assert
    should(noBytes).deepEqual({ bytes: new Uint8Array(), truncated: true });
    should(noTrailing).deepEqual({ bytes: new Uint8Array(), truncated: true });
  });

  it('should stop reading a trailing line at its limit and say the line start was never found', async () => {
    // Arrange
    const temporary = await temporaryDirectory();
    const file = join(temporary, 'trailing.txt');
    const contents = `complete\n${'y'.repeat(300)}`;
    await writeFile(file, contents);
    const subject = new NodeTranscriptFileRuntime();
    const size = Buffer.byteLength(contents);

    // Act
    const bounded = await subject.readTrailingLine(file, size, 64);
    const whole = await subject.readTrailingLine(file, size, DEFAULT_MAX_PENDING_BYTES);
    const empty = await subject.readTrailingLine(file, 0, DEFAULT_MAX_PENDING_BYTES);

    // Assert
    should(bounded.truncated).be.true();
    should(bounded.bytes.byteLength).equal(64);
    should(whole).deepEqual({ bytes: Buffer.from('y'.repeat(300)), truncated: false });
    should(empty).deepEqual({ bytes: new Uint8Array(), truncated: false });
  });

  it('should map missing metadata to undefined while propagating other runtime faults through the source', async () => {
    // Arrange
    const subject = new NodeTranscriptFileRuntime();
    const missing = join(await temporaryDirectory(), 'missing.jsonl');
    const fault: TranscriptFileRuntime = {
      async info() {
        throw new Error('synthetic metadata fault');
      },
      async countNewlines() {
        return 0;
      },
      async readTrailingLine() {
        return { bytes: new Uint8Array(), truncated: false };
      },
      async readRange() {
        return new Uint8Array();
      },
      async readFrom() {
        return { bytes: new Uint8Array(), truncated: false };
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

describe('NodeTranscriptSource bounded reads', () => {
  it('should stop a one-shot read at the cap, cut back to a record boundary, and say what it skipped', async () => {
    // Arrange: transcripts grow without limit, so the cap has to hold even when the file does not.
    const temporary = await temporaryDirectory();
    const file = join(temporary, 'oversized.jsonl');
    const records = [0, 1, 2, 3, 4].map(index => jsonl(userRecord(`record ${index}`)));
    await writeFile(file, records.join(''));
    const recordBytes = Buffer.byteLength(records[0]!);
    const totalBytes = Buffer.byteLength(records.join(''));
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser(), new NodeTranscriptFileRuntime(), undefined, {
      // A cap landing inside the third record proves the cut is line-aligned rather than byte-aligned.
      maxReadBytes: recordBytes * 2 + 10,
    });

    // Act
    const actual = await subject.read(file);

    // Assert
    should(actual.events).containDeep([
      { kind: 'message', text: 'record 0' },
      { kind: 'message', text: 'record 1' },
    ]);
    should(actual.events).have.length(2);
    should(actual.issues.map(issue => issue.code)).deepEqual(['source-truncated']);
    should(actual.issues[0]).containDeep({
      byteOffset: recordBytes * 2,
      byteLength: totalBytes - recordBytes * 2,
      recoverable: true,
    });
    should(actual.cursor.byteOffset).equal(recordBytes * 2);
    should(actual.cursor.pendingBytes).equal(0);
    should(actual.cursor.nextLine).equal(3);
  });

  it('should never hold the whole file when following one that exceeds the cap', async () => {
    // Arrange
    const temporary = await temporaryDirectory();
    const file = join(temporary, 'streamed.jsonl');
    const texts = ['one', 'two', 'three', 'four', 'five', 'six'];
    await writeFile(file, texts.map(text => jsonl(userRecord(text))).join(''));
    const recordBytes = Buffer.byteLength(jsonl(userRecord('one')));
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser(), new NodeTranscriptFileRuntime(), undefined, {
      maxReadBytes: recordBytes + 5,
    });
    const iterator = subject.follow(file, { pollIntervalMs: 20 })[Symbol.asyncIterator]();

    try {
      // Act
      const seen: string[] = [];
      const codes: string[] = [];
      const widths: number[] = [];
      let previousOffset = 0;
      while (seen.length < texts.length) {
        const batch = await nextBatch(iterator, `bounded batch ${seen.length.toString()}`);
        for (const event of batch.events) if (event.kind === 'message') seen.push(event.text);
        for (const issue of batch.issues) codes.push(issue.code);
        widths.push(batch.cursor.byteOffset - previousOffset);
        previousOffset = batch.cursor.byteOffset;
      }

      // Assert
      should(seen).deepEqual(texts);
      should(codes).containEql('source-truncated');
      should(widths.every(width => width <= recordBytes + 5)).be.true();
    } finally {
      await iterator.return?.(undefined);
    }
  });

  it('should discard an unterminated record that outgrows the pending limit and resume on the next one', async () => {
    // Arrange
    const temporary = await temporaryDirectory();
    const file = join(temporary, 'runaway.jsonl');
    await writeFile(file, jsonl(userRecord('before the runaway record')));
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser(), new NodeTranscriptFileRuntime(), undefined, {
      maxPendingBytes: 64,
    });
    const iterator = subject.follow(file, { pollIntervalMs: 20 })[Symbol.asyncIterator]();

    try {
      await nextBatch(iterator, 'record before the runaway');

      // Act
      await appendFile(file, `{"type":"user","content":"${'x'.repeat(200)}`);
      const overflowed = await nextBatch(iterator, 'runaway record');
      await appendFile(file, `"}\n${jsonl(userRecord('after the runaway record'))}`);
      const recovered = await nextBatch(iterator, 'record after the runaway');

      // Assert
      should(overflowed.events).be.empty();
      should(overflowed.issues.map(issue => issue.code)).deepEqual(['oversized-record']);
      should(overflowed.cursor.pendingBytes).equal(0);
      should(recovered.events).containDeep([{ kind: 'message', text: 'after the runaway record' }]);
      should(recovered.issues).be.empty();
    } finally {
      await iterator.return?.(undefined);
    }
  });

  it('should refuse to buffer an oversized trailing record when a cursor starts at the end', async () => {
    // Arrange
    const temporary = await temporaryDirectory();
    const file = join(temporary, 'oversized-tail.jsonl');
    await writeFile(file, `${jsonl(userRecord('already present'))}{"type":"user","content":"${'x'.repeat(200)}`);
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser(), new NodeTranscriptFileRuntime(), undefined, {
      maxPendingBytes: 64,
    });
    const iterator = subject.follow(file, { startAt: 'end', pollIntervalMs: 20 })[Symbol.asyncIterator]();

    try {
      // Act
      const initial = await nextBatch(iterator, 'end cursor with oversized tail');
      await appendFile(file, `"}\n${jsonl(userRecord('after the oversized tail'))}`);
      const recovered = await nextBatch(iterator, 'record after the oversized tail');

      // Assert
      should(initial.events).be.empty();
      should(initial.issues.map(issue => issue.code)).deepEqual(['oversized-record']);
      should(initial.cursor.pendingBytes).equal(0);
      should(recovered.events).containDeep([{ kind: 'message', text: 'after the oversized tail' }]);
      should(recovered.issues).be.empty();
    } finally {
      await iterator.return?.(undefined);
    }
  });

  it('should parse a record that straddles the read chunk boundary as exactly one record', async () => {
    // Arrange: the terminator lands on the 64 KiB chunk edge, the case chunked IO gets wrong.
    const temporary = await temporaryDirectory();
    const file = join(temporary, 'straddling.jsonl');
    const empty = jsonl(paddedRecord('straddle', 0));
    const line = jsonl(paddedRecord('straddle', 64 * 1024 - Buffer.byteLength(empty)));
    await writeFile(file, `${line}${jsonl(userRecord('after the boundary'))}`);
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser());

    // Act
    const actual = await subject.read(file);

    // Assert
    should(Buffer.byteLength(line)).equal(64 * 1024);
    should(actual.events).have.length(2);
    should(actual.events[1]).containDeep({ kind: 'message', text: 'after the boundary' });
    should(actual.issues).be.empty();
    should(actual.cursor.nextLine).equal(3);
  });

  it('should keep the surrounding records when a line carries undecodable bytes', async () => {
    // Arrange
    const temporary = await temporaryDirectory();
    const file = join(temporary, 'undecodable.jsonl');
    await writeFile(
      file,
      Buffer.concat([
        Buffer.from(jsonl(userRecord('before the undecodable line'))),
        Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]),
        Buffer.from(jsonl(userRecord('after the undecodable line'))),
      ]),
    );
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser());

    // Act
    const actual = await subject.read(file);

    // Assert
    should(actual.events).containDeep([
      { kind: 'message', text: 'before the undecodable line' },
      { kind: 'message', text: 'after the undecodable line' },
    ]);
    should(actual.issues.map(issue => issue.code)).deepEqual(['invalid-json']);
    should(actual.issues[0]?.line).equal(2);
  });
});

describe('NodeTranscriptSource path handling', () => {
  it('should use the caller path verbatim and refuse links that do not reach a regular file', async () => {
    // Arrange: this source is an exact-path reader. It never joins, resolves or rebases a path, so
    // confinement is the composition root's contract — what it owns is refusing what it cannot read.
    const temporary = await temporaryDirectory();
    const target = join(temporary, 'real.jsonl');
    await writeFile(target, jsonl(userRecord('reached through a link')));
    await mkdir(join(temporary, 'nested'));
    const fileLink = join(temporary, 'file-link.jsonl');
    const directoryLink = join(temporary, 'directory-link');
    const danglingLink = join(temporary, 'dangling-link.jsonl');
    const loopLink = join(temporary, 'loop-a');
    const traversal = join(temporary, 'nested', '..', 'real.jsonl');
    await symlink(target, fileLink);
    await symlink(temporary, directoryLink);
    await symlink(join(temporary, 'absent.jsonl'), danglingLink);
    await symlink(loopLink, join(temporary, 'loop-b'));
    await symlink(join(temporary, 'loop-b'), loopLink);
    const subject = new NodeTranscriptSource(new ClaudeTranscriptParser());

    // Act
    const viaFileLink = await subject.read(fileLink);
    const viaDirectoryLink = await subject.read(directoryLink);
    const viaDangling = await subject.read(danglingLink);
    const viaLoop = await subject.read(loopLink);
    const viaTraversal = await subject.read(traversal);

    // Assert
    should(viaFileLink.events).containDeep([{ kind: 'message', text: 'reached through a link' }]);
    should(viaFileLink.file).equal(fileLink);
    should(viaDirectoryLink.issues.map(issue => issue.code)).deepEqual(['source-read-failed']);
    should(viaDangling.issues.map(issue => issue.code)).deepEqual(['source-missing']);
    should(viaLoop.issues.map(issue => issue.code)).deepEqual(['source-read-failed']);
    should(viaTraversal.events).containDeep([{ kind: 'message', text: 'reached through a link' }]);
    should(viaTraversal.file).equal(traversal);
  });
});
