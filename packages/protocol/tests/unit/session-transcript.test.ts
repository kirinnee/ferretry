import { describe, it } from 'bun:test';
import should from 'should';
import * as transcript from '../../src/lib/session-transcript.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

/**
 * The read surface that makes "fork from here" an honest offer.
 *
 * Two exported schemas, and each one is proved on its own terms: the ROW must still reject unknown
 * keys after being extended from the durable transfer row, and the PAGE must refuse every shape a
 * client could mistake for a coordinate it is allowed to compute.
 */

const AT = '2026-08-06T07:00:00.000Z';

/** A one-message record still states its block index. `0` is a value, never an omission. */
const firstPoint = { v: 1 as const, byteOffset: 0, blockIndex: 0 };
/** Two messages in ONE record share a byte offset and are told apart by the block index alone. */
const sharedOffsetPoint = { v: 1 as const, byteOffset: 4_096, blockIndex: 0 };
const siblingPoint = { v: 1 as const, byteOffset: 4_096, blockIndex: 1 };

const message = {
  point: firstPoint,
  role: 'assistant',
  text: 'The token is [redacted] and the plan stands.',
  timestamp: AT,
  selectionBinding: 'selection-binding-1',
} satisfies transcript.SessionTranscriptMessage;

const page = {
  v: 1,
  sessionId: 'session-1',
  messages: [message],
  nextCursor: 'message-cursor-1',
} satisfies transcript.SessionTranscriptPage;

const cases: SchemaCase[] = [
  // TWO cases, not one. The page contains the row, so a single case over the page would keep
  // passing while the row it embeds drifted — and the row is the half a fork request is built from.
  { name: 'transcript message', schema: transcript.SessionTranscriptMessageSchema, value: message },
  { name: 'transcript page', schema: transcript.SessionTranscriptPageSchema, value: page },
];

