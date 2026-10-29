/**
 * THE ROLLING COMMITMENT TO A SESSION'S RAW TRANSCRIPT PREFIX, AND THE FRAMING IT IS TAKEN UNDER.
 *
 * `H_0` commits to nothing read yet and each `H_i` folds one more physical record onto `H_(i-1)`, so a
 * row's `rawPrefix` is evidence about every byte from zero to the end of its record. Why the chain is
 * over physical records and why every field is length-framed is `message-token.ts`'s to say: that
 * module mints the tokens bound to this chain and re-exports everything here.
 *
 * ITS OWN MODULE SO A FOLD NEEDS NOTHING ELSE. The conversation index folds the chain on the
 * transcript parse worker, and that thread's cost is every module it loads for as long as the daemon
 * lives. The token half of `message-token.ts` validates points and provenance against the protocol's
 * schemas, which load the whole `@ferretry/protocol` barrel; the chain needs a hash and nothing more.
 * Moving it changes where it is imported from, never a byte it produces.
 */

import { createHash } from 'node:crypto';

/** The rolling-commitment domains: a chain start and a chain step are different statements. */
const SESSION_TRANSCRIPT_RAW_PREFIX_DOMAIN = 'ferretry.session-transcript.raw-prefix.v1';
const SESSION_TRANSCRIPT_RAW_PREFIX_ROW_DOMAIN = 'ferretry.session-transcript.raw-prefix-row.v1';

/** The width of one fixed-width unsigned field. */
export const SESSION_TRANSCRIPT_UNSIGNED_64_BYTES = 8;

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
  const encoded = Buffer.alloc(SESSION_TRANSCRIPT_UNSIGNED_64_BYTES);
  encoded.writeBigUInt64BE(BigInt(value));
  return encoded;
}

/** `frame(x)`: the u64 byte length of `x`, then exactly `x`. Text is UTF-8. */
export function frameSessionTranscriptValue(value: Uint8Array | string): Uint8Array {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return Buffer.concat([sessionTranscriptUnsigned64(bytes.length), bytes]);
}

/** `H_0`: the commitment to an empty raw prefix, which is the domain and nothing else. */
export function sessionTranscriptRawPrefixStart(): Uint8Array {
  return createHash('sha256').update(frameSessionTranscriptValue(SESSION_TRANSCRIPT_RAW_PREFIX_DOMAIN)).digest();
}

/** `frame(row-domain)`, which every step of the chain begins with. */
const RAW_PREFIX_ROW_DOMAIN_FRAME = frameSessionTranscriptValue(SESSION_TRANSCRIPT_RAW_PREFIX_ROW_DOMAIN);

/**
 * `H_i = SHA-256(frame(row-domain) || frame(H_(i-1)) || frame(raw_i))`.
 *
 * One fixed-cost step per physical record. The previous VALUE is folded in rather than the previous
 * prefix being re-read, which is what makes a page of k rows one transcript pass plus k hashes
 * instead of k passes over the prefix.
 *
 * The record's frame is hashed as its length and then the record itself, never joined into one buffer
 * first: the bytes hashed are the same, and a multi-megabyte screenshot record is not copied just to be
 * read once by the hash.
 */
export function extendSessionTranscriptRawPrefix(previous: Uint8Array, rawRecord: Uint8Array): Uint8Array {
  return createHash('sha256')
    .update(RAW_PREFIX_ROW_DOMAIN_FRAME)
    .update(frameSessionTranscriptValue(previous))
    .update(sessionTranscriptUnsigned64(rawRecord.length))
    .update(rawRecord)
    .digest();
}
