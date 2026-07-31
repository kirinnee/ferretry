import { describe, it } from 'bun:test';
import should from 'should';
import {
  assertJournalRecordSize,
  createJournalScanCursor,
  createSessionEvent,
  type EventPointer,
  encodeSessionEvent,
  type JournalProblem,
  JournalRecordTooLargeError,
  MAX_JOURNAL_RECORD_BYTES,
  parseSessionEvent,
  parseSessionId,
  type SessionEvent,
  type SessionId,
  scanJournal,
  scanJournalChunk,
} from '../../src/lib/index.ts';

describe('event construction', () => {
  it('should create the next canonical event', () => {
    // Arrange
    const sessionId = parseSessionId('session-a');

    // Act
    const actual = createSessionEvent(sessionId, 4, '2026-07-30T12:00:00.000Z', 'session.updated', {
      nested: ['value'],
    });

    // Assert
    should(actual).deepEqual({
      schemaVersion: 1,
      sequence: 5,
      sessionId: 'session-a',
      time: '2026-07-30T12:00:00.000Z',
      type: 'session.updated',
      data: { nested: ['value'] },
    });
  });

  it('should canonicalize an offset event instant to UTC', () => {
    // Arrange
    const sessionId = parseSessionId('session-a');

    // Act
    const actual = createSessionEvent(sessionId, 0, '2026-07-30T10:00:00+02:00', 'event', {});

    // Assert
    should(actual.time).equal('2026-07-30T08:00:00.000Z');
  });

  it('should reject invalid event input before encoding', () => {
    // Arrange
    const sessionId = parseSessionId('session-a');
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    // Act + Assert
    should(() => createSessionEvent(sessionId, 0, 'not-an-instant', 'event', {})).throw();
    should(() => createSessionEvent(sessionId, 0, '2026-07-30T12:00:00.000Z', '  ', {})).throw();
    should(() => createSessionEvent(sessionId, 0, '2026-07-30T12:00:00.000Z', ' event ', {})).throw();
    should(() => createSessionEvent(sessionId, 0, '2026-07-30T12:00:00.000Z', 'event', circular)).throw();
  });
});

