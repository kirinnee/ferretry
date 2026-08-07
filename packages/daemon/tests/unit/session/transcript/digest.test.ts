import { describe, it } from 'bun:test';
import type { ConversationMessagePoint } from '@ferretry/protocol';
import should from 'should';
import {
  ConversationDigestError,
  digestConversation,
  extendSessionTranscriptRawPrefix,
  portableConversationRows,
  sameConversationMessagePoint,
  sessionTranscriptRawPrefixStart,
} from '../../../../src/lib/session/transcript/index.ts';
import type { TranscriptBatch, TranscriptEvent, TranscriptRawRecord } from '../../../../src/lib/transcript/types.ts';

const point = (byteOffset: number, blockIndex = 0): ConversationMessagePoint => ({
  v: 1,
  byteOffset,
  blockIndex,
});

const message = (
  byteOffset: number,
  role: 'user' | 'assistant' | 'developer' | 'system',
  text: string,
  blockIndex?: number,
): TranscriptEvent => ({
  kind: 'message',
  harness: 'claude',
  role,
  text,
  byteOffset,
  ...(blockIndex === undefined ? {} : { blockIndex }),
});

const toolCall = (byteOffset: number): TranscriptEvent => ({
  kind: 'tool-call',
  harness: 'claude',
  role: 'assistant',
  byteOffset,
  call: { id: 'tool-1', name: 'Bash', input: { command: 'git status' } },
});

const transcript = (
  events: readonly TranscriptEvent[],
  issues: TranscriptBatch['issues'] = [],
  rawRecords?: readonly TranscriptRawRecord[],
): TranscriptBatch => ({
  harness: 'claude',
  file: '/durable/transcript.jsonl',
  reset: false,
  cursor: { byteOffset: 300, pendingBytes: 0, nextLine: 4 },
  events,
  observedInputs: [],
  issues,
  ...(rawRecords === undefined ? {} : { rawRecords }),
});

/** A physical record, as the parser would report it: exact bytes, terminator included. */
const record = (byteOffset: number, text: string): TranscriptRawRecord => ({
  byteOffset,
  bytes: Buffer.from(text, 'utf8'),
});

/** The chain a reader can fold by hand, so the digest's evidence is checked against the contract. */
const foldChain = (...records: readonly TranscriptRawRecord[]): Uint8Array =>
  records.reduce(
    (previous, entry) => extendSessionTranscriptRawPrefix(previous, entry.bytes),
    sessionTranscriptRawPrefixStart(),
  );

const sameBytes = (left: Uint8Array | undefined, right: Uint8Array): boolean =>
  left !== undefined && Buffer.from(left).equals(Buffer.from(right));

describe('digestConversation', () => {
  it('should produce a portable prefix at an exact message coordinate and declare omitted tool state', () => {
    // Arrange
    const batch = transcript([
      message(0, 'system', 'You are an assistant.'),
      message(40, 'user', 'Inspect the repository.'),
      toolCall(88),
      message(150, 'assistant', 'The repository is clean.'),
      message(210, 'user', 'This must not be included.'),
    ]);

    // Act
    const actual = digestConversation('session-1', batch, point(150));

    // Assert
    should(actual).eql({
      sessionId: 'session-1',
      through: { v: 1, byteOffset: 150, blockIndex: 0 },
      messages: [
        { point: { v: 1, byteOffset: 0, blockIndex: 0 }, role: 'system', text: 'You are an assistant.' },
        { point: { v: 1, byteOffset: 40, blockIndex: 0 }, role: 'user', text: 'Inspect the repository.' },
        {
          point: { v: 1, byteOffset: 150, blockIndex: 0 },
          role: 'assistant',
          text: 'The repository is clean.',
        },
      ],
      omissions: [{ point: { v: 1, byteOffset: 88, blockIndex: 0 }, kind: 'tool-call', reason: 'harness-specific' }],
    });
  });

  it('should distinguish messages normalized from one record by block index', () => {
    // Arrange
    const batch = transcript([message(0, 'user', 'first', 0), message(0, 'assistant', 'second', 1)]);

    // Act
    const actual = digestConversation('session-1', batch, point(0, 1));

    // Assert
    should(actual.messages.map(entry => entry.text)).eql(['first', 'second']);
    should(actual.through).eql({ v: 1, byteOffset: 0, blockIndex: 1 });
  });

  it('should refuse two events that normalize to the same durable point', () => {
    // Arrange
    const batch = transcript([message(0, 'user', 'first'), message(0, 'assistant', 'ambiguous second')]);

    // Act
    const failure = () => digestConversation('session-1', batch, point(0));

    // Assert
    should(failure).throw(ConversationDigestError, { failure: 'incomplete_transcript' });
  });

  it('should refuse a bounded or malformed transcript rather than returning a shorter history', () => {
    // Arrange
    const batch = transcript(
      [message(0, 'user', 'keep me')],
      [
        {
          harness: 'claude',
          code: 'source-truncated',
          message: 'read cap reached',
          recoverable: false,
        },
      ],
    );

    // Act
    const failure = () => digestConversation('session-1', batch, point(0));

    // Assert
    should(failure).throw(ConversationDigestError, { failure: 'incomplete_transcript' });
  });

  it('should refuse a target that is absent or names non-message evidence', () => {
    // Arrange
    const batch = transcript([message(0, 'user', 'keep me'), toolCall(80)]);

    // Act / Assert
    should(() => digestConversation('session-1', batch, point(20))).throw(ConversationDigestError, {
      failure: 'target_not_found',
    });
    should(() => digestConversation('session-1', batch, point(80))).throw(ConversationDigestError, {
      failure: 'target_not_message',
    });
  });
});

