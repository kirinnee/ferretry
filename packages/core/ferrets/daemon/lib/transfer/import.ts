/**
 * Import: apply one already-decided plan to the NEW session, and to nothing else.
 *
 * `importPlan` requires the explicit new-session id and passes that same key to EVERY writer. It
 * refuses the source id before the validation reread, so no caller-closed writer convention can
 * silently aim a transfer back at its source (I4). The source id reaches only the attachment
 * copier's read side and the validation-only digest port. There is no board port and no child-grant
 * requester, so board access cannot be inherited by any path (I3).
 *
 * It re-derives nothing. The plan was parsed and persisted before a session existed to receive it,
 * so a crash between "the record exists" and "the context is in it" replays THIS document rather
 * than reading a source that has since moved on — which is the difference between an idempotent
 * import and a second attempt that quietly captures a different conversation.
 *
 * Before it writes anything it makes two checks, and they catch different failures:
 *
 * 1. **The plan against itself.** The durable point pinned as the cut must be the point of the last
 *    message actually carried, or the conversation and the lineage edge disagree about which
 *    conversation this is.
 * 2. **The plan against its pinned source, re-read.** A byte offset is stable while a transcript is
 *    only appended to, and NOT stable if a harness ever compacts or rewrites its rollout — after
 *    which it silently re-addresses some other record. So the exact provenance/file identity and
 *    point persisted in the plan are read again through the same digest primitive, and the frozen
 *    prefix is compared message for message. A record that no longer parses there, a block index now
 *    out of range, or text that has changed is a REFUSAL rather than a fork nobody chose.
 *
 * The second check does not weaken the replay guarantee, because it may only refuse: what crosses is
 * still the frozen plan, never a fresh digest. Re-DERIVING at import is the thing that would make a
 * second attempt capture a different conversation; re-READING to prove the first attempt is still
 * describable is what stops it from capturing the wrong one.
 *
 * The source's transcript provenance is never among the things written. It names a harness home, a
 * foreign session id and a correlation token this daemon injected into that session and no other,
 * so a copy would point the new session's parser at somebody else's file and destroy the only proof
 * its own transcript identity rests on. The new session's provenance is captured fresh, by the
 * lifecycle, against the executable it actually launches.
 */

import { type SessionTransferEdge, SessionTransferEdgeSchema, type SessionTransferPlan } from '@ferretry/protocol';
import { ConversationDigestError } from '../session/transcript/digest.ts';
import { renderTransferBrief } from './brief.ts';
import { type SessionTransferImportOutcome, type SessionTransferImportPorts, TransferImportError } from './types.ts';

type TransferKind = SessionTransferEdge['kind'];
type CarriedMessage = NonNullable<SessionTransferPlan['facets']['conversation']>['messages'][number];

function samePoint(
  left: SessionTransferPlan['source']['cutMessagePoint'],
  right: SessionTransferPlan['source']['cutMessagePoint'],
): boolean {
  if (left === null || right === null) return left === right;
  return left.byteOffset === right.byteOffset && left.blockIndex === right.blockIndex;
}

/**
 * What changed between the frozen prefix and the same prefix read again, or `undefined` when
 * nothing did.
 *
 * EVERY FIELD THAT CROSSES IS COMPARED, and the timestamp is one of them. An earlier version of this
 * function excluded it, reasoning that a timestamp is carried "for the reader's benefit" and that a
 * harness restating one has not changed what was said. That reasoning does not survive contact with
 * what the import actually writes: `renderTransferBrief` renders the timestamp beside each quoted
 * message, so a plan whose timestamps have moved produces a DIFFERENT first-turn document from the
 * one the plan describes — and the whole point of re-reading before the first write is that the
 * document the target receives is the document the frozen plan named.
 *
 * PRESENCE COUNTS AS WELL AS VALUE. `timestamp` is optional, and the brief renders nothing at all
 * when it is absent, so a message that gains or loses one changes the rendered line just as surely
 * as one whose clock moved. Comparing with `!==` covers both: `undefined !== '2026-…'` in either
 * direction.
 */
function describeRewrite(frozen: readonly CarriedMessage[], reread: readonly CarriedMessage[]): string | undefined {
  if (frozen.length !== reread.length)
    return `it carried ${frozen.length} message(s) and now reads as ${reread.length}`;
  for (const [index, message] of frozen.entries()) {
    const now = reread[index];
    if (now === undefined) return `message ${index} is gone`;
    if (now.point.byteOffset !== message.point.byteOffset || now.point.blockIndex !== message.point.blockIndex)
      return `message ${index} has moved to a different position in the file`;
    if (now.role !== message.role) return `message ${index} is no longer a ${message.role} message`;
    if (now.text !== message.text) return `message ${index} does not say what it said when the plan was made`;
    if (now.timestamp !== message.timestamp)
      return (
        `message ${index} is no longer timestamped ${message.timestamp ?? '(unstamped)'}, and the quoted ` +
        'context the new session is given renders that stamp'
      );
  }
  return undefined;
}

export class SessionTransferImporter {
  constructor(
    private readonly ports: SessionTransferImportPorts,
    private readonly kind: TransferKind,
  ) {}

  /** The public target key must be fresh, never an alias for the source. */
  private assertFreshTarget(plan: SessionTransferPlan, newSessionId: string): void {
    if (newSessionId.trim() !== '' && newSessionId !== plan.source.sessionId) return;
    throw new TransferImportError(
      'edge_invalid',
      `plan ${plan.planId} must be imported under an explicit fresh session id, not ${
        newSessionId === plan.source.sessionId ? 'its source id' : 'an empty id'
      }`,
    );
  }