describe('journal scanning', () => {
  it('should preserve byte-exact offsets for multi-byte payloads', () => {
    // Arrange
    const sessionId = parseSessionId('session-a');
    const first = createSessionEvent(sessionId, 0, '2026-07-30T12:00:00.000Z', 'message', { text: '你好 👋' });
    const second = createSessionEvent(sessionId, 1, '2026-07-30T12:00:01.000Z', 'done', null);
    const firstLine = encodeSessionEvent(first);
    const secondLine = encodeSessionEvent(second);
    const input = Buffer.from(`${firstLine}\n${secondLine}\n`);
    const expectedOffset = Buffer.byteLength(firstLine) + 1;

    // Act
    const actual = scanJournal(input, { file: '/tmp/events.jsonl', sessionId });

    // Assert
    should(actual.events).deepEqual([first, second]);
    should(actual.pointers).have.length(2);
    should(actual.pointers[0]?.byteOffset).equal(0);
    should(actual.pointers[0]?.byteLength).equal(Buffer.byteLength(firstLine));
    should(actual.pointers[1]?.byteOffset).equal(expectedOffset);
    should(actual.pointers[1]?.byteLength).equal(Buffer.byteLength(secondLine));
    should(actual.problems).deepEqual([]);
    should(actual.lastSequence).equal(2);
  });

  it('should accept blank lines, CRLF, and a final record without a newline', () => {
    // Arrange
    const sessionId = parseSessionId('session-a');
    const first = createSessionEvent(sessionId, 0, '2026-07-30T12:00:00.000Z', 'first', {});
    const second = createSessionEvent(sessionId, 1, '2026-07-30T12:00:01.000Z', 'second', {});
    const input = Buffer.from(`\n  \r\n${encodeSessionEvent(first)}\r\n${encodeSessionEvent(second)}`);

    // Act
    const actual = scanJournal(input, { file: '/tmp/events.jsonl', sessionId });

    // Assert
    should(actual.events).deepEqual([first, second]);
    should(actual.problems).deepEqual([]);
  });

  it('should report malformed, wrong-session, and non-monotonic records without hiding later valid events', () => {
    // Arrange
    const sessionId = parseSessionId('session-a');
    const otherId = parseSessionId('session-b');
    const first = createSessionEvent(sessionId, 0, '2026-07-30T12:00:00.000Z', 'first', {});
    const wrongSession = createSessionEvent(otherId, 1, '2026-07-30T12:00:01.000Z', 'wrong', {});
    const duplicate = { ...first, type: 'duplicate' };
    const third = createSessionEvent(sessionId, 2, '2026-07-30T12:00:03.000Z', 'third', {});
    const input = Buffer.from(
      [
        encodeSessionEvent(first),
        '{torn',
        encodeSessionEvent(wrongSession),
        JSON.stringify(duplicate),
        encodeSessionEvent(third),
      ].join('\n'),
    );

    // Act
    const actual = scanJournal(input, { file: '/tmp/events.jsonl', sessionId });

    // Assert
    should(actual.events).deepEqual([first, third]);
    should(actual.problems.map(problem => problem.message)).deepEqual([
      'invalid JSON event record',
      'invalid event schema or session id',
      'event sequence 1 is not greater than 1',
    ]);
    should(actual.problems.map(problem => problem.line)).deepEqual([2, 3, 4]);
  });

  it('should apply absolute offsets and sequence context to an incremental scan', () => {
    // Arrange
    const sessionId = parseSessionId('session-a');
    const input = Buffer.from(
      `${encodeSessionEvent(createSessionEvent(sessionId, 7, '2026-07-30T12:00:08.000Z', 'eighth', {}))}\n`,
    );

    // Act
    const actual = scanJournal(input, {
      file: '/tmp/events.jsonl',
      sessionId,
      baseOffset: 512,
      firstLine: 9,
      previousSequence: 7,
    });

    // Assert
    should(actual.pointers[0]?.byteOffset).equal(512);
    should(actual.events[0]?.sequence).equal(8);
    should(actual.scannedTo).equal(512 + input.byteLength);
  });

  it('should reject a valid event whose identity does not match the requested session', () => {
    // Arrange
    const expected = parseSessionId('session-a');
    const other = createSessionEvent(parseSessionId('session-b'), 0, '2026-07-30T12:00:00.000Z', 'event', {});

    // Act
    const actual = parseSessionEvent(other, expected);

    // Assert
    should(actual).be.undefined();
  });

  it('should report a byte sequence that is not valid UTF-8', () => {
    // Arrange
    const sessionId = parseSessionId('session-a');
    const input = new Uint8Array([0xff, 0x0a]);

    // Act
    const actual = scanJournal(input, { file: '/tmp/events.jsonl', sessionId });

    // Assert
    should(actual.events).deepEqual([]);
    should(actual.problems).deepEqual([
      {
        file: '/tmp/events.jsonl',
        line: 1,
        byteOffset: 0,
        message: 'event record is not valid UTF-8',
      },
    ]);
  });

  it('should produce the same scan when records cross bounded chunk boundaries', () => {
    // Arrange
    const sessionId = parseSessionId('session-a');
    const first = createSessionEvent(sessionId, 0, '2026-07-30T12:00:00.000Z', 'message', { text: '你好 👋' });
    const second = createSessionEvent(sessionId, 1, '2026-07-30T12:00:01.000Z', 'done', { text: 'complete' });
    const input = Buffer.from(`${encodeSessionEvent(first)}\n${encodeSessionEvent(second)}`);
    const expected = scanJournal(input, { file: '/tmp/events.jsonl', sessionId });
    let cursor = createJournalScanCursor();
    const events: SessionEvent[] = [];
    const pointers: EventPointer[] = [];
    const problems: JournalProblem[] = [];

    // Act
    for (let offset = 0; offset < input.byteLength; offset += 7) {
      const result = scanJournalChunk(cursor, input.subarray(offset, offset + 7), {
        file: '/tmp/events.jsonl',
        sessionId,
      });
      cursor = result.cursor;
      events.push(...result.scan.events);
      pointers.push(...result.scan.pointers);
      problems.push(...result.scan.problems);
    }
    const final = scanJournalChunk(cursor, new Uint8Array(), {
      file: '/tmp/events.jsonl',
      sessionId,
      final: true,
    });
    events.push(...final.scan.events);
    pointers.push(...final.scan.pointers);
    problems.push(...final.scan.problems);

    // Assert
    should(events).deepEqual(expected.events);
    should(pointers).deepEqual(expected.pointers);
    should(problems).deepEqual(expected.problems);
    should(final.cursor.pending.byteLength).equal(0);
    should(final.cursor.byteOffset).equal(input.byteLength);
    should(final.cursor.lastSequence).equal(2);
  });
});

