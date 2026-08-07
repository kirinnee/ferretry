import { createHmac } from 'node:crypto';
import { describe, it } from 'bun:test';
import type { ConversationMessagePoint, TranscriptProvenance } from '@ferretry/protocol';
import should from 'should';
import {
  extendSessionTranscriptRawPrefix,
  frameSessionTranscriptValue,
  issueSessionTranscriptMessageToken,
  readSessionTranscriptMessageCursor,
  SESSION_TRANSCRIPT_MESSAGE_TOKEN_CURSOR_DOMAIN,
  SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
  SESSION_TRANSCRIPT_MESSAGE_TOKEN_TAG_BYTES,
  SESSION_TRANSCRIPT_PROVENANCE_FRAMERS,
  type SessionTranscriptMessageTokenCodec,
  type SessionTranscriptMessageTokenContext,
  SessionTranscriptMessageTokenError,
  sessionTranscriptRawPrefixStart,
  sessionTranscriptUnsigned64,
  verifySessionTranscriptMessageToken,
} from '../../../../src/lib/session/transcript/index.ts';

/**
 * The token owner, proved without a key file.
 *
 * The codec here is a real HMAC over a fixed key, because the properties under test are about the
 * FRAMING — what a tag commits to, and what two different contexts must not share. A stub that
 * returned its input would prove none of them.
 */
const codecOver = (key: string | Uint8Array): SessionTranscriptMessageTokenCodec => ({
  tag: async input => createHmac('sha256', key).update(input).digest(),
  matches: async (input, tag) => Buffer.from(createHmac('sha256', key).update(input).digest()).equals(Buffer.from(tag)),
});

const codec = codecOver('daemon-key');
const otherKeyCodec = codecOver('another-daemon-key');

const point = (byteOffset: number, blockIndex = 0): ConversationMessagePoint => ({ v: 1, byteOffset, blockIndex });

/** Every optional present, so a test can remove exactly one and see the tag move. */
const provenance: TranscriptProvenance = {
  v: 1,
  home: '/home/agent/.claude',
  harnessSessionId: 'harness-1',
  identity: 'correlated',
  baseline: ['rollout-a', 'rollout-b'],
  correlationToken: 'session-directory-token',
  file: '/home/agent/.claude/projects/-work/minted.jsonl',
  resolvedAt: '2025-01-01T00:00:00+00:00',
};

const context: SessionTranscriptMessageTokenContext = {
  sessionId: 'session-1',
  incarnation: 'inc-1',
  provenance,
};

const withProvenance = (change: Partial<TranscriptProvenance>): SessionTranscriptMessageTokenContext => ({
  ...context,
  provenance: { ...provenance, ...change },
});

const RAW_PREFIX = extendSessionTranscriptRawPrefix(sessionTranscriptRawPrefixStart(), Buffer.from('{"a":1}\n'));
const OTHER_PREFIX = extendSessionTranscriptRawPrefix(sessionTranscriptRawPrefixStart(), Buffer.from('{"a":2}\n'));

const selection = async (
  where: SessionTranscriptMessageTokenContext = context,
  rawPrefix: Uint8Array = RAW_PREFIX,
  at: ConversationMessagePoint = point(40),
): Promise<string> =>
  await issueSessionTranscriptMessageToken(
    codec,
    SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
    where,
    at,
    rawPrefix,
  );

const cursor = async (at: ConversationMessagePoint = point(40)): Promise<string> =>
  await issueSessionTranscriptMessageToken(
    codec,
    SESSION_TRANSCRIPT_MESSAGE_TOKEN_CURSOR_DOMAIN,
    context,
    at,
    RAW_PREFIX,
  );

describe('session transcript framing', () => {
  it('should refuse a numeric field that cannot be an unsigned 64-bit value', () => {
    // Arrange / Act / Assert: a rounded offset would address a different message under a tag that
    // still verified, so the encoding refuses rather than narrows.
    should(() => sessionTranscriptUnsigned64(-1)).throw(RangeError);
    should(() => sessionTranscriptUnsigned64(1.5)).throw(RangeError);
    should(() => sessionTranscriptUnsigned64(Number.MAX_SAFE_INTEGER + 2)).throw(RangeError);
    should(Buffer.from(sessionTranscriptUnsigned64(1)).toString('hex')).equal('0000000000000001');
  });

  it('should length-prefix a value so no two different field lists spell the same bytes', () => {
    // Arrange: the classic canonicalisation defect — 'a' + 'bc' against 'ab' + 'c'.
    const left = Buffer.concat([frameSessionTranscriptValue('a'), frameSessionTranscriptValue('bc')]);
    const right = Buffer.concat([frameSessionTranscriptValue('ab'), frameSessionTranscriptValue('c')]);

    // Act / Assert
    should(left.equals(right)).be.false();
    should(Buffer.from(frameSessionTranscriptValue('a')).toString('hex')).equal('000000000000000161');
    should(Buffer.from(frameSessionTranscriptValue(Uint8Array.of(7, 8))).toString('hex')).equal('00000000000000020708');
  });
});