describe('the session transcript read protocol', () => {
  it('should round-trip every exported schema through strict served values', () => {
    // Act + Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(transcript, cases);
  });

  it('should still reject unknown keys after extending the durable transfer row', () => {
    // The base is a `strictObject`, and pinned Zod 4.4.3 carries its `catchall: never` through
    // `.extend()`. If that ever stopped holding, a served row could smuggle any field past the
    // client — including one a surface would then treat as an address. This is the assertion that
    // fails first if the pin moves.
    // Act
    const parsed = transcript.SessionTranscriptMessageSchema.parse(message);

    // Assert — the WHOLE key set, not the absence of one name. A different residual field would
    // survive a `should.not.have.property` check and still be a field the daemon never sent.
    should(Object.keys(parsed).sort()).deepEqual(['point', 'role', 'selectionBinding', 'text', 'timestamp']);
    assertRejects([
      {
        name: 'an unknown key on the extended row',
        schema: transcript.SessionTranscriptMessageSchema,
        value: { ...message, blockId: 'record|message|uuid|0' },
      },
      {
        name: 'a raw digest a reader could take offline',
        schema: transcript.SessionTranscriptMessageSchema,
        value: { ...message, rawSha256: 'a'.repeat(64) },
      },
      {
        name: 'the daemon-private provenance the binding is bound to',
        schema: transcript.SessionTranscriptMessageSchema,
        value: { ...message, transcriptProvenance: { v: 1, home: '/daemon/home' } },
      },
      {
        name: 'an unknown key on the page',
        schema: transcript.SessionTranscriptPageSchema,
        value: { ...page, transcriptFingerprint: 'b'.repeat(64) },
      },
      {
        name: 'a page-number surrogate for the opaque cursor',
        schema: transcript.SessionTranscriptPageSchema,
        value: { ...page, page: 2 },
      },
    ]);
  });

  it('should require the exact point, including a block index of zero, and refuse every surrogate', () => {
    // Act
    const parsed = transcript.SessionTranscriptMessageSchema.parse(message);

    // Assert
    should(parsed.point).deepEqual({ v: 1, byteOffset: 0, blockIndex: 0 });
    assertRejects([
      {
        name: 'a one-message record without its block index',
        schema: transcript.SessionTranscriptMessageSchema,
        value: { ...message, point: { v: 1, byteOffset: 0 } },
      },
      {
        name: 'a version-less point',
        schema: transcript.SessionTranscriptMessageSchema,
        value: { ...message, point: { byteOffset: 0, blockIndex: 0 } },
      },
      {
        name: 'a string coordinate',
        schema: transcript.SessionTranscriptMessageSchema,
        value: { ...message, point: '0:0' },
      },
      {
        name: 'a row index standing in for a coordinate',
        schema: transcript.SessionTranscriptMessageSchema,
        value: { ...message, point: 0 },
      },
      {
        name: 'no point at all',
        schema: transcript.SessionTranscriptMessageSchema,
        value: { ...message, point: null },
      },
      {
        name: 'no role',
        schema: transcript.SessionTranscriptMessageSchema,
        value: { point: firstPoint, text: 'x', selectionBinding: 'selection-binding-1' },
      },
      {
        name: 'no text',
        schema: transcript.SessionTranscriptMessageSchema,
        value: { point: firstPoint, role: 'user', selectionBinding: 'selection-binding-1' },
      },
    ]);
  });

  it('should require a nonempty selection binding on every served row', () => {
    // A row without evidence is a row a caller could fork through on the coordinate alone, which is
    // exactly the substitution this field exists to refuse. Optional would make that the default.
    // Arrange
    const { selectionBinding: _binding, ...unbound } = message;

    // Act + Assert
    assertRejects([
      { name: 'no binding', schema: transcript.SessionTranscriptMessageSchema, value: unbound },
      {
        name: 'an empty binding',
        schema: transcript.SessionTranscriptMessageSchema,
        value: { ...message, selectionBinding: '' },
      },
      {
        name: 'a null binding',
        schema: transcript.SessionTranscriptMessageSchema,
        value: { ...message, selectionBinding: null },
      },
      {
        name: 'a structured binding a client could take apart',
        schema: transcript.SessionTranscriptMessageSchema,
        value: { ...message, selectionBinding: { mac: 'a'.repeat(64), point: firstPoint } },
      },
    ]);
  });

  it('should carry its own binding for each row, including rows that read identically', () => {
    // Two messages in one record share a byte offset, and two rows can redact down to the same
    // display text. Neither pair may share evidence: the binding is about the RAW row, so rows that
    // look alike to a reader must still be told apart by the daemon that issued them.
    // Arrange
    const sameOffset = {
      ...page,
      messages: [
        { ...message, point: sharedOffsetPoint, text: 'The token is [redacted].', selectionBinding: 'binding-a' },
        { ...message, point: siblingPoint, text: 'The token is [redacted].', selectionBinding: 'binding-b' },
      ],
      nextCursor: null,
    };

    // Act
    const parsed = transcript.SessionTranscriptPageSchema.parse(sameOffset);

    // Assert
    should(parsed.messages.map(entry => entry.point.blockIndex)).deepEqual([0, 1]);
    should(parsed.messages.map(entry => entry.text)).deepEqual([
      'The token is [redacted].',
      'The token is [redacted].',
    ]);
    should(parsed.messages.map(entry => entry.selectionBinding)).deepEqual(['binding-a', 'binding-b']);
  });

  it('should describe a page by its version, its session and an opaque nullable cursor', () => {
    // Act — the end of the conversation, and an empty page, are both ordinary answers.
    const last = transcript.SessionTranscriptPageSchema.parse({ ...page, nextCursor: null });
    const empty = transcript.SessionTranscriptPageSchema.parse({ ...page, messages: [], nextCursor: null });

    // Assert
    should(last.nextCursor).be.null();
    should(empty.messages).be.empty();
    should(transcript.SessionTranscriptPageSchema.parse(page).nextCursor).equal('message-cursor-1');
    assertRejects([
      { name: 'an unversioned page', schema: transcript.SessionTranscriptPageSchema, value: { ...page, v: undefined } },
      { name: 'a later page version', schema: transcript.SessionTranscriptPageSchema, value: { ...page, v: 2 } },
      {
        name: 'a page that does not say which session it read',
        schema: transcript.SessionTranscriptPageSchema,
        value: { ...page, sessionId: undefined },
      },
      {
        name: 'a blank session id',
        schema: transcript.SessionTranscriptPageSchema,
        value: { ...page, sessionId: '' },
      },
      {
        name: 'no rows at all',
        schema: transcript.SessionTranscriptPageSchema,
        value: { ...page, messages: undefined },
      },
      {
        name: 'an empty cursor, which is not the same fact as the end of the conversation',
        schema: transcript.SessionTranscriptPageSchema,
        value: { ...page, nextCursor: '' },
      },
      {
        name: 'a numeric cursor a client could increment',
        schema: transcript.SessionTranscriptPageSchema,
        value: { ...page, nextCursor: 2 },
      },
      {
        name: 'a cursor unpacked into the coordinate it authenticates',
        schema: transcript.SessionTranscriptPageSchema,
        value: { ...page, nextCursor: { anchor: siblingPoint } },
      },
      {
        name: 'an unbound row inside an otherwise valid page',
        schema: transcript.SessionTranscriptPageSchema,
        value: { ...page, messages: [{ point: firstPoint, role: 'user', text: 'hello' }] },
      },
    ]);
  });
});
