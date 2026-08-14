import type { ConversationMessagePoint } from '@ferretry/protocol';
import type {
  TranscriptBatch,
  TranscriptEvent,
  TranscriptIssue,
  TranscriptRawRecord,
  TranscriptRole,
} from '../../transcript/types.ts';
import { extendSessionTranscriptRawPrefix, sessionTranscriptRawPrefixStart } from './message-token.ts';

/** The roles a replacement harness can receive as ordinary conversation context. */
export type ConversationMessageRole = Extract<TranscriptRole, 'user' | 'assistant' | 'developer' | 'system'>;

export interface ConversationMessage {
  readonly point: ConversationMessagePoint;
  readonly role: ConversationMessageRole;
  readonly text: string;
  readonly timestamp?: string;
}

/**
 * One carried message, bound to the commitment for the raw conversation prefix it sits at the end of.
 *
 * `rawPrefix` is `H_i` for the PHYSICAL transcript record this message was normalized from: 32
 * bytes, evidence only, and never published. Every message block emitted by one record shares that
 * record's value — the required `blockIndex` is what tells those blocks apart — because the thing
 * being committed to is the file's bytes, not the normalizer's output.
 */
export interface PortableConversationRow extends ConversationMessage {
  readonly rawPrefix: Uint8Array;
}

/** Evidence deliberately omitted because it cannot be replayed across harnesses. */
export interface ConversationDigestOmission {
  readonly point: ConversationMessagePoint;
  readonly kind: Exclude<TranscriptEvent['kind'], 'message'>;
  readonly reason: 'harness-specific' | 'unreadable';
}

/**
 * A portable prefix of one conversation.
 *
 * It deliberately has no Claude or Codex-shaped fields.  A caller starting a replacement can
 * render `messages` for any harness, while inspecting `omissions` before deciding whether the
 * missing tool state or attachment evidence is acceptable for its operation.
 */
/**
 * The cut's raw-record evidence: verification input, and nothing a caller may keep.
 *
 * It rides on the digest because there is no honest way to fetch it separately — recomputing it
 * means reading the transcript a second time, and the file may have changed between the two reads,
 * which is precisely the change this evidence exists to detect. One call, one read, one answer.
 *
 * IT IS EPHEMERAL. A contributor strips it before the conversation facet is built: it must never
 * reach a transfer plan, a lineage edge, a fork receipt or any public outcome. A committed
 * commitment would be a durable fingerprint of raw text sitting beside its redacted display, which
 * is the offline oracle the whole token design exists to avoid.
 */
export interface ConversationSelectionEvidence {
  /** The cut coordinate, restated so evidence cannot drift from the point it speaks for. */
  readonly point: ConversationMessagePoint;
  /** `H_i` — 32 bytes — for the physical record the cut was normalized from. */
  readonly rawPrefix: Uint8Array;
}

export interface ConversationDigest {
  readonly sessionId: string;
  readonly through: ConversationMessagePoint;
  readonly messages: readonly ConversationMessage[];
  readonly omissions: readonly ConversationDigestOmission[];
  /**
   * Present exactly when the batch carried its physical record bytes.
   *
   * Optional rather than required so import's validation-only re-read — which proves a frozen plan
   * still matches and binds nothing — keeps working unchanged on a batch with no record evidence.
   * A caller that needs to BIND something refuses its absence instead of proceeding without it.
   */
  readonly selectionEvidence?: ConversationSelectionEvidence;
}

export type ConversationDigestFailure = 'incomplete_transcript' | 'target_not_found' | 'target_not_message';

/** A transcript cannot honestly become portable context. */
export class ConversationDigestError extends Error {
  constructor(
    readonly failure: ConversationDigestFailure,
    message: string,
  ) {
    super(message);
    this.name = 'ConversationDigestError';
  }
}

function pointOf(event: TranscriptEvent): ConversationMessagePoint | undefined {
  if (event.byteOffset === undefined) return undefined;
  return {
    v: 1,
    byteOffset: event.byteOffset,
    blockIndex: event.blockIndex ?? 0,
  };
}

/**
 * Whether two durable coordinates address the same message — VERSION INCLUDED.
 *
 * The one comparison every caller makes, so a cursor anchor, a fork cut and a digest target cannot
 * disagree about what "the same point" means. `v` participates because a coordinate is a versioned
 * durable wire value: a `v: 2` point carrying this offset addresses a message under whatever `v: 2`
 * comes to mean, and answering "same" for it would let a later version silently re-address an
 * earlier one's evidence.
 */
