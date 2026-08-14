/**
 * The transcript's cryptographic framing, the rolling commitment to a session's raw conversation
 * prefix, and the two opaque tokens bound to it.
 *
 * WHY A TOKEN AT ALL. A durable coordinate proves where a message was, never that it is still the
 * same message. An operator picks a row, and by the time preparation runs the harness may have
 * rewritten that byte range with different words. Forking the replacement silently is the defect
 * this module exists to make impossible: a selection carries evidence about the RAW prefix it was
 * taken from, and preparation refuses when that evidence no longer holds.
 *
 * WHY IT IS A MAC AND NOT A DIGEST. A bare hash of raw text published beside redacted text is an
 * offline oracle: a holder can guess a secret, hash it, and confirm the guess against a row whose
 * display was redacted precisely so they could not read it. So nothing derived from raw content
 * ever reaches the wire. What reaches the wire is a fixed-size tag under a daemon-private key, and
 * the only thing anyone can do with it is hand it back.
 *
 * WHAT THE DOMAIN GETS. `SessionTranscriptMessageTokenCodec` — two operations, no key bytes. The
 * key lives in one adapter, comparison is constant-time there, and no code path in this package can
 * read it. A getter would delete the property this whole design is for.
 *
 * WHY THE COMMITMENT IS OVER PHYSICAL RECORDS. `H_i` chains the exact bytes the ONE complete parser
 * consumed for each physical record, terminator included, rather than the normalized message it
 * produced. Normalization is lossy by design — it drops harness-specific structure — and two
 * different raw records that normalize to identical text would otherwise share a commitment and be
 * free to replace each other. Records the parser completes but carries no event for stay in the
 * chain for the same reason. Every message block of one record binds that record's `H_i`; the
 * required `blockIndex` is what tells those blocks apart.
 *
 * WHY EVERYTHING IS LENGTH-FRAMED. `frame(x)` is a u64 big-endian byte length followed by exactly
 * `x`. Concatenating variable-width fields without it is the classic canonicalisation defect: `a` +
 * `bc` and `ab` + `c` are one string, so one tag authenticates two different tuples and an attacker
 * picks which one it meant. Optional members carry an explicit absent/present byte, and arrays a
 * u64 element count, so "no baseline" and "an empty baseline" cannot spell the same bytes either.
 */

import { createHash } from 'node:crypto';
import {
  type ConversationMessagePoint,
  type ExactConversationMessagePoint,
  ExactConversationMessagePointSchema,
  type TranscriptProvenance,
  TranscriptProvenanceSchema,
} from '@ferretry/protocol';

/** The envelope every token tag is taken under, so no other Ferretry MAC can be read as one. */
const SESSION_TRANSCRIPT_MESSAGE_TOKEN_ENVELOPE = 'ferretry.session-transcript.message-token.v1';

/** The domain of a row-selection binding, carried in the tag rather than beside it. */
export const SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN = 'selection';

/** The domain of a pagination cursor. Distinct from selection, so neither tag can stand in for the other. */
export const SESSION_TRANSCRIPT_MESSAGE_TOKEN_CURSOR_DOMAIN = 'cursor';

export type SessionTranscriptMessageTokenDomain =
  | typeof SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN
  | typeof SESSION_TRANSCRIPT_MESSAGE_TOKEN_CURSOR_DOMAIN;

/** The rolling-commitment domains: a chain start and a chain step are different statements. */
const SESSION_TRANSCRIPT_RAW_PREFIX_DOMAIN = 'ferretry.session-transcript.raw-prefix.v1';
const SESSION_TRANSCRIPT_RAW_PREFIX_ROW_DOMAIN = 'ferretry.session-transcript.raw-prefix-row.v1';

/** SHA-256 and HMAC-SHA-256 are both 32 bytes wide here. Tags are never truncated. */
export const SESSION_TRANSCRIPT_MESSAGE_TOKEN_TAG_BYTES = 32;

/**
 * The commitment width, checked rather than assumed.
 *
 * A value of another width is not a chain value from this module, so whatever produced it is
 * miswired. Framing it anyway would mint a second, silently different token vocabulary under the
 * same domain — tags that verify against each other and against nothing the real chain produces.
 */
