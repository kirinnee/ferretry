import { describe, it } from 'bun:test';
import type { ConversationMessagePoint } from '@ferretry/protocol';
import should from 'should';
import {
  ConversationDigestError,
  digestConversation,
  extendPortableConversationRows,
  extendSessionTranscriptRawPrefix,
  type PortableConversationCheckpoint,
  portableConversationRows,
  sameConversationMessagePoint,
  sessionTranscriptRawPrefixStart,
  startPortableConversation,
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

  it('should refuse an event with no byte offset rather than guessing its position', () => {
    // Arrange
    const unaddressed: TranscriptEvent = { kind: 'message', harness: 'claude', role: 'user', text: 'no offset' };
    const batch = transcript([unaddressed]);

    // Act
    const failure = () => digestConversation('session-1', batch, point(0));

    // Assert
    should(failure).throw(ConversationDigestError, {
      failure: 'incomplete_transcript',
      message: /unaddressable message event/u,
    });
  });

  it('should treat a tool-role message as an omitted harness-specific result, not a portable message', () => {
    // Arrange
    const toolMessage: TranscriptEvent = {
      kind: 'message',
      harness: 'claude',
      role: 'tool',
      text: 'exit 0',
      byteOffset: 40,
    };
    const batch = transcript([message(0, 'user', 'run it'), toolMessage, message(90, 'assistant', 'done')]);

    // Act
    const digest = digestConversation('session-1', batch, point(90));
    const refusal = () => digestConversation('session-1', batch, point(40));

    // Assert
    should(digest.messages.map(entry => entry.text)).eql(['run it', 'done']);
    should(digest.omissions).eql([{ point: point(40), kind: 'tool-result', reason: 'harness-specific' }]);
    should(refusal).throw(ConversationDigestError, {
      failure: 'target_not_message',
      message: 'transcript point 40:0 is not a portable conversation message',
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

/** Record-level evidence: it names a record as a whole, so it carries no block index. */
const usage = (byteOffset: number): TranscriptEvent => ({
  kind: 'usage',
  harness: 'claude',
  role: 'assistant',
  byteOffset,
  usage: { inputTokens: 3, outputTokens: 5 },
});

const turn = (byteOffset: number): TranscriptEvent => ({
  kind: 'turn',
  harness: 'claude',
  role: 'system',
  byteOffset,
  state: 'completed',
});

describe('record-level events that share a point with a block', () => {
  const oneRecord = [record(0, '{"assistant":true}\n')] as const;

  it('should not refuse a message and its usage event at one byte offset', () => {
    // Arrange: a Claude assistant record that reports usage normalizes to both, at block 0.
    const batch = transcript([message(0, 'assistant', 'answer', 0), usage(0)], [], oneRecord);

    // Act
    const rows = portableConversationRows('session-1', batch);
    const digest = digestConversation('session-1', batch, point(0));

    // Assert
    should(rows.map(row => row.text)).eql(['answer']);
    should(digest.through).eql({ v: 1, byteOffset: 0, blockIndex: 0 });
    should(digest.messages.map(entry => entry.text)).eql(['answer']);
    should(sameBytes(digest.selectionEvidence?.rawPrefix, foldChain(...oneRecord))).be.true();
  });

  it('should still cut at the message when the record-level event is listed before it', () => {
    // Arrange
    const batch = transcript([usage(0), turn(0), message(0, 'assistant', 'answer', 0)], [], oneRecord);

    // Act
    const digest = digestConversation('session-1', batch, point(0));

    // Assert
    should(digest.messages.map(entry => entry.text)).eql(['answer']);
    should(digest.omissions.map(entry => entry.kind)).eql(['usage', 'turn']);
  });

  it('should still refuse two block-level events at one point as a duplicate', () => {
    // Arrange: a numbered block is a block, whatever its kind.
    const numbered: TranscriptEvent = { ...usage(0), blockIndex: 0 };
    const batch = transcript([message(0, 'assistant', 'answer', 0), numbered], [], oneRecord);
    const twoMessages = transcript([message(0, 'user', 'a', 0), message(0, 'assistant', 'b', 0)], [], oneRecord);

    // Act / Assert
    should(() => portableConversationRows('session-1', batch)).throw(ConversationDigestError, {
      failure: 'incomplete_transcript',
    });
    should(() => portableConversationRows('session-1', twoMessages)).throw(ConversationDigestError, {
      failure: 'incomplete_transcript',
    });
  });

  it('should refuse a cut at a point held only by a record-level event', () => {
    // Arrange: no block holds byte 40, so the usage there is still the evidence a cut refuses on.
    const records = [record(0, '{"a":1}\n'), record(40, '{"b":2}\n')] as const;
    const batch = transcript([message(0, 'user', 'one'), usage(40)], [], records);
    const turned = transcript([message(0, 'user', 'one'), turn(40)], [], records);

    // Act / Assert
    should(() => digestConversation('session-1', batch, point(40))).throw(ConversationDigestError, {
      failure: 'target_not_message',
    });
    should(() => digestConversation('session-1', turned, point(40))).throw(ConversationDigestError, {
      failure: 'target_not_message',
    });
  });

  it('should refuse an event with no byte offset as unaddressable', () => {
    // Arrange
    const unaddressed: TranscriptEvent = { kind: 'turn', harness: 'claude', role: 'system', state: 'started' };
    const batch = transcript([unaddressed], [], oneRecord);

    // Act / Assert
    should(() => portableConversationRows('session-1', batch)).throw(ConversationDigestError, {
      failure: 'incomplete_transcript',
    });
  });
});

/** The failure a rejected fold carries, or a note that it did not refuse with a digest error. */
const refusalOf = async (promise: Promise<unknown>): Promise<string> =>
  await promise.then(
    () => 'resolved',
    error => (error instanceof ConversationDigestError ? error.failure : 'unexpected error'),
  );

describe('extendPortableConversationRows', () => {
  const records = [
    record(0, '{"m":"one"}\n'),
    record(12, '\n'),
    record(13, '{"m":"two"}\n'),
    record(25, '{"m":"three"}\n'),
  ] as const;
  const events = [message(0, 'user', 'one'), message(13, 'assistant', 'two'), message(25, 'user', 'three')];
  const pacing = (clock: () => number = () => 0) => {
    const yields = { count: 0 };
    return {
      yields,
      pacing: {
        now: clock,
        yieldToLoop: async () => {
          yields.count += 1;
        },
      },
    };
  };
  const checkpointAt = (end: number, ...folded: readonly TranscriptRawRecord[]): PortableConversationCheckpoint => ({
    rawPrefix: foldChain(...folded),
    end,
  });

  it('should start at the chain start with nothing folded', () => {
    // Act
    const actual = startPortableConversation();

    // Assert
    should(actual.end).equal(0);
    should(sameBytes(actual.rawPrefix, sessionTranscriptRawPrefixStart())).be.true();
  });

  it('should give the same rows and chain when one batch is folded in two pieces', async () => {
    // Arrange
    const whole = portableConversationRows('session-1', transcript(events, [], records));
    const { pacing: fake } = pacing();

    // Act
    const first = await extendPortableConversationRows(
      'session-1',
      startPortableConversation(),
      transcript(events.slice(0, 2), [], records.slice(0, 3)),
      fake,
    );
    const second = await extendPortableConversationRows(
      'session-1',
      first.checkpoint,
      transcript(events.slice(2), [], records.slice(3)),
      fake,
    );

    // Assert
    const rows = [...first.rows, ...second.rows];
    should(rows.map(row => row.text)).eql(whole.map(row => row.text));
    should(rows.map(row => row.point)).eql(whole.map(row => row.point));
    for (const [index, row] of rows.entries())
      should(sameBytes(row.rawPrefix, whole[index]?.rawPrefix ?? new Uint8Array())).be.true();
    should(sameBytes(second.checkpoint.rawPrefix, foldChain(...records))).be.true();
    should(second.checkpoint.end).equal(25 + records[3].bytes.byteLength);
  });

  it('should refuse a record that leaves a gap after the checkpoint', async () => {
    // Arrange
    const { pacing: fake } = pacing();

    // Act
    const failure = extendPortableConversationRows(
      'session-1',
      checkpointAt(12, records[0]),
      transcript([], [], [records[2]]),
      fake,
    );

    // Assert
    should(await refusalOf(failure)).equal('incomplete_transcript');
  });

  it('should refuse a record that overlaps bytes already folded', async () => {
    // Arrange
    const { pacing: fake } = pacing();

    // Act
    const failure = extendPortableConversationRows(
      'session-1',
      checkpointAt(13, records[0], records[1]),
      transcript([], [], [records[1]]),
      fake,
    );

    // Assert
    should(await refusalOf(failure)).equal('incomplete_transcript');
  });

  it('should refuse a record that skips ahead after a contiguous one', async () => {
    // Arrange
    const { pacing: fake } = pacing();

    // Act
    const failure = extendPortableConversationRows(
      'session-1',
      startPortableConversation(),
      transcript([], [], [records[0], records[2]]),
      fake,
    );

    // Assert
    should(await refusalOf(failure)).equal('incomplete_transcript');
  });

  it('should refuse a batch that carries no raw records', async () => {
    // Arrange
    const { pacing: fake } = pacing();

    // Act
    const failure = extendPortableConversationRows(
      'session-1',
      startPortableConversation(),
      transcript([message(0, 'user', 'one')]),
      fake,
    );

    // Assert
    should(await refusalOf(failure)).equal('incomplete_transcript');
  });

  it('should refuse an incomplete issue before hashing any record', async () => {
    // Arrange
    const { pacing: fake, yields } = pacing();
    let reads = 0;
    const counting = {
      now: () => {
        reads += 1;
        return 0;
      },
      yieldToLoop: fake.yieldToLoop,
    };
    const batch = transcript(
      [message(0, 'user', 'one')],
      [{ harness: 'claude', code: 'invalid-json', message: 'bad line', recoverable: false }],
      [records[0]],
    );

    // Act
    const failure = extendPortableConversationRows('session-1', startPortableConversation(), batch, counting);

    // Assert
    should(await refusalOf(failure)).equal('incomplete_transcript');
    should(reads).equal(0);
    should(yields.count).equal(0);
  });

  it('should keep the checkpoint and report no last record for a batch with no records', async () => {
    // Arrange
    const { pacing: fake } = pacing();
    const checkpoint = checkpointAt(12, records[0]);

    // Act
    const actual = await extendPortableConversationRows('session-1', checkpoint, transcript([], [], []), fake);

    // Assert
    should(actual.rows).be.empty();
    should(actual.checkpoint.end).equal(12);
    should(sameBytes(actual.checkpoint.rawPrefix, checkpoint.rawPrefix)).be.true();
    should(actual.lastRecord).be.undefined();
    should('lastRecord' in actual).be.false();
  });

  it('should report the last record so extending its before-value gives the checkpoint', async () => {
    // Arrange
    const { pacing: fake } = pacing();

    // Act
    const actual = await extendPortableConversationRows(
      'session-1',
      startPortableConversation(),
      transcript(events.slice(0, 2), [], records.slice(0, 3)),
      fake,
    );

    // Assert
    should(actual.lastRecord?.byteOffset).equal(13);
    should(actual.lastRecord?.byteLength).equal(records[2].bytes.byteLength);
    should(
      sameBytes(
        extendSessionTranscriptRawPrefix(actual.lastRecord?.before ?? new Uint8Array(), records[2].bytes),
        actual.checkpoint.rawPrefix,
      ),
    ).be.true();
    should(sameBytes(actual.lastRecord?.before, foldChain(records[0], records[1]))).be.true();
  });

  it('should yield to the loop once the clock passes the budget between records', async () => {
    // Arrange: every reading of the clock is 13 ms after the last, so each record is over budget.
    let now = 0;
    const { pacing: fake, yields } = pacing(() => {
      now += 13;
      return now;
    });

    // Act
    const actual = await extendPortableConversationRows(
      'session-1',
      startPortableConversation(),
      transcript(events, [], records),
      fake,
    );

    // Assert
    should(yields.count).be.greaterThan(0);
    should(sameBytes(actual.checkpoint.rawPrefix, foldChain(...records))).be.true();
  });

  it('should not yield while the clock stays inside the budget', async () => {
    // Arrange
    const { pacing: fake, yields } = pacing(() => 5);

    // Act
    await extendPortableConversationRows(
      'session-1',
      startPortableConversation(),
      transcript(events, [], records),
      fake,
    );

    // Assert
    should(yields.count).equal(0);
  });
});
