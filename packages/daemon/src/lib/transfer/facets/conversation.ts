/**
 * The conversation facet: portable normalized messages through one exact durable point.
 *
 * This is the first production consumer of the digest primitive, and the boundary it enforces is
 * the seam's sharpest one: **a transfer never produces a file the target harness will parse as its
 * own history.** A transplanted rollout is a forgery the harness mis-attributes; what crosses is
 * CONTENT — role, text and timestamp — which the importer renders as quoted prior context in the
 * new session's first turn document.
 *
 * Everything a replacement cannot honestly replay is left behind and NAMED: tool results, thinking,
 * attachments-as-evidence and unreadable records all become omissions rather than silence. A
 * shorter conversation with no explanation is lost history pretending to be a short one.
 */

import type { ConversationFacet, TransferOmission } from '@ferretry/protocol';
import type { TextRedactor } from '../../secrets/redaction.ts';
import {
  type ConversationDigest,
  ConversationDigestError,
  type ConversationDigestOmission,
  sameConversationMessagePoint,
} from '../../session/transcript/digest.ts';
import {
  type TransferConversationReader,
  type TransferConversationContribution,
  type TransferConversationContributor,
  TransferPrepareError,
  type TransferPrepareInput,
} from '../types.ts';

/** Names the exact record, so a report can point at the message a reader has to go and look at. */
function subjectOf(omission: ConversationDigestOmission): string {
  return `${omission.kind} at byte ${omission.point.byteOffset}#${omission.point.blockIndex}`;
}

/**
 * Two digest reasons, two transfer reasons, and the distinction is worth keeping.
 *
 * `harness-specific` evidence exists and is intact — it simply means nothing to another harness.
 * `unreadable` evidence could not be read at all. Collapsing them would tell an operator that a
 * corrupt record was a compatibility decision.
 */
function toOmission(omission: ConversationDigestOmission): TransferOmission {
  return {
    facet: 'conversation',
    subject: subjectOf(omission),
    reason: omission.reason === 'unreadable' ? 'unavailable' : 'harness_incompatible',
    detail:
      omission.reason === 'unreadable'
        ? 'this record could not be read as a conversation message, so it is not carried'
        : 'this record is harness-private evidence and cannot be replayed by another harness',
  };
}

async function facetOf(digest: ConversationDigest, redactor: Pick<TextRedactor, 'redact'>): Promise<ConversationFacet> {
  return {
    messages: await Promise.all(
      digest.messages.map(async message => ({
        point: message.point,
        role: message.role,
        // The plan is the first durable copy that crosses a session boundary. Scrub here, before
        // the plan, receipt and rendered brief can disagree about the content that was carried.
        text: await redactor.redact(message.text),
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
      })),
    ),
  };
}

export class ConversationFacetContributor implements TransferConversationContributor {
  readonly facet = 'conversation' as const;

  constructor(
    private readonly reader: TransferConversationReader,
    private readonly redactor: Pick<TextRedactor, 'redact'> = { redact: async text => text },
  ) {}

  async contribute(input: TransferPrepareInput): Promise<TransferConversationContribution> {
    const through = input.request.cutMessagePoint;
    /**
     * No cut, no conversation, and no contributor of its own is needed to say so: a null point is
     * the single, total representation of "this transfer carries no conversation".
     */
    if (through === null) return { value: null, omissions: [], selectionEvidence: null };

    const transcriptProvenance = input.source.transcriptProvenance;
    if (transcriptProvenance === null)
      throw new TransferPrepareError(
        'conversation_unavailable',
        `session ${input.source.sessionId} has no transcript provenance, so the exact message cut cannot be verified`,
      );

    let digest: ConversationDigest | undefined;
    try {
      digest = await this.reader.digest({
        sourceSessionId: input.source.sessionId,
        sourceHarness: input.source.harness,
        transcriptProvenance,
        through,
      });
    } catch (error) {
      /**
       * The digest primitive already owns the vocabulary for an unmakeable cut. Carrying its
       * failure through unchanged keeps the route's refusal and the only code that can produce it
       * speaking one language.
       */
      if (error instanceof ConversationDigestError) throw new TransferPrepareError(error.failure, error.message);
      throw error;
    }

    if (digest === undefined)
      throw new TransferPrepareError(
        'conversation_unavailable',
        `no transcript could be read for source session ${input.source.sessionId}, so the exact message cut cannot be verified`,
      );

    const selectionEvidence = digest.selectionEvidence;
    if (selectionEvidence === undefined || !sameConversationMessagePoint(selectionEvidence.point, through))
      throw new TransferPrepareError(
        'plan_invalid',
        `the conversation digest for ${input.source.sessionId} did not carry raw-prefix evidence for the requested message cut`,
      );

    return {
      value: await facetOf(digest, this.redactor),
      omissions: digest.omissions.map(toOmission),
      selectionEvidence: { rawPrefix: selectionEvidence.rawPrefix },
    };
  }
}