describe('session transcript raw-prefix chain', () => {
  it('should start from the domain alone and move for every record it folds', () => {
    // Arrange
    const start = sessionTranscriptRawPrefixStart();

    // Act
    const first = extendSessionTranscriptRawPrefix(start, Buffer.from('{"a":1}\n'));
    const second = extendSessionTranscriptRawPrefix(first, Buffer.from('{"a":2}\n'));

    // Assert
    should(start).have.length(SESSION_TRANSCRIPT_MESSAGE_TOKEN_TAG_BYTES);
    should(Buffer.from(start).equals(Buffer.from(first))).be.false();
    should(Buffer.from(first).equals(Buffer.from(second))).be.false();
    should(
      Buffer.from(extendSessionTranscriptRawPrefix(start, Buffer.from('{"a":1}\n'))).equals(Buffer.from(first)),
    ).be.true();
  });

  it('should separate two records from one record holding the same bytes', () => {
    // Arrange: the boundary is part of the statement, so a differently split file is a different
    // prefix even when its bytes concatenate to the same thing.
    const start = sessionTranscriptRawPrefixStart();

    // Act
    const split = extendSessionTranscriptRawPrefix(
      extendSessionTranscriptRawPrefix(start, Buffer.from('{"a":1}\n')),
      Buffer.from('{"a":2}\n'),
    );
    const joined = extendSessionTranscriptRawPrefix(start, Buffer.from('{"a":1}\n{"a":2}\n'));

    // Assert
    should(Buffer.from(split).equals(Buffer.from(joined))).be.false();
  });

  it('should keep two DIFFERENT invalid-UTF-8 records apart', () => {
    // Arrange: both decode to U+FFFD, which is exactly how a decoded-string chain collapses them
    // into one commitment and lets either replace the other at the same coordinate.
    const start = sessionTranscriptRawPrefixStart();
    const left = Uint8Array.of(0x7b, 0xff, 0x7d, 0x0a);
    const right = Uint8Array.of(0x7b, 0xfe, 0x7d, 0x0a);

    // Act
    const leftChain = extendSessionTranscriptRawPrefix(start, left);
    const rightChain = extendSessionTranscriptRawPrefix(start, right);

    // Assert
    should(new TextDecoder().decode(left)).equal(new TextDecoder().decode(right));
    should(Buffer.from(leftChain).equals(Buffer.from(rightChain))).be.false();
  });
});