export function sameConversationMessagePoint(left: ConversationMessagePoint, right: ConversationMessagePoint): boolean {
  return left.v === right.v && left.byteOffset === right.byteOffset && left.blockIndex === right.blockIndex;
}

function pointKey(point: ConversationMessagePoint): string {
  return `${point.byteOffset}:${point.blockIndex}`;
}

/** An issue that means one or more source records may be absent from the supplied batch. */
function makesTranscriptIncomplete(issue: TranscriptIssue): boolean {
  return [
    'invalid-json',
    'incomplete-line',
    'truncated-json',
    'invalid-record',
    'source-missing',
    'source-read-failed',
    'source-truncated',
    'oversized-record',
  ].includes(issue.code);
}

function omissionReason(event: TranscriptEvent): ConversationDigestOmission['reason'] {
  return event.kind === 'error' ? 'unreadable' : 'harness-specific';
}

/**
 * One normalized transcript event: either a portable message, or evidence this conversation cannot
 * carry together with the refusal a caller cutting at that coordinate earns.
 *
 * The refusal is composed during the walk rather than at the cut so that ONE pass over the batch
 * serves every consumer — the transfer digest, the read surface's rows, and the evidence a token is
 * bound to — and none of them re-normalizes the transcript or invents a second point owner.
 */
type ConversationPassEntry =
  | { readonly kind: 'row'; readonly point: ConversationMessagePoint; readonly message: ConversationMessage }
  | {
      readonly kind: 'omission';
      readonly point: ConversationMessagePoint;
      readonly omission: ConversationDigestOmission;
      readonly refusal: string;
    };

/**
 * Normalize every event once, refusing incomplete or ambiguous evidence.
 *
 * A transcript with no portable messages answers with none. That is honest rather than exceptional:
 * a complete transcript holding only tool state has nothing forkable in it, and saying so is a
 * different statement from failing to read it.
 */
function conversationPass(sessionId: string, transcript: TranscriptBatch): readonly ConversationPassEntry[] {
  const incomplete = transcript.issues.find(makesTranscriptIncomplete);
  if (incomplete !== undefined)
    throw new ConversationDigestError(
      'incomplete_transcript',
      `transcript for ${sessionId} is incomplete (${incomplete.code}); refusing to make a partial conversation digest`,
    );

  const entries: ConversationPassEntry[] = [];
  const seenPoints = new Set<string>();
  for (const event of transcript.events) {
    const point = pointOf(event);
    if (point === undefined)
      throw new ConversationDigestError(
        'incomplete_transcript',
        `transcript for ${sessionId} has an unaddressable ${event.kind} event; refusing to guess its position`,
      );
    const key = pointKey(point);
    if (seenPoints.has(key))
      throw new ConversationDigestError(
        'incomplete_transcript',
        `transcript for ${sessionId} has duplicate message point ${key}; refusing an ambiguous byte offset`,
      );
    seenPoints.add(key);

    if (event.kind === 'message' && event.role !== 'tool') {
      entries.push({
        kind: 'row',
        point,
        message: {
          point,
          role: event.role,
          text: event.text,
          ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
        },
      });
      continue;
    }

    const omission: ConversationDigestOmission =
      event.kind === 'message'
        ? { point, kind: 'tool-result', reason: 'harness-specific' }
        : { point, kind: event.kind, reason: omissionReason(event) };
    const refusal =
      event.kind === 'message'
        ? `transcript point ${key} is not a portable conversation message`
        : `transcript point ${key} is ${event.kind}, not a portable conversation message`;
    entries.push({ kind: 'omission', point, omission, refusal });
  }
  return entries;
}

/** The carried prefix, and the message the cut names. */
interface ConversationCut {
  readonly messages: readonly ConversationMessage[];
  readonly omissions: readonly ConversationDigestOmission[];
  readonly cut: ConversationMessage;
}

function cutConversation(
  sessionId: string,
  transcript: TranscriptBatch,
  through: ConversationMessagePoint,
): ConversationCut {
  const messages: ConversationMessage[] = [];
  const omissions: ConversationDigestOmission[] = [];
  let cut: ConversationMessage | undefined;
  for (const entry of conversationPass(sessionId, transcript)) {
    const isTarget = sameConversationMessagePoint(entry.point, through);
    if (entry.kind === 'row') {
      messages.push(entry.message);
      if (isTarget) {
        cut = entry.message;
        break;
      }
      continue;
    }
    omissions.push(entry.omission);
    if (isTarget) throw new ConversationDigestError('target_not_message', entry.refusal);
  }
  if (cut === undefined)
    throw new ConversationDigestError(
      'target_not_found',
      `transcript for ${sessionId} does not contain message point ${through.byteOffset}:${through.blockIndex}`,
    );
  return { messages, omissions, cut };
}

