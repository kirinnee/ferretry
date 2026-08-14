/**
 * Preparation: read a live session and decide, in one serialisable value, what a NEW session may be
 * born with.
 *
 * This half is constructed with readers and contributors and NOTHING else (I1, I2). It cannot write
 * to its source, cannot stop it, and does not know whether the caller intends to leave the source
 * running afterwards. That ignorance is the safety property: a fork must leave its source untouched,
 * and the only way to be sure of that is for the code that reads the source to have no way of
 * touching it.
 *
 * It is also re-runnable and free of durable effects, so a dry run and the real preparation are the
 * same call. A preview computed by a second path is a preview that can lie.
 */

import { type SessionTransferPlan, SessionTransferPlanSchema, type TransferOmission } from '@ferretry/protocol';
import { createHash } from 'node:crypto';
import {
  type SessionTransferPreparePorts,
  TransferPrepareError,
  type TransferPrepareRequest,
  type TransferSourceSession,
} from './types.ts';
import { transferTargetLabel } from './facets/lineage.ts';

const TRANSFER_PLAN_NAMESPACE = 'transfer';

/**
 * The seam's replay anchor: one `(sourceSessionId, requestId)` pair names exactly one plan.
 *
 * Derived, never random, so a retried or restarted transfer addresses the SAME durable document by
 * construction rather than by lookup — and a second request under the same pair carrying a different
 * decision cannot mint a "second plan", which is what makes request-id reuse a detectable conflict
 * instead of a silent overwrite.
 *
 * Every component that needs a plan id calls this one function. Two honest components deriving it
 * separately would eventually mint two ids for one plan, which is the defect the single-owner rule
 * exists to prevent.
 */
export function deriveTransferPlanId(sourceSessionId: string, requestId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([TRANSFER_PLAN_NAMESPACE, sourceSessionId, requestId]))
    .digest('hex');
}

/**
 * Operator argv belongs to the harness it was written for.
 *
 * Within one family the input domain is identical, so the flags are carried verbatim. Across
 * families they are dropped and each one is named in the report, because the alternative — a
 * translation table between two vendors' command lines — is a second definition of somebody else's
 * interface that nothing in this repository can keep honest, and its failure mode is an agent
 * launched with silently different behaviour.
 */
function harnessFlagOmissions(source: TransferSourceSession, targetHarness: string): readonly TransferOmission[] {
  return source.harnessFlags.map(flag => ({
    facet: 'runtime' as const,
    subject: flag,
    reason: 'harness_incompatible' as const,
    detail:
      `${flag} is a ${source.harness} launch argument and this transfer targets ${targetHarness}; ` +
      'it is dropped rather than translated, so the new session starts with the flags its own harness understands',
  }));
}

export class SessionTransferPreparer {
  constructor(private readonly ports: SessionTransferPreparePorts) {}