describe('session transcript message tokens', () => {
  it('should issue a selection binding that is a tag and nothing else', async () => {
    // Act
    const binding = await selection();

    // Assert: no payload, no point, no provenance, no raw fingerprint — one opaque tag.
    should(binding).match(/^s1\.[A-Za-z0-9_-]{43}$/u);
    should(binding).not.containEql(Buffer.from(RAW_PREFIX).toString('base64url'));
    should(binding).not.containEql(Buffer.from(RAW_PREFIX).toString('hex'));
    should(binding).not.containEql('session-1');
    should(binding).not.containEql('minted.jsonl');
  });

  it('should issue a cursor whose only recoverable content is the public point', async () => {
    // Act
    const issued = await cursor(point(120, 2));

    // Assert
    should(issued).match(/^c1\.[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{43}$/u);
    should(readSessionTranscriptMessageCursor(issued)).eql({ v: 1, byteOffset: 120, blockIndex: 2 });
    should(issued).not.containEql(Buffer.from(RAW_PREFIX).toString('base64url'));
    should(issued).not.containEql('/home/agent/.claude');
  });

  it('should accept exactly the row it was issued for', async () => {
    // Arrange
    const binding = await selection();
    const issued = await cursor();

    // Act / Assert
    should(
      await verifySessionTranscriptMessageToken(
        codec,
        SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
        context,
        point(40),
        RAW_PREFIX,
        binding,
      ),
    ).equal('accepted');
    should(
      await verifySessionTranscriptMessageToken(
        codec,
        SESSION_TRANSCRIPT_MESSAGE_TOKEN_CURSOR_DOMAIN,
        context,
        point(40),
        RAW_PREFIX,
        issued,
      ),
    ).equal('accepted');
  });

  it('should refuse a selection binding presented as a cursor tag and the reverse', async () => {
    // Arrange: the domain is inside the tag, so relabelling the envelope cannot move it.
    const binding = await selection();
    const issued = await cursor();
    const relabelled = `s1.${issued.split('.')[2] ?? ''}`;

    // Act / Assert
    should(
      await verifySessionTranscriptMessageToken(
        codec,
        SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
        context,
        point(40),
        RAW_PREFIX,
        relabelled,
      ),
    ).equal('stale');
    should(
      await verifySessionTranscriptMessageToken(
        codec,
        SESSION_TRANSCRIPT_MESSAGE_TOKEN_CURSOR_DOMAIN,
        context,
        point(40),
        RAW_PREFIX,
        binding,
      ),
    ).equal('malformed');
  });

  it('should answer one refusal for every well-formed disagreement', async () => {
    // Arrange
    const binding = await selection();
    const verify = async (
      where: SessionTranscriptMessageTokenContext,
      at: ConversationMessagePoint,
      rawPrefix: Uint8Array,
      token = binding,
      over = codec,
    ): Promise<string> =>
      await verifySessionTranscriptMessageToken(
        over,
        SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
        where,
        at,
        rawPrefix,
        token,
      );

    // Act / Assert: replaced raw content, a moved point, another session, another run of it,
    // re-resolved provenance, a tampered tag and another daemon's key are ONE answer.
    should(await verify(context, point(40), OTHER_PREFIX)).equal('stale');
    should(await verify(context, point(41), RAW_PREFIX)).equal('stale');
    should(await verify(context, point(40, 1), RAW_PREFIX)).equal('stale');
    should(await verify({ ...context, sessionId: 'session-2' }, point(40), RAW_PREFIX)).equal('stale');
    should(await verify({ ...context, incarnation: 'inc-2' }, point(40), RAW_PREFIX)).equal('stale');
    should(await verify(withProvenance({ file: '/home/agent/.claude/other.jsonl' }), point(40), RAW_PREFIX)).equal(
      'stale',
    );
    should(await verify(context, point(40), RAW_PREFIX, `s1.${'A'.repeat(43)}`)).equal('stale');
    should(await verify(context, point(40), RAW_PREFIX, binding, otherKeyCodec)).equal('stale');
  });

  it('should call malformed only what is not a token of that domain at all', async () => {
    // Arrange
    const malformed = [
      '',
      'plain-string',
      's1',
      's1.',
      `s2.${'A'.repeat(43)}`,
      `s1.${'A'.repeat(42)}`,
      `s1.${'A'.repeat(44)}`,
      `s1.${'A'.repeat(42)}+`,
      `s1.${'A'.repeat(43)}.extra`,
    ];

    // Act / Assert
    for (const token of malformed) {
      should(
        await verifySessionTranscriptMessageToken(
          codec,
          SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
          context,
          point(40),
          RAW_PREFIX,
          token,
        ),
      ).equal('malformed');
    }
  });

  it('should read no point out of a malformed cursor', async () => {
    // Arrange
    const issued = await cursor();
    const tag = issued.split('.')[2] ?? '';
    const unsafe = Buffer.alloc(24);
    unsafe.writeBigUInt64BE(1n, 0);
    unsafe.writeBigUInt64BE(2n ** 63n, 8);
    const versionTwo = Buffer.alloc(24);
    versionTwo.writeBigUInt64BE(2n, 0);

    // Act / Assert: syntax, an offset no JavaScript number can hold, and a coordinate version this
    // release does not define are all "not a cursor", never a stale one.
    should(readSessionTranscriptMessageCursor('c1.short.tag')).be.undefined();
    should(readSessionTranscriptMessageCursor(`s1.${tag}`)).be.undefined();
    should(readSessionTranscriptMessageCursor(`c1.${'A'.repeat(32)}`)).be.undefined();
    should(readSessionTranscriptMessageCursor(`c1.${'*'.repeat(32)}.${tag}`)).be.undefined();
    should(readSessionTranscriptMessageCursor(`c1.${'A'.repeat(32)}.${'*'.repeat(43)}`)).be.undefined();
    should(readSessionTranscriptMessageCursor(`c1.${unsafe.toString('base64url')}.${tag}`)).be.undefined();
    should(readSessionTranscriptMessageCursor(`c1.${versionTwo.toString('base64url')}.${tag}`)).be.undefined();
  });
});

/**
 * KNOWN-ANSWER VECTORS. These literals are the only thing pinning the actual BYTES.
 *
 * Every other assertion in this file is structural or a round-trip, and a round-trip re-derives the
 * expectation from the same code it is checking. The MAC's field order is the declaration order of
 * the exhaustive framer record: deterministic, but invisible. Alphabetise that literal, or reorder
 * it during a refactor, and every token's bytes change while every structural test still passes —
 * after which every outstanding cursor and binding reports "the content changed", which is false.
 * The exhaustive `Record` proves no member is MISSING and says nothing about ORDER; this is the
 * other half.
 *
 * The expected values were produced by an INDEPENDENT reference calculation
 * (`vectors/reference-vectors.ts` in the authoring session's coordination directory, preserved with
 * its output) written from the frozen framing specification, importing nothing from this repository
 * and calling nothing from the code under test.
 *
 * IF ONE OF THESE FAILS, DO NOT UPDATE THE LITERAL. It means the wire format moved, and the change
 * that moved it needs a token version bump rather than a new expectation.
 */
describe('session transcript token known-answer vectors', () => {
  const vectorCodec = codecOver(Buffer.alloc(32, 0x2a));
  const VECTOR_RECORD = Buffer.from('{"vector":true}\n', 'utf8');
  const VECTOR_RECORD_A = Buffer.from('{"a":1}\n', 'utf8');
  const VECTOR_RECORD_B = Buffer.from('{"b":2}\n', 'utf8');
  const VECTOR_H0 = '4e2a14f6d49080bcc589e28d7bcaa8bc148083124beadee601791e73115245a0';
  const VECTOR_H1 = '7aa7dad13a51ba9323fc7174631f68aac3f27e22f3a3a4ff389d053865f62d69';
  const VECTOR_CHAIN_A = 'caa3dc0daf59dc3d8b9eefae649fce2cddb7236bf3db0300b1134c20a14845b1';
  const VECTOR_CHAIN_AB = '4387982917e554df5e2d9866069aa6ecee7935b35831166a5957226ff728e25f';
  const VECTOR_CHAIN_JOINED = '7b6e307dbf5922a183e52e5f99c9df1fe9a2197b2fe44c759522dc62113862b8';
  const VECTOR_SELECTION = 's1.d18fChF2RG_0tPAyo_cKhCA04PWKM32Xkb_AK1XCtUs';
  const VECTOR_SELECTION_WITHOUT_OPTIONALS = 's1.uRiRlrEGdYTVPrmsc4dI9jPXZ0viFe-bjLyp_yDJc5Q';
  const VECTOR_CURSOR = 'c1.AAAAAAAAAAEAAAAAAAAQAAAAAAAAAAAD.8nCYphkVRWQaz287czXsn1Z-C8NbEPxuP2gogbr3o7M';

  const vectorContext: SessionTranscriptMessageTokenContext = {
    sessionId: 'session-vector',
    incarnation: 'inc-vector',
    provenance: {
      v: 1,
      home: '/home/agent/.claude',
      harnessSessionId: 'harness-vector',
      identity: 'correlated',
      baseline: ['rollout-a', 'rollout-b'],
      correlationToken: 'token-vector',
      file: '/home/agent/.claude/projects/-work/vector.jsonl',
      resolvedAt: '2025-01-01T00:00:00+00:00',
    },
  };
  const vectorPoint = point(4096, 3);

  it('should produce the pinned chain values for a fixed record', () => {
    // Act
    const start = sessionTranscriptRawPrefixStart();
    const first = extendSessionTranscriptRawPrefix(start, VECTOR_RECORD);

    // Assert
    should(Buffer.from(start).toString('hex')).equal(VECTOR_H0);
    should(Buffer.from(first).toString('hex')).equal(VECTOR_H1);
  });

  it('should produce the pinned chain values over a known two-record input', () => {
    // Arrange / Act: both chain domains and the step order are exercised — the start domain once,
    // then the row domain per record, each folding the previous VALUE rather than re-reading the
    // prefix. The joined case proves the boundary is part of the statement.
    const start = sessionTranscriptRawPrefixStart();
    const afterA = extendSessionTranscriptRawPrefix(start, VECTOR_RECORD_A);
    const afterAB = extendSessionTranscriptRawPrefix(afterA, VECTOR_RECORD_B);
    const joined = extendSessionTranscriptRawPrefix(start, Buffer.concat([VECTOR_RECORD_A, VECTOR_RECORD_B]));

    // Assert
    should(Buffer.from(afterA).toString('hex')).equal(VECTOR_CHAIN_A);
    should(Buffer.from(afterAB).toString('hex')).equal(VECTOR_CHAIN_AB);
    should(Buffer.from(joined).toString('hex')).equal(VECTOR_CHAIN_JOINED);
  });

  it('should produce the pinned selection binding and cursor for a fixed key, context and point', async () => {
    // Arrange: every provenance member is present, so the vector pins the complete field order.
    const rawPrefix = extendSessionTranscriptRawPrefix(sessionTranscriptRawPrefixStart(), VECTOR_RECORD);

    // Act
    const binding = await issueSessionTranscriptMessageToken(
      vectorCodec,
      SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
      vectorContext,
      vectorPoint,
      rawPrefix,
    );
    const issuedCursor = await issueSessionTranscriptMessageToken(
      vectorCodec,
      SESSION_TRANSCRIPT_MESSAGE_TOKEN_CURSOR_DOMAIN,
      vectorContext,
      vectorPoint,
      rawPrefix,
    );

    // The same context with every optional ABSENT, which freezes the presence discriminators as
    // well as the field order. An identified transcript must name its harness session and its file,
    // so the coherent all-absent shape is the undiscovered one.
    const bare = await issueSessionTranscriptMessageToken(
      vectorCodec,
      SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
      {
        ...vectorContext,
        provenance: { v: 1, home: '/home/agent/.claude', identity: 'undiscovered' },
      },
      vectorPoint,
      rawPrefix,
    );

    // Assert
    should(binding).equal(VECTOR_SELECTION);
    should(bare).equal(VECTOR_SELECTION_WITHOUT_OPTIONALS);
    should(issuedCursor).equal(VECTOR_CURSOR);
    should(
      await verifySessionTranscriptMessageToken(
        vectorCodec,
        SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
        vectorContext,
        vectorPoint,
        rawPrefix,
        VECTOR_SELECTION,
      ),
    ).equal('accepted');
  });
});

describe('session transcript token provenance framing', () => {
  it('should frame every provenance member, so changing any one of them moves the tag', async () => {
    // Arrange
    const baseline = await selection();
    const changed: readonly SessionTranscriptMessageTokenContext[] = [
      withProvenance({ home: '/home/other/.claude' }),
      withProvenance({ harnessSessionId: 'harness-2' }),
      withProvenance({ identity: 'minted' }),
      withProvenance({ baseline: ['rollout-a', 'rollout-c'] }),
      withProvenance({ correlationToken: 'another-token' }),
      withProvenance({ file: '/home/agent/.claude/projects/-work/other.jsonl' }),
      withProvenance({ resolvedAt: '2025-06-01T00:00:00+00:00' }),
    ];

    // Act / Assert: the exhaustive literal is the emission order, so its own key list is the
    // contract — one framer per member, in the sequence the bytes come out in.
    should(Object.keys(SESSION_TRANSCRIPT_PROVENANCE_FRAMERS)).eql([
      'v',
      'home',
      'harnessSessionId',
      'identity',
      'baseline',
      'correlationToken',
      'file',
      'resolvedAt',
    ]);
    for (const where of changed) should(await selection(where)).not.equal(baseline);
  });

  it('should distinguish an absent optional, an empty array and a differently split array', async () => {
    // Arrange: "no baseline", "an empty baseline" and two spellings of the same characters are three
    // different provenances, and an unframed concatenation would spell two of them identically.
    const present = await selection(withProvenance({ baseline: ['ab'] }));

    // Act
    const empty = await selection(withProvenance({ baseline: [] }));
    const split = await selection(withProvenance({ baseline: ['a', 'b'] }));
    const absent = await selection({
      ...context,
      provenance: { v: 1, home: provenance.home, identity: 'undiscovered' },
    });

    // Assert
    should(new Set([present, empty, split, absent]).size).equal(4);
  });

  it('should strip an unknown key rather than letting it travel unframed', async () => {
    // Arrange: the provenance schema is a plain object, so parsing drops what it does not declare.
    // Two contexts differing only there are ONE context, and the tag says so.
    const decorated = { ...provenance, plantedByAnAttacker: 'ignored' } as TranscriptProvenance;

    // Act
    const withUnknownKey = await selection({ ...context, provenance: decorated });

    // Assert
    should(withUnknownKey).equal(await selection());
  });

  it('should refuse a commitment that is not the frozen 32-byte width', async () => {
    // Arrange: a miswired source must not be able to mint a second token vocabulary under the same
    // domain — tags that verify against each other and against nothing the real chain produces.
    const short = RAW_PREFIX.subarray(0, 31);
    const long = Buffer.concat([Buffer.from(RAW_PREFIX), Buffer.of(0)]);

    // Act / Assert
    await should(selection(context, short)).be.rejectedWith(SessionTranscriptMessageTokenError);
    await should(selection(context, long)).be.rejectedWith(SessionTranscriptMessageTokenError);
    for (const rawPrefix of [short, long]) {
      should(
        await verifySessionTranscriptMessageToken(
          codec,
          SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
          context,
          point(40),
          rawPrefix,
          await selection(),
        ),
      ).equal('stale');
    }
  });

  it('should refuse a coordinate the protocol schema rejects, before it frames anything', async () => {
    // Arrange: the encoding's own range checks only reject what they cannot REPRESENT. The durable
    // contract is narrower — `v` is exactly 1 — so an internally miswired coordinate must never
    // mint, and must never verify, under a version this release does not define.
    const invalid = [
      { v: 2, byteOffset: 40, blockIndex: 0 },
      { v: 1, byteOffset: -1, blockIndex: 0 },
      { v: 1, byteOffset: 40, blockIndex: -1 },
      { v: 1, byteOffset: 1.5, blockIndex: 0 },
      { v: 1, byteOffset: Number.MAX_SAFE_INTEGER + 2, blockIndex: 0 },
      { v: 1, byteOffset: 40 },
    ] as unknown as readonly ConversationMessagePoint[];

    // Act / Assert
    for (const at of invalid) {
      await should(selection(context, RAW_PREFIX, at)).be.rejectedWith(SessionTranscriptMessageTokenError);
      should(
        await verifySessionTranscriptMessageToken(
          codec,
          SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
          context,
          at,
          RAW_PREFIX,
          await selection(),
        ),
      ).equal('stale');
    }
  });

  it('should carry the framed point bytes in the cursor envelope, not a second spelling', async () => {
    // Arrange / Act: the envelope's point must round-trip to exactly the coordinate the tag covers.
    const issued = await cursor(point(4096, 3));
    const recovered = readSessionTranscriptMessageCursor(issued);

    // Assert
    should(recovered).eql({ v: 1, byteOffset: 4096, blockIndex: 3 });
    should(
      await verifySessionTranscriptMessageToken(
        codec,
        SESSION_TRANSCRIPT_MESSAGE_TOKEN_CURSOR_DOMAIN,
        context,
        recovered ?? point(0),
        RAW_PREFIX,
        issued,
      ),
    ).equal('accepted');
  });

  it('should refuse to emit a token whose tag is not a full 32-byte HMAC', async () => {
    // Arrange: a truncating codec would emit a string this module's own parser rejects, surfacing
    // later as "your selection is stale" rather than as the wiring fault it is.
    const truncating: SessionTranscriptMessageTokenCodec = {
      tag: async input => (await codec.tag(input)).subarray(0, 16),
      matches: async () => false,
    };

    // Act / Assert
    await should(
      issueSessionTranscriptMessageToken(
        truncating,
        SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
        context,
        point(40),
        RAW_PREFIX,
      ),
    ).be.rejectedWith(SessionTranscriptMessageTokenError);
  });

  it('should refuse to issue over a provenance the schema rejects, and fail closed on verify', async () => {
    // Arrange: an identified transcript that names no file breaks the schema's own refinement.
    const broken = { ...provenance, file: undefined } as TranscriptProvenance;
    const brokenContext: SessionTranscriptMessageTokenContext = { ...context, provenance: broken };

    // Act / Assert
    await should(selection(brokenContext)).be.rejectedWith(SessionTranscriptMessageTokenError);
    should(
      await verifySessionTranscriptMessageToken(
        codec,
        SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN,
        brokenContext,
        point(40),
        RAW_PREFIX,
        await selection(),
      ),
    ).equal('stale');
  });
});