describe('journal line-at-offset tracking', () => {
  const file = '/tmp/events.jsonl';
  const TIME = '2026-07-30T12:00:00.000Z';

  it('reports the next line when a scan ends immediately after a line feed', () => {
    // Arrange
    const sessionId = parseSessionId('session-a');
    const first = createSessionEvent(sessionId, 0, TIME, 'first', {});
    const second = createSessionEvent(sessionId, 1, TIME, 'second', {});
    const input = Buffer.from(`${encodeSessionEvent(first)}\n${encodeSessionEvent(second)}\n`);

    // Act
    const actual = scanJournal(input, { file, sessionId });

    // Assert — two records plus a trailing line feed lands on the (empty) third line
    should(actual.lineAtOffset).equal(3);
  });

  it('stays on the final record line at EOF without a trailing line feed', () => {
    // Arrange
    const sessionId = parseSessionId('session-a');
    const first = createSessionEvent(sessionId, 0, TIME, 'first', {});
    const second = createSessionEvent(sessionId, 1, TIME, 'second', {});
    const input = Buffer.from(`${encodeSessionEvent(first)}\n${encodeSessionEvent(second)}`);

    // Act
    const actual = scanJournal(input, { file, sessionId });

    // Assert — EOF mid-record keeps the second record's line
    should(actual.lineAtOffset).equal(2);
  });

  it('keeps scanJournalChunk scan.lineAtOffset in step with the cursor across chunk boundaries', () => {
    // Arrange
    const sessionId = parseSessionId('session-a');
    const first = createSessionEvent(sessionId, 0, TIME, 'first', {});
    const second = createSessionEvent(sessionId, 1, TIME, 'second', {});
    const input = Buffer.from(`${encodeSessionEvent(first)}\n${encodeSessionEvent(second)}`);
    let cursor = createJournalScanCursor();

    // Act + Assert — every chunk's reported line tracks the cursor; EOF ends on line 2
    for (let offset = 0; offset < input.byteLength; offset += 7) {
      const result = scanJournalChunk(cursor, input.subarray(offset, offset + 7), { file, sessionId });
      cursor = result.cursor;
      should(result.scan.lineAtOffset).equal(cursor.line);
    }
    const final = scanJournalChunk(cursor, new Uint8Array(), { file, sessionId, final: true });
    should(final.scan.lineAtOffset).equal(final.cursor.line);
    should(final.scan.lineAtOffset).equal(2);
  });
});

