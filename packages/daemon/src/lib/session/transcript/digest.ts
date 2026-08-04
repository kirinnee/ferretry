import type { TranscriptBatch, TranscriptEvent, TranscriptIssue, TranscriptRole } from '../../transcript/types.ts';

/** A stable, harness-neutral coordinate for one durable transcript message. */
export interface ConversationMessagePoint {
  /** The zero-based byte offset of the source record. */
  readonly byteOffset: number;
  /** A harness record may normalize into more than one message. */
  readonly blockIndex?: number;
}

/** The roles a replacement harness can receive as ordinary conversation context. */
export type ConversationMessageRole = Extract<TranscriptRole, 'user' | 'assistant' | 'developer' | 'system'>;

export interface ConversationMessage {
  readonly point: ConversationMessagePoint;
  readonly role: ConversationMessageRole;
  readonly text: string;
  readonly timestamp?: string;
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
export interface ConversationDigest {
  readonly sessionId: string;
  readonly through: ConversationMessagePoint;
  readonly messages: readonly ConversationMessage[];
  readonly omissions: readonly ConversationDigestOmission[];
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
    byteOffset: event.byteOffset,
    ...(event.blockIndex === undefined ? {} : { blockIndex: event.blockIndex }),
  };
}

function samePoint(left: ConversationMessagePoint, right: ConversationMessagePoint): boolean {
  return left.byteOffset === right.byteOffset && left.blockIndex === right.blockIndex;
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
 * Reconstruct the portable message prefix ending at one exact durable message.
 *
 * The caller must supply a complete `TranscriptBatch`, rather than a live tail.  A source that
 * stopped at a byte cap, ended on a partial record, or reported malformed JSON is rejected: a
 * shorter-looking conversation is lost history, not a valid prefix.
 */
export function digestConversation(
  sessionId: string,
  transcript: TranscriptBatch,
  through: ConversationMessagePoint,
): ConversationDigest {
  const incomplete = transcript.issues.find(makesTranscriptIncomplete);
  if (incomplete !== undefined)
    throw new ConversationDigestError(
      'incomplete_transcript',
      `transcript for ${sessionId} is incomplete (${incomplete.code}); refusing to make a partial conversation digest`,
    );

  const messages: ConversationMessage[] = [];
  const omissions: ConversationDigestOmission[] = [];
  let found = false;
  for (const event of transcript.events) {
    const point = pointOf(event);
    if (point === undefined)
      throw new ConversationDigestError(
        'incomplete_transcript',
        `transcript for ${sessionId} has an unaddressable ${event.kind} event; refusing to guess its position`,
      );
    const isTarget = samePoint(point, through);
    if (event.kind === 'message') {
      if (event.role === 'tool') {
        omissions.push({ point, kind: 'tool-result', reason: 'harness-specific' });
      } else {
        messages.push({
          point,
          role: event.role,
          text: event.text,
          ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
        });
      }
      if (isTarget) {
        if (event.role === 'tool')
          throw new ConversationDigestError(
            'target_not_message',
            `transcript point ${through.byteOffset} is not a portable conversation message`,
          );
        found = true;
        break;
      }
      continue;
    }
    omissions.push({ point, kind: event.kind, reason: omissionReason(event) });
    if (isTarget)
      throw new ConversationDigestError(
        'target_not_message',
        `transcript point ${through.byteOffset} is ${event.kind}, not a portable conversation message`,
      );
  }
  if (!found)
    throw new ConversationDigestError(
      'target_not_found',
      `transcript for ${sessionId} does not contain message point ${through.byteOffset}`,
    );
  return { sessionId, through, messages, omissions };
}