  /** Refuse a plan whose conversation does not end where its cut says it does. */
  private assertCutIsCarried(plan: SessionTransferPlan): void {
    const cut = plan.source.cutMessagePoint;
    const messages = plan.facets.conversation?.messages ?? [];
    if (cut === null) return;
    const last = messages[messages.length - 1];
    if (last !== undefined && samePoint(last.point, cut)) return;
    throw new TransferImportError(
      'cut_not_carried',
      `plan ${plan.planId} was cut at byte ${cut.byteOffset} block ${cut.blockIndex} but the last conversation ` +
        'message it carries is not that message; the plan and the lineage edge it would write disagree about ' +
        'which conversation this is',
    );
  }

  /**
   * Re-read the pinned point and prove the frozen prefix still describes what is there.
   *
   * Nothing is copied from the re-read: it decides only whether this plan may still be applied. A
   * fork cut cannot have an empty frozen prefix: `assertCutIsCarried` refuses that incoherent plan
   * before this method runs. A handover has no cut and therefore has nothing to validate.
   */
  private async assertCutStillReads(plan: SessionTransferPlan): Promise<void> {
    const cut = plan.source.cutMessagePoint;
    const frozen = plan.facets.conversation?.messages ?? [];
    if (cut === null) return;
    const transcriptProvenance = plan.source.transcriptProvenance;
    if (transcriptProvenance === null)
      throw new TransferImportError(
        'cut_unreadable',
        `plan ${plan.planId} has no frozen transcript provenance for its conversation cut`,
      );

    let digest: Awaited<ReturnType<SessionTransferImportPorts['conversation']['digestPinned']>>;
    try {
      digest = await this.ports.conversation.digestPinned({
        sourceSessionId: plan.source.sessionId,
        sourceHarness: plan.source.harness,
        transcriptProvenance,
        through: cut,
      });
    } catch (error) {
      if (error instanceof ConversationDigestError)
        throw new TransferImportError(
          'cut_unreadable',
          `plan ${plan.planId} pinned a message in ${plan.source.sessionId} that no longer reads as one ` +
            `(${error.failure}): ${error.message}`,
        );
      throw error;
    }
    if (digest === undefined)
      throw new TransferImportError(
        'cut_unreadable',
        `the transcript ${plan.planId} was cut from can no longer be read, so the message it names cannot be ` +
          'shown to be the one this transfer is about',
      );

    if (digest.sessionId !== plan.source.sessionId || !samePoint(digest.through, cut))
      throw new TransferImportError(
        'cut_rewritten',
        `the transcript validation for plan ${plan.planId} answered from a different source or point; import may ` +
          'validate only the exact provenance and message coordinate persisted in the plan',
      );

    const rewritten = describeRewrite(frozen, digest.messages);
    if (rewritten !== undefined)
      throw new TransferImportError(
        'cut_rewritten',
        `the transcript ${plan.planId} was cut from has changed beneath it (${rewritten}); a byte offset only ` +
          'stays valid while a transcript is appended to, so this plan now names a different conversation and is ' +
          'refused rather than applied',
      );
  }

  private edge(plan: SessionTransferPlan, at: string): SessionTransferEdge {
    const parsed = SessionTransferEdgeSchema.safeParse({
      v: 1,
      kind: this.kind,
      sourceSessionId: plan.source.sessionId,
      sourceIncarnation: plan.source.incarnation,
      sourceHarness: plan.source.harness,
      cutMessagePoint: plan.source.cutMessagePoint,
      planId: plan.planId,
      at,
    });
    if (!parsed.success)
      throw new TransferImportError(
        'edge_invalid',
        `plan ${plan.planId} cannot describe a ${this.kind} edge: ${parsed.error.issues
          .map(issue => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
      );
    return parsed.data;
  }

  async importPlan(plan: SessionTransferPlan, newSessionId: string): Promise<SessionTransferImportOutcome> {
    this.assertFreshTarget(plan, newSessionId);
    this.assertCutIsCarried(plan);
    await this.assertCutStillReads(plan);
    // The edge time is persisted plan data, so replay cannot rewrite the envelope with a new clock reading.
    const transferredFrom = this.edge(plan, plan.preparedAt);

    await this.ports.envelope.apply(newSessionId, {
      durable: plan.durable,
      transferredFrom,
      lineage: plan.facets.lineage,
    });

    const copied: string[] = [];
    for (const attachment of plan.facets.attachments.attachments) {
      /**
       * Preparation owns every omission. If bytes it planned to carry are unavailable now, import
       * fails and leaves its phase retryable; inventing a new omission here would make the persisted
       * plan and the target brief disagree about what this fork decided.
       */
      await this.ports.attachments.copyOriginal({
        fromSessionId: plan.source.sessionId,
        newSessionId,
        expectedManifest: attachment,
      });
      copied.push(attachment.id);
    }

    /**
     * The brief is written LAST: it is the document the new agent is pointed at, and it names the
     * attachments and exactly `plan.notCarried`. A crash before this point leaves a session with no
     * complete opening turn, which is recoverable; a brief describing bytes that never arrived is
     * not. Rendering depends only on the persisted plan and transfer kind, so every replay supplies
     * the writer with identical bytes.
     */
    const briefPath = await this.ports.brief.write(newSessionId, renderTransferBrief(plan, this.kind));

    return { briefPath, copiedAttachmentIds: copied };
  }
}