describe('journal record size cap', () => {
  const file = '/tmp/events.jsonl';
  const TIME = '2026-07-30T12:00:00.000Z';

  // Feed `input` through scanJournalChunk in tiny slices plus a final empty chunk, exactly like the
  // 64 KiB streaming reader in DaemonStorage. Returns the accumulated scan and the high-water mark
  // of retained pending bytes across every chunk (the memory the scanner is allowed to retain).
  const streamChunked = (
    input: Uint8Array,
    sessionId: SessionId,
    cap: number,
    slice = 7,
  ): {
    events: SessionEvent[];
    pointers: EventPointer[];
    problems: JournalProblem[];
    cursorByteOffset: number;
    pendingByteLength: number;
    discarding: boolean;
    maxPending: number;
  } => {
    let cursor = createJournalScanCursor();
    const events: SessionEvent[] = [];
    const pointers: EventPointer[] = [];
    const problems: JournalProblem[] = [];
    let maxPending = 0;
    for (let offset = 0; offset < input.byteLength; offset += slice) {
      const result = scanJournalChunk(cursor, input.subarray(offset, offset + slice), {
        file,
        sessionId,
        maxRecordBytes: cap,
      });
      cursor = result.cursor;
      events.push(...result.scan.events);
      pointers.push(...result.scan.pointers);
      problems.push(...result.scan.problems);
      if (cursor.pending.byteLength > maxPending) maxPending = cursor.pending.byteLength;
    }
    const final = scanJournalChunk(cursor, new Uint8Array(), { file, sessionId, maxRecordBytes: cap, final: true });
    events.push(...final.scan.events);
    pointers.push(...final.scan.pointers);
    problems.push(...final.scan.problems);
    return {
      events,
      pointers,
      problems,
      cursorByteOffset: final.cursor.byteOffset,
      pendingByteLength: final.cursor.pending.byteLength,
      discarding: final.cursor.discarding ?? false,
      maxPending: Math.max(maxPending, final.cursor.pending.byteLength),
    };
  };

  it('discards an oversized newline-free record streamed across many small chunks', () => {
    // Arrange — cap fits the small record but not a much larger one; oversized has no newline.
    const sessionId = parseSessionId('session-a');
    const cap = Buffer.byteLength(encodeSessionEvent(createSessionEvent(sessionId, 0, TIME, 'small', null))) + 8;
    const oversized = createSessionEvent(sessionId, 0, TIME, 'oversized', { blob: 'X'.repeat(cap * 4) });
    const oversizedBytes = Buffer.from(encodeSessionEvent(oversized));
    should(oversizedBytes.byteLength).be.greaterThan(cap);

    // Act
    const actual = streamChunked(oversizedBytes, sessionId, cap);

    // Assert — exactly one problem at the record's true origin, no event, pending bounded.
    should(actual.events).deepEqual([]);
    should(actual.problems).deepEqual([
      { file, line: 1, byteOffset: 0, message: `event record exceeds the maximum encoded size of ${cap} bytes` },
    ]);
    should(actual.maxPending).be.lessThanOrEqual(cap); // retained pending never exceeds the cap
    should(actual.cursorByteOffset).equal(oversizedBytes.byteLength);
    should(actual.discarding).equal(true); // record never terminated, kept draining at EOF
  });

  it('resumes a later valid record after an oversized one with correct offset, line, and sequence', () => {
    // Arrange
    const sessionId = parseSessionId('session-a');
    const cap =
      Buffer.byteLength(encodeSessionEvent(createSessionEvent(sessionId, 0, TIME, 'small', { ok: true }))) + 8;
    const oversizedEncoded = encodeSessionEvent(
      createSessionEvent(sessionId, 0, TIME, 'oversized', { blob: 'Y'.repeat(cap * 4) }),
    );
    const small = createSessionEvent(sessionId, 0, TIME, 'small', { ok: true });
    const smallEncoded = encodeSessionEvent(small);
    const input = Buffer.from(`${oversizedEncoded}\n${smallEncoded}\n`);

    // Act
    const actual = streamChunked(input, sessionId, cap);

    // Assert — oversized discarded once at byte 0/line 1; small resumes on line 2 after the newline.
    should(actual.events).deepEqual([small]);
    should(actual.problems.map(problem => problem.message)).deepEqual([
      `event record exceeds the maximum encoded size of ${cap} bytes`,
    ]);
    should(actual.problems[0]?.line).equal(1);
    should(actual.problems[0]?.byteOffset).equal(0);
    should(actual.pointers[0]?.byteOffset).equal(Buffer.byteLength(oversizedEncoded) + 1);
    should(actual.pointers[0]?.sequence).equal(1); // discarded record did not advance lastSequence
    should(actual.cursorByteOffset).equal(input.byteLength);
    should(actual.pendingByteLength).equal(0);
    should(actual.maxPending).be.lessThanOrEqual(cap);
  });

  it('accepts boundary-sized valid input (exactly the cap) whether chunked or scanned whole', () => {
    // Arrange — a record whose encoded length is exactly the cap must not be discarded.
    const sessionId = parseSessionId('session-a');
    const event = createSessionEvent(sessionId, 0, TIME, 'boundary', null);
    const encoded = encodeSessionEvent(event);
    const cap = Buffer.byteLength(encoded);
    const input = Buffer.from(`${encoded}\n`);

    // Act
    const whole = scanJournal(input, { file, sessionId, maxRecordBytes: cap });
    const chunked = streamChunked(input, sessionId, cap, 5);

    // Assert
    should(whole.events).deepEqual([event]);
    should(whole.problems).deepEqual([]);
    should(chunked.events).deepEqual([event]);
    should(chunked.problems).deepEqual([]);
    should(chunked.maxPending).be.lessThanOrEqual(cap);
  });

  it('reports a complete oversized line once via scanJournal and keeps later valid events', () => {
    // Arrange
    const sessionId = parseSessionId('session-a');
    const cap = Buffer.byteLength(encodeSessionEvent(createSessionEvent(sessionId, 0, TIME, 'small', null))) + 8;
    const oversizedEncoded = encodeSessionEvent(
      createSessionEvent(sessionId, 0, TIME, 'big', { blob: 'Q'.repeat(cap * 4) }),
    );
    const small = createSessionEvent(sessionId, 0, TIME, 'small', null);
    const input = Buffer.from(`${oversizedEncoded}\n${encodeSessionEvent(small)}\n`);

    // Act
    const actual = scanJournal(input, { file, sessionId, maxRecordBytes: cap });

    // Assert
    should(actual.events).deepEqual([small]);
    should(actual.problems).deepEqual([
      { file, line: 1, byteOffset: 0, message: `event record exceeds the maximum encoded size of ${cap} bytes` },
    ]);
    should(actual.scannedTo).equal(input.byteLength);
  });
});