describe('sameConversationMessagePoint', () => {
  it('should compare the coordinate version as well as its offset and block', () => {
    // Arrange: a `v: 2` coordinate addresses a message under whatever `v: 2` comes to mean, so it
    // is not the `v: 1` message that happens to share an offset.
    const versionTwo = { v: 2, byteOffset: 40, blockIndex: 0 } as unknown as ConversationMessagePoint;

    // Act / Assert
    should(sameConversationMessagePoint(point(40), point(40))).be.true();
    should(sameConversationMessagePoint(point(40), point(41))).be.false();
    should(sameConversationMessagePoint(point(40), point(40, 1))).be.false();
    should(sameConversationMessagePoint(point(40), versionTwo)).be.false();
  });
});

describe('conversation raw-record evidence', () => {
  const records = [record(0, '{"m":"one"}\n'), record(12, '\n'), record(13, '{"m":"two"}\n')] as const;

  it('should bind the cut to the commitment for its own physical record', () => {
    // Arrange: a blank record between the two messages is still a record, so it moves the chain.
    const batch = transcript([message(0, 'user', 'one'), message(13, 'assistant', 'two')], [], records);

    // Act
    const actual = digestConversation('session-1', batch, point(13));

    // Assert
    should(actual.selectionEvidence?.point).eql({ v: 1, byteOffset: 13, blockIndex: 0 });
    should(sameBytes(actual.selectionEvidence?.rawPrefix, foldChain(...records))).be.true();
  });

  it('should carry no evidence for a batch that never read the file bytes', () => {
    // Arrange: import's validation-only re-read still works, and binds nothing.
    const batch = transcript([message(0, 'user', 'one')]);

    // Act / Assert
    should(digestConversation('session-1', batch, point(0)).selectionEvidence).be.undefined();
    should(() => portableConversationRows('session-1', batch)).throw(ConversationDigestError, {
      failure: 'incomplete_transcript',
    });
  });

  it('should give every block of one physical record that record’s commitment', () => {
    // Arrange: one record, two message blocks — the required blockIndex is what tells them apart.
    const oneRecord = [record(0, '{"blocks":2}\n')] as const;
    const batch = transcript([message(0, 'user', 'first', 0), message(0, 'assistant', 'second', 1)], [], oneRecord);

    // Act
    const rows = portableConversationRows('session-1', batch);

    // Assert
    should(rows.map(row => row.point.blockIndex)).eql([0, 1]);
    should(Buffer.from(rows[0]?.rawPrefix ?? new Uint8Array()).equals(Buffer.from(rows[1]?.rawPrefix ?? []))).be.true();
    should(sameBytes(rows[0]?.rawPrefix, foldChain(...oneRecord))).be.true();
  });

  it('should visit each physical record once, folding the previous value rather than the prefix', () => {
    // Arrange
    const batch = transcript([message(0, 'user', 'one'), message(13, 'assistant', 'two')], [], records);

    // Act
    const rows = portableConversationRows('session-1', batch);

    // Assert: row two's commitment is row one's extended by the records between them — the
    // incremental step, not a re-hash of the whole prefix.
    should(sameBytes(rows[0]?.rawPrefix, foldChain(records[0]))).be.true();
    should(
      sameBytes(
        rows[1]?.rawPrefix,
        extendSessionTranscriptRawPrefix(
          extendSessionTranscriptRawPrefix(rows[0]?.rawPrefix ?? new Uint8Array(), records[1].bytes),
          records[2].bytes,
        ),
      ),
    ).be.true();
  });

  it('should move the commitment when a record at or before the cut is rewritten, and not when a later one is', () => {
    // Arrange
    const events = [message(0, 'user', 'one'), message(13, 'assistant', 'two')];
    const original = digestConversation('session-1', transcript(events, [], records), point(0));

    // Act
    const earlierRewritten = digestConversation(
      'session-1',
      transcript(events, [], [record(0, '{"m":"ONE"}\n'), records[1], records[2]]),
      point(0),
    );
    const laterRewritten = digestConversation(
      'session-1',
      transcript(events, [], [records[0], records[1], record(13, '{"m":"TWO"}\n')]),
      point(0),
    );
    const appended = digestConversation(
      'session-1',
      transcript(events, [], [...records, record(25, '{"m":"three"}\n')]),
      point(0),
    );

    // Assert
    const commitment = original.selectionEvidence?.rawPrefix ?? new Uint8Array();
    should(sameBytes(earlierRewritten.selectionEvidence?.rawPrefix, commitment)).be.false();
    should(sameBytes(laterRewritten.selectionEvidence?.rawPrefix, commitment)).be.true();
    should(sameBytes(appended.selectionEvidence?.rawPrefix, commitment)).be.true();
  });

  it('should refuse a message whose offset names no physical record, and ambiguous record offsets', () => {
    // Arrange
    const orphaned = transcript([message(999, 'user', 'from nowhere')], [], [...records]);
    const ambiguous = transcript([message(0, 'user', 'one')], [], [record(0, '{"a":1}\n'), record(0, '{"a":2}\n')]);

    // Act / Assert
    should(() => portableConversationRows('session-1', orphaned)).throw(ConversationDigestError, {
      failure: 'incomplete_transcript',
    });
    should(() => portableConversationRows('session-1', ambiguous)).throw(ConversationDigestError, {
      failure: 'incomplete_transcript',
    });
  });

  it('should answer no rows for a complete transcript that carries nothing portable', () => {
    // Arrange: honest emptiness, not a failure to read.
    const batch = transcript([toolCall(0)], [], [record(0, '{"tool":true}\n')]);

    // Act / Assert
    should(portableConversationRows('session-1', batch)).be.empty();
    should(portableConversationRows('session-1', transcript([], [], []))).be.empty();
  });
});
