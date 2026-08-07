/**
 * READING ONE SESSION'S DURABLE CONVERSATION AS ADDRESSABLE ROWS.
 *
 * A surface cannot honestly offer "fork from here" until the exact message a reader clicked has a
 * coordinate the daemon minted. Rendered log lines, row indexes, text hashes and record ids are all
 * client-side surrogates for that coordinate, and every one of them addresses a different message
 * than the reader chose the moment the transcript is rewritten underneath it. This module is the
 * wire that carries the real one.
 *
 * The rows here are the DISPLAY projection: their text has been through the same redaction the
 * operator log surface applies, so a reader sees only what it is allowed to see. Redaction changes
 * the text and nothing else — the point, the role and the timestamp are the same facts the durable
 * row carries, which is what lets a client line a page up against the rows it already renders
 * without correlating by index or by hash.
 */
import { z } from 'zod';
import { ConversationTransferMessageSchema } from './session-transfer.ts';

/**
 * One durable message a caller may fork through.
 *
 * `.extend()`, NOT a second literal. The base is the durable transfer row, and a fork addresses the
 * same message the plan it produces is cut at; respelling those four fields here would be two shapes
 * for one message, and the one that drifted would name a message the plan cannot be built from. The
 * dependency runs read-row → durable-row only: making the durable row import this one would put
 * request-scoped evidence inside every stored plan, where it would already be meaningless by the
 * time a replay after restart read it.
 *
 * PINNED ZOD 4.4.3 IS PART OF THIS CONSTRUCTION, so state what it actually does. `.extend()` merges
 * the new shape onto the base's definition and replaces nothing else, which is why the base's
 * `catchall: never` survives and the extended row still REJECTS UNKNOWN KEYS rather than quietly
 * widening into a loose object. The same merge carries the base's `checks` across untouched.
 *
 * WHICH IS THE HAZARD, NOT THE REASSURANCE. {@link ConversationTransferMessageSchema} has no
 * refinement today. If one is ever added, `.extend()` keeps it and runs it against a row it was not
 * written for — and it throws outright, at MODULE LOAD, the first time this shape overrides a key
 * the base already declares. Adding a refinement to the base is therefore the moment this line must
 * become `.safeExtend()`, which merges the same way, never throws, and type-checks the extension
 * against the base's own input and output. A version bump off 4.4.3 is the other moment to re-read
 * this, because none of the above is guaranteed by the public contract.
 *
 * `selectionBinding` is OPAQUE EVIDENCE, not a second coordinate. The point says which message; the
 * binding says that the raw message at that point is still the raw message this page served. Two
 * rows whose redacted display is byte-identical carry different bindings when their raw content
 * differs, which is exactly the substitution a point alone cannot refuse. It is minted and verified
 * by the daemon and by nothing else: a client stores the bytes and echoes them back unchanged, and
 * never parses, derives, normalizes, hashes or re-signs them. It is not trimmed here for the same
 * reason — a schema that rewrote the value would hand back evidence the issuer never issued.
 */
export const SessionTranscriptMessageSchema = ConversationTransferMessageSchema.extend({
  /** Opaque daemon-issued evidence that this row's raw content is unchanged. Echo it verbatim. */
  selectionBinding: z.string().min(1),
});
export type SessionTranscriptMessage = z.infer<typeof SessionTranscriptMessageSchema>;

/**
 * One page of a session's addressable conversation.
 *
 * `nextCursor` is null when the page reaches the end of the conversation as it reads right now, and
 * an opaque string otherwise. It is NOT a fingerprint of the whole transcript: a message appended
 * after this page was served must not invalidate the next one, so the cursor binds only the raw
 * prefix already served and continues strictly after the last row it names. A client that reaches
 * the end, waits, and asks again with the same cursor is asking a question the daemon can answer.
 *
 * Like the per-row binding, the cursor is bytes to every caller. It is not a page number, it does
 * not commute with one, and a client that built one from the point of the last row would be minting
 * an address the daemon never authenticated.
 *
 * `sessionId` is echoed rather than left implied by the request path, because a page and the rows in
 * it are routinely held long after the request that produced them is forgotten — and a row addressed
 * against the wrong session is a fork of a conversation nobody asked for.
 */
export const SessionTranscriptPageSchema = z.strictObject({
  v: z.literal(1),
  sessionId: z.string().min(1),
  messages: z.array(SessionTranscriptMessageSchema).readonly(),
  /** Opaque continuation token, or null at the end of the conversation as it currently reads. */
  nextCursor: z.string().min(1).nullable(),
});
export type SessionTranscriptPage = z.infer<typeof SessionTranscriptPageSchema>;