describe('encoded record size enforcement', () => {
  it('encodes a record under the production cap', () => {
    // Arrange
    const sessionId = parseSessionId('session-a');
    const event = createSessionEvent(sessionId, 0, '2026-07-30T12:00:00.000Z', 'ok', null);

    // Act + Assert
    should(encodeSessionEvent(event)).equal(JSON.stringify(event));
  });

  it('throws JournalRecordTooLargeError from encodeSessionEvent when the encoded form exceeds the cap', () => {
    // Arrange — append must never write a record that a later rebuild would reject.
    const sessionId = parseSessionId('session-a');
    const tooLarge = createSessionEvent(sessionId, 0, '2026-07-30T12:00:00.000Z', 'huge', {
      blob: 'Z'.repeat(MAX_JOURNAL_RECORD_BYTES + 10),
    });

    // Act
    let caught: unknown;
    try {
      encodeSessionEvent(tooLarge);
    } catch (error) {
      caught = error;
    }

    // Assert
    should(caught).be.instanceOf(JournalRecordTooLargeError);
    should((caught as JournalRecordTooLargeError).byteLength).be.greaterThan(MAX_JOURNAL_RECORD_BYTES);
    should((caught as JournalRecordTooLargeError).maxBytes).equal(MAX_JOURNAL_RECORD_BYTES);
  });

  it('assertJournalRecordSize accepts the boundary and rejects one byte over', () => {
    // Act + Assert — boundary (== cap) is allowed; one byte over (>) throws with the measured size.
    assertJournalRecordSize('x'.repeat(5), 5);
    let caught: unknown;
    try {
      assertJournalRecordSize('x'.repeat(6), 5);
    } catch (error) {
      caught = error;
    }
    should(caught).be.instanceOf(JournalRecordTooLargeError);
    should((caught as JournalRecordTooLargeError).byteLength).equal(6);
    should((caught as JournalRecordTooLargeError).maxBytes).equal(5);
  });
});