  async prepare(request: TransferPrepareRequest): Promise<SessionTransferPlan> {
    const source = await this.ports.source.read(request.sourceSessionId);
    if (source === undefined)
      throw new TransferPrepareError(
        'source_not_found',
        `session ${request.sourceSessionId} does not exist, so there is nothing to prepare a transfer from`,
      );

    /**
     * A byte offset is an offset into ONE exact file. A source with no transcript provenance names
     * no such file, so a cut against it is not a wrong answer — it is an answer about a different
     * conversation. Refuse before anything is created rather than fork from a guess.
     */
    if (request.cutMessagePoint !== null && source.transcriptProvenance === null)
      throw new TransferPrepareError(
        'conversation_unavailable',
        `session ${source.sessionId} has no transcript provenance, so the message point it was asked to cut at ` +
          'addresses no file this daemon can name',
      );

    const input = { request, source };
    const conversation = await this.ports.contributors.conversation.contribute(input);

    if (request.cutMessagePoint === null) {
      if (request.selectionBinding !== null || conversation.selectionEvidence !== null)
        throw new TransferPrepareError(
          'plan_invalid',
          'a transfer with no conversation cut must carry neither a selection binding nor raw-prefix evidence',
        );
    }

    /**
     * Authenticate the exact raw prefix the conversation contributor just decided to freeze.
     *
     * This sits after that one pinned transcript read and before every other contributor. Moving it
     * earlier would verify bytes a later read could replace; moving it later would let attachment,
     * workspace or lineage reads happen for a request whose selection was already stale. No receipt
     * or target id exists yet, so a refusal leaves no fork effect behind.
     */
    if (request.cutMessagePoint !== null) {
      const provenance = source.transcriptProvenance;
      if (conversation.value === null || conversation.selectionEvidence === null)
        throw new TransferPrepareError(
          'plan_invalid',
          'the conversation contributor returned no carried cut or raw-prefix evidence for a message transfer',
        );
      if (
        provenance === null ||
        request.selectionBinding === null ||
        !(await this.ports.selection.verifySelection(
          {
            sourceSessionId: source.sessionId,
            sourceIncarnation: source.incarnation,
            transcriptProvenance: provenance,
            through: request.cutMessagePoint,
            rawPrefix: conversation.selectionEvidence.rawPrefix,
          },
          request.selectionBinding,
        ))
      )
        throw new TransferPrepareError(
          'selection_stale',
          'the selected transcript message no longer has the raw conversation prefix the read surface authenticated',
        );
    }
    const facetInput = { ...input, conversation: conversation.value };
    const [attachments, references, workspace, lineage] = await Promise.all([
      this.ports.contributors.attachments.contribute(input),
      this.ports.contributors.references.contribute(facetInput),
      this.ports.contributors.workspace.contribute(input),
      this.ports.contributors.lineage.contribute(input),
    ]);

    const sameHarness = source.harness === request.target.harness;
    const plan = {
      v: 1,
      planId: deriveTransferPlanId(request.sourceSessionId, request.requestId),
      preparedAt: request.preparedAt,
      source: {
        sessionId: source.sessionId,
        incarnation: source.incarnation,
        runtimeGeneration: source.runtimeGeneration,
        harness: source.harness,
        agent: source.agent,
        model: source.model,
        teammate: source.teammate,
        name: source.name,
        label: source.label,
        transcriptProvenance: source.transcriptProvenance,
        cutMessagePoint: request.cutMessagePoint,
      },
      target: request.target,
      durable: {
        cwd: source.cwd,
        mode: source.mode,
        /** Both halves of this seam produce a TOP-LEVEL session. */
        parentSessionId: null,
        /** I3, stated in the payload as well as enforced by the importer's port set. */
        boardAccess: 'none',
        // The source label remains inventoried above. The target follows the same shield rule as a
        // normal spawn: warden descent forces the detector's operational label.
        label: transferTargetLabel(lineage.value, source.label),
        harnessFlags: sameHarness ? source.harnessFlags : [],
        remoteControl: source.remoteControl,
        intervalSeconds: source.intervalSeconds,
        timeoutSeconds: source.timeoutSeconds,
        nudgeAfterSeconds: source.nudgeAfterSeconds,
        killAfterSeconds: source.killAfterSeconds,
        directSendMaxChars: source.directSendMaxChars,
        resumeMenuChoice: source.resumeMenuChoice,
        maxSnapshots: source.maxSnapshots,
        retry: source.retry,
      },
      facets: {
        conversation: conversation.value,
        attachments: attachments.value,
        references: references.value,
        workspace: workspace.value,
        lineage: lineage.value,
      },
      notCarried: [
        ...conversation.omissions,
        ...attachments.omissions,
        ...references.omissions,
        ...workspace.omissions,
        ...lineage.omissions,
        ...(sameHarness ? [] : harnessFlagOmissions(source, request.target.harness)),
      ],
    };

    /**
     * Parsed rather than asserted. A contributor that answered with a shape the payload forbids —
     * a conversation facet where the caller named no cut, say — is a defect in this daemon, and the
     * transfer is refused here, before a session exists to receive it.
     */
    const parsed = SessionTransferPlanSchema.safeParse(plan);
    if (!parsed.success)
      throw new TransferPrepareError(
        'plan_invalid',
        `the transfer plan for ${source.sessionId} is not a valid payload: ${parsed.error.issues
          .map(issue => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
      );
    return parsed.data;
  }
}