/**
 * `H_i` for every physical record of this batch, keyed by the record's byte offset.
 *
 * The chain is folded ONCE, in file order, over the exact bytes the parser consumed — blank and
 * unrecognised records included, because they occupy their byte range whatever the normalizer made
 * of them. Each record's value is stored rather than the whole prefix being re-hashed per row, so a
 * page of k rows costs one fold plus k lookups instead of k folds over the prefix.
 */
function rawPrefixesByRecord(
  sessionId: string,
  records: readonly TranscriptRawRecord[],
): ReadonlyMap<number, Uint8Array> {
  const commitments = new Map<number, Uint8Array>();
  let rawPrefix = sessionTranscriptRawPrefixStart();
  for (const record of records) {
    if (commitments.has(record.byteOffset))
      throw new ConversationDigestError(
        'incomplete_transcript',
        `transcript for ${sessionId} has two physical records at byte offset ${record.byteOffset}; refusing an ambiguous raw prefix`,
      );
    rawPrefix = extendSessionTranscriptRawPrefix(rawPrefix, record.bytes);
    commitments.set(record.byteOffset, rawPrefix);
  }
  return commitments;
}

/**
 * The record bytes a binding consumer may not proceed without.
 *
 * Binding a selection to a prefix nothing read would be a promise about a file this pass never saw,
 * so its absence is a refusal rather than an empty answer.
 */
function requireRawRecords(sessionId: string, transcript: TranscriptBatch): readonly TranscriptRawRecord[] {
  const records = transcript.rawRecords;
  if (records === undefined)
    throw new ConversationDigestError(
      'incomplete_transcript',
      `transcript for ${sessionId} carries no physical record bytes; refusing to bind evidence to a prefix it never read`,
    );
  return records;
}

/**
 * The commitment for the record one message came from.
 *
 * A message whose byte offset names no physical record refuses rather than resolving to a
 * neighbouring one: an event and its record come from the same pass, so a mismatch means the two
 * halves of that pass disagree, and guessing which is right is how a fork ends up cut at bytes
 * nobody committed to.
 */
function rawPrefixFor(
  sessionId: string,
  point: ConversationMessagePoint,
  commitments: ReadonlyMap<number, Uint8Array>,
): Uint8Array {
  const rawPrefix = commitments.get(point.byteOffset);
  if (rawPrefix === undefined)
    throw new ConversationDigestError(
      'incomplete_transcript',
      `transcript for ${sessionId} has a message at byte offset ${point.byteOffset} with no physical record; refusing to bind evidence it cannot see`,
    );
  return rawPrefix;
}

/**
 * Every portable message of a complete transcript, each bound to its record's commitment.
 *
 * This is what a read surface pages over. It performs the same pass and applies the same refusals
 * the transfer digest does, so a row a reader may select is a row a fork may be cut at.
 */
export function portableConversationRows(
  sessionId: string,
  transcript: TranscriptBatch,
): readonly PortableConversationRow[] {
  const commitments = rawPrefixesByRecord(sessionId, requireRawRecords(sessionId, transcript));
  const rows: PortableConversationRow[] = [];
  for (const entry of conversationPass(sessionId, transcript))
    if (entry.kind === 'row')
      rows.push({ ...entry.message, rawPrefix: rawPrefixFor(sessionId, entry.message.point, commitments) });
  return rows;
}

/**
 * Reconstruct the portable message prefix ending at one exact durable message.
 *
 * The caller must supply a complete `TranscriptBatch`, rather than a live tail.  A source that
 * stopped at a byte cap, ended on a partial record, or reported malformed JSON is rejected: a
 * shorter-looking conversation is lost history, not a valid prefix.
 *
 * When the batch carries its physical record bytes the cut's `selectionEvidence` is answered from
 * this same call — the contributor that builds a conversation facet must never reopen the file to
 * learn what the prefix at its cut was, because a second read answers about a later file.
 */
export function digestConversation(
  sessionId: string,
  transcript: TranscriptBatch,
  through: ConversationMessagePoint,
): ConversationDigest {
  const { messages, omissions, cut } = cutConversation(sessionId, transcript, through);
  const records = transcript.rawRecords;
  if (records === undefined) return { sessionId, through, messages, omissions };
  const commitments = rawPrefixesByRecord(sessionId, records);
  return {
    sessionId,
    through,
    messages,
    omissions,
    selectionEvidence: { point: cut.point, rawPrefix: rawPrefixFor(sessionId, cut.point, commitments) },
  };
}