export const SESSION_TRANSCRIPT_RAW_PREFIX_BYTES = 32;

/** A 32-byte tag as unpadded base64url is exactly 43 characters, and nothing else is accepted. */
const TAG_TEXT = /^[A-Za-z0-9_-]{43}$/u;

/** Three u64 point fields are 24 bytes, which is exactly 32 unpadded base64url characters. */
const POINT_TEXT = /^[A-Za-z0-9_-]{32}$/u;

const SELECTION_BINDING_PREFIX = 's1';
const CURSOR_PREFIX = 'c1';

const UNSIGNED_64_BYTES = 8;
const ABSENT = Uint8Array.of(0);
const PRESENT = Uint8Array.of(1);

/**
 * One fixed-width unsigned 64-bit big-endian field.
 *
 * Fixed width is why numbers are not framed: their length is a property of the encoding rather than
 * of the value. A value outside the safe-integer range is refused rather than silently rounded — a
 * rounded offset would address a different message under a tag that still verified.
 */
export function sessionTranscriptUnsigned64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${String(value)} is not an unsigned 64-bit transcript field this encoding can carry`);
  const encoded = Buffer.alloc(UNSIGNED_64_BYTES);
  encoded.writeBigUInt64BE(BigInt(value));
  return encoded;
}

/** `frame(x)`: the u64 byte length of `x`, then exactly `x`. Text is UTF-8. */
export function frameSessionTranscriptValue(value: Uint8Array | string): Uint8Array {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return Buffer.concat([sessionTranscriptUnsigned64(bytes.length), bytes]);
}

/** An optional member: one absent/present byte, and the framed value only when it is present. */
function frameOptional(value: string | undefined): Uint8Array {
  return value === undefined ? ABSENT : Buffer.concat([PRESENT, frameSessionTranscriptValue(value)]);
}

/** An optional array: the presence byte, then a framed body of a u64 count and each framed element. */
function frameOptionalArray(values: readonly string[] | undefined): Uint8Array {
  if (values === undefined) return ABSENT;
  const body = Buffer.concat([
    sessionTranscriptUnsigned64(values.length),
    ...values.map(value => frameSessionTranscriptValue(value)),
  ]);
  return Buffer.concat([PRESENT, frameSessionTranscriptValue(body)]);
}

/** `H_0`: the commitment to an empty raw prefix, which is the domain and nothing else. */
export function sessionTranscriptRawPrefixStart(): Uint8Array {
  return createHash('sha256').update(frameSessionTranscriptValue(SESSION_TRANSCRIPT_RAW_PREFIX_DOMAIN)).digest();
}

/**
 * `H_i = SHA-256(frame(row-domain) || frame(H_(i-1)) || frame(raw_i))`.
 *
 * One fixed-cost step per physical record. The previous VALUE is folded in rather than the previous
 * prefix being re-read, which is what makes a page of k rows one transcript pass plus k hashes
 * instead of k passes over the prefix.
 */
export function extendSessionTranscriptRawPrefix(previous: Uint8Array, rawRecord: Uint8Array): Uint8Array {
  return createHash('sha256')
    .update(frameSessionTranscriptValue(SESSION_TRANSCRIPT_RAW_PREFIX_ROW_DOMAIN))
    .update(frameSessionTranscriptValue(previous))
    .update(frameSessionTranscriptValue(rawRecord))
    .digest();
}

/**
 * Everything a tag is taken over besides the row itself: which session, which run of it, and the
 * exact transcript record the daemon resolved for it.
 *
 * The incarnation and the provenance are in the tuple because a coordinate means nothing without
 * them. The same byte offset in a relaunched session, or in a transcript file the daemon later
 * re-resolved to somebody else's rollout, is a different message; a tag that omitted them would
 * verify across that replacement.
 */
export interface SessionTranscriptMessageTokenContext {
  readonly sessionId: string;
  readonly incarnation: string;
  /**
   * The pinned provenance this page was resolved through.
   *
   * Every optional member is encoded with an explicit presence byte, so a provenance that later
   * gains a field it did not have is a different context rather than the same one. Whether the
   * provenance is COMPLETE is the caller's decision to make and to refuse on: this module states
   * what a tag covers, never whether a session should have been served at all.
   */
  readonly provenance: TranscriptProvenance;
}

/**
 * The two operations a domain caller gets. Never the key, and never a comparison it could perform
 * with `===`: a MAC compared byte-by-byte with early exit leaks the tag one position at a time.
 */
export interface SessionTranscriptMessageTokenCodec {
  /** The full 32-byte HMAC-SHA-256 tag over this exact input. */
  tag(input: Uint8Array): Promise<Uint8Array>;
  /** Whether `tag` is the tag for `input`, decided in constant time. */
  matches(input: Uint8Array, tag: Uint8Array): Promise<boolean>;
}

/** Why a token was not accepted. Every well-formed disagreement is one answer, so it is no oracle. */
export type SessionTranscriptMessageTokenVerdict = 'accepted' | 'stale' | 'malformed';

/** How one provenance member becomes bytes. Every member has exactly one, and it is total. */
type TranscriptProvenanceFramer = (provenance: TranscriptProvenance) => Uint8Array;

/**
 * One framer per provenance member, EXHAUSTIVELY, and in the pinned emission order.
 *
 * `Record<keyof TranscriptProvenance, …>` is the proof, and it is a proof in both directions: a
 * member added to the schema fails to compile until it is framed here, and a name that is not a
 * member is rejected as an excess property. That is deliberately not `satisfies` over a list and
 * not a walk of the schema's `.shape` — a list proves nothing about what is MISSING, and the
 * provenance schema is refined, so it has no `.shape` to walk without reaching through the
 * refinement. Each framer takes the whole value rather than one field, so no cast, partial record
 * or index signature is needed to call it.
 *
 * THIS LITERAL IS ALSO THE ORDER. Emission walks its own values, rather than a second array of key
 * names: such an array would be free to omit a member and still compile, which is exactly the gap
 * the exhaustive record was chosen to close. Declaration order is the emission order — the language
 * enumerates non-numeric string keys in insertion order — so the order a reviewer reads here is the
 * order the bytes are in, and a member cannot be framed twice or skipped.
 */
export const SESSION_TRANSCRIPT_PROVENANCE_FRAMERS: Record<keyof TranscriptProvenance, TranscriptProvenanceFramer> = {
  v: provenance => sessionTranscriptUnsigned64(provenance.v),
  home: provenance => frameSessionTranscriptValue(provenance.home),
  harnessSessionId: provenance => frameOptional(provenance.harnessSessionId),
  identity: provenance => frameSessionTranscriptValue(provenance.identity),
  baseline: provenance => frameOptionalArray(provenance.baseline),
  correlationToken: provenance => frameOptional(provenance.correlationToken),
  file: provenance => frameOptional(provenance.file),
  resolvedAt: provenance => frameOptional(provenance.resolvedAt),
};

/** A context could not be framed, so no tag may be issued for it. */
export class SessionTranscriptMessageTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionTranscriptMessageTokenError';
  }
}

/**
 * The provenance as bytes, parsed at this boundary before any of it is framed.
 *
 * WHY safeParse HERE. The provenance reaches this module as an ordinary object, and a tag is only
 * as trustworthy as the value it commits to. Parsing first means every member is the shape the
 * schema says, the two refinements hold (an identified transcript names both its harness session
 * and its file), and — because the schema is a plain `z.object`, not a strict one — UNKNOWN KEYS
 * ARE STRIPPED. Two contexts differing only in an unknown key therefore produce the SAME tag. That
 * is the correct behaviour for a value the daemon itself persists and re-reads, but it is a real
 * property to know: if this schema ever becomes passthrough, an unknown key would start travelling
 * unframed inside a value nobody encodes, and the token version must be bumped in the same change
 * rather than silently reinterpreting tags already issued.
 */
function frameProvenance(provenance: TranscriptProvenance): Uint8Array | undefined {
  const parsed = TranscriptProvenanceSchema.safeParse(provenance);
  if (!parsed.success) return undefined;
  return Buffer.concat(Object.values(SESSION_TRANSCRIPT_PROVENANCE_FRAMERS).map(framer => framer(parsed.data)));
}

/**
 * The exact framed tuple every tag is taken over, in the pinned order.
 *
 * The commitment goes last and the domain first, and both are inside the tag rather than beside it:
 * a domain carried only in the envelope text would let a cursor tag be re-labelled as a selection
 * binding by an attacker who can edit the string they were handed.
 */
interface FramedMessageToken {
  readonly input: Uint8Array;
  /** The point bytes that were framed — the ONE spelling a cursor envelope may also carry. */
  readonly pointBytes: Uint8Array;
}

function messageTokenFraming(
  domain: SessionTranscriptMessageTokenDomain,
  context: SessionTranscriptMessageTokenContext,
  point: ConversationMessagePoint,
  rawPrefix: Uint8Array,
): FramedMessageToken | undefined {
  if (rawPrefix.byteLength !== SESSION_TRANSCRIPT_RAW_PREFIX_BYTES) return undefined;
  // The coordinate is PARSED before it is framed, by the protocol's own schema rather than by this
  // encoding's range checks. Those checks only reject what they cannot represent — a negative or
  // unsafe number — while the durable contract is narrower: `v` is exactly 1 and both fields are
  // non-negative integers. An internally miswired coordinate that slipped through would be issued
  // and verified under a coordinate version this release does not define.
  const parsedPoint = ExactConversationMessagePointSchema.safeParse(point);
  if (!parsedPoint.success) return undefined;
  const provenance = frameProvenance(context.provenance);
  if (provenance === undefined) return undefined;
  const pointBytes = canonicalMessagePointBytes(parsedPoint.data);
  return {
    pointBytes,
    input: Buffer.concat([
      frameSessionTranscriptValue(SESSION_TRANSCRIPT_MESSAGE_TOKEN_ENVELOPE),
      frameSessionTranscriptValue(domain),
      frameSessionTranscriptValue(context.sessionId),
      frameSessionTranscriptValue(context.incarnation),
      provenance,
      pointBytes,
      frameSessionTranscriptValue(rawPrefix),
    ]),
  };
}

/** The point as three fixed-width unsigned fields — the only part of a cursor that is recoverable. */
function canonicalMessagePointBytes(point: ExactConversationMessagePoint): Uint8Array {
  return Buffer.concat([
    sessionTranscriptUnsigned64(point.v),
    sessionTranscriptUnsigned64(point.byteOffset),
    sessionTranscriptUnsigned64(point.blockIndex),
  ]);
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Issue one token for one row.
 *
 * A selection binding is `s1.<tag>` and carries nothing else: the fork request already names the
 * point it is cutting at, so repeating it in the token would add a second spelling of one fact.
 * A cursor is `c1.<point>.<tag>`, because the server has to learn where to resume from the client's
 * own string — and that point is public, already served, and authenticated by the tag beside it.
 */
export async function issueSessionTranscriptMessageToken(
  codec: SessionTranscriptMessageTokenCodec,
  domain: SessionTranscriptMessageTokenDomain,
  context: SessionTranscriptMessageTokenContext,
  point: ConversationMessagePoint,
  rawPrefix: Uint8Array,
): Promise<string> {
  const framed = messageTokenFraming(domain, context, point, rawPrefix);
  // The daemon's own persisted provenance, its own coordinate and its own chain value are what this
  // frames, so a context or point the schema refuses, or a commitment of the wrong width, is a
  // defect HERE rather than a caller's mistake — and issuing over any of them would mint evidence
  // about a session nobody can name, under a coordinate version this release does not define, or in
  // a vocabulary nothing else speaks. The refusal carries no part of the context.
  if (framed === undefined)
    throw new SessionTranscriptMessageTokenError(
      'refusing to issue a token over an unparseable transcript provenance or point, or a commitment of the wrong width',
    );
  const tagBytes = await codec.tag(framed.input);
  // A codec that answered a different width would emit a token this module's own parser rejects,
  // which surfaces later as "your selection is stale" rather than as the wiring fault it is.
  if (tagBytes.byteLength !== SESSION_TRANSCRIPT_MESSAGE_TOKEN_TAG_BYTES)
    throw new SessionTranscriptMessageTokenError('refusing to emit a token whose tag is not a full 32-byte HMAC');
  const tag = base64url(tagBytes);
  if (domain === SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN) return `${SELECTION_BINDING_PREFIX}.${tag}`;
  // The envelope carries the very bytes that were framed, never a second spelling of the point: two
  // encodings of one coordinate are two chances for them to disagree.
  return `${CURSOR_PREFIX}.${base64url(framed.pointBytes)}.${tag}`;
}

/**
 * Verify a token against the row the server just re-read.
 *
 * `malformed` is only ever about SYNTAX — a string that is not a token of this domain at all. Every
 * well-formed token that fails is `stale`, whatever made it fail: a tampered tag, another session's
 * context, a re-resolved provenance, a rewritten prefix. One answer for all of them is deliberate.
 * Distinguishing them would turn verification into an oracle that tells a caller which part of the
 * evidence they got wrong, which is exactly the map an attacker is missing.
 */
export async function verifySessionTranscriptMessageToken(
  codec: SessionTranscriptMessageTokenCodec,
  domain: SessionTranscriptMessageTokenDomain,
  context: SessionTranscriptMessageTokenContext,
  point: ConversationMessagePoint,
  rawPrefix: Uint8Array,
  token: string,
): Promise<SessionTranscriptMessageTokenVerdict> {
  const tag = tagOf(domain, token);
  if (tag === undefined) return 'malformed';
  const framed = messageTokenFraming(domain, context, point, rawPrefix);
  // A context, coordinate or commitment this module cannot frame cannot authenticate anything, and
  // verification fails closed into the same single answer every other well-formed disagreement gets.
  if (framed === undefined) return 'stale';
  return (await codec.matches(framed.input, tag)) ? 'accepted' : 'stale';
}

/** The tag bytes inside a token of this domain, or nothing when the string is not one. */
function tagOf(domain: SessionTranscriptMessageTokenDomain, token: string): Uint8Array | undefined {
  const parts = token.split('.');
  const selection = domain === SESSION_TRANSCRIPT_MESSAGE_TOKEN_SELECTION_DOMAIN;
  const expectedPrefix = selection ? SELECTION_BINDING_PREFIX : CURSOR_PREFIX;
  if (parts.length !== (selection ? 2 : 3)) return undefined;
  if (parts[0] !== expectedPrefix) return undefined;
  const encodedTag = parts[parts.length - 1] ?? '';
  if (!TAG_TEXT.test(encodedTag)) return undefined;
  if (!selection && !POINT_TEXT.test(parts[1] ?? '')) return undefined;
  return Buffer.from(encodedTag, 'base64url');
}

/**
 * The public point inside a cursor, or nothing when the string is not a cursor at all.
 *
 * Reading is deliberately separate from verifying, and answers only the coordinate: a caller
 * resolves the row at that point from its own fresh read and then verifies the tag against it. The
 * point is NOT trusted by being here — it is a lookup key until the tag says otherwise — which is
 * why a malformed envelope and a well-formed cursor whose tag fails are different answers.
 */
export function readSessionTranscriptMessageCursor(cursor: string): ConversationMessagePoint | undefined {
  const parts = cursor.split('.');
  if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX) return undefined;
  const encodedPoint = parts[1] ?? '';
  if (!POINT_TEXT.test(encodedPoint) || !TAG_TEXT.test(parts[2] ?? '')) return undefined;
  const bytes = Buffer.from(encodedPoint, 'base64url');
  const v = unsigned64At(bytes, 0);
  const byteOffset = unsigned64At(bytes, UNSIGNED_64_BYTES);
  const blockIndex = unsigned64At(bytes, UNSIGNED_64_BYTES * 2);
  const parsed = ExactConversationMessagePointSchema.safeParse({ v, byteOffset, blockIndex });
  return parsed.success ? parsed.data : undefined;
}

/**
 * One u64 field as a number, or `undefined` when it cannot be one.
 *
 * A value past the safe-integer range is refused rather than rounded: rounding would hand the
 * schema a coordinate that is not the coordinate the bytes carry.
 */
function unsigned64At(bytes: Buffer, offset: number): number | undefined {
  const value = bytes.readBigUInt64BE(offset);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(value);
}
