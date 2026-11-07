/**
 * The durable fork receipt: one strict value that makes a restart replay a fork instead of
 * performing a second one.
 *
 * THE ORDERING ARGUMENT, because everything else here follows from it. Preparation is the only place
 * that DERIVES source decisions, and a source is a live session whose transcript grows while the
 * fork runs. So the decision preparation produced — the plan, and the fresh target id it is to be
 * applied to — is written down BEFORE anything is created, and every later attempt under the same
 * key applies that written decision rather than deriving a new one. Import still validation-only
 * re-reads the pinned provenance and point; it never replaces the frozen decision. A fork that
 * re-prepared after a crash would silently capture a longer conversation than the one the caller was
 * shown, and nothing downstream could tell the difference.
 *
 * THE PHASE IS EXPLICIT AND MONOTONIC. Each phase name means "this boundary is done", and the
 * receipt is stamped AFTER the side effect it names. A crash in the gap therefore re-enters exactly
 * one step, and every step has a durable replay answer: creating under an id already written down is
 * idempotent, persisting the plan is a whole-document write of a value that cannot change, the import
 * is bound to the target and content-addressed, capturing the target's own transcript provenance is
 * a re-observation, and startup's irreversible pane actions have their own begun/settled ledger. A
 * settled startup resumes; a begun-but-unsettled one refuses rather than repeating the pane action.
 * Stamping BEFORE the effect would claim work that had not happened, which is the more dangerous of
 * the two errors: a replay would skip a boundary the fork never actually crossed.
 *
 * WHAT IS DURABLE AND WHAT IS NOT. The import report is durable, because it is the record of what
 * could not be carried and re-deriving it would mean re-importing to find out. The target's
 * `SessionView` is deliberately NOT durable: a stored view is a snapshot of a session that keeps
 * running, so a lost response answered from one would report a state the session left minutes ago.
 * A completed replay reads the target's current view instead — a target-bound read, not a second
 * start.
 */

import { InstantSchema, type SessionTransferPlan, SessionTransferPlanSchema } from '@ferretry/protocol';
import { z } from 'zod';
import { deriveTransferPlanId } from '../transfer/prepare.ts';
import { SessionForkPhaseRegressionError, SessionForkReceiptInvalidError } from './failures.ts';
import { type SessionForkKey, sessionForkDecisionFingerprint } from './identity.ts';

/**
 * The phases, in the only order a fork may pass through them.
 *
 * The array IS the ordering: rank is its index, so a phase cannot be added without deciding where
 * in the sequence it belongs, and no second table can drift from it.
 */
export const SESSION_FORK_PHASES = [
  /** Prepared, and this exact plan and target id are durably reserved. Nothing is created yet. */
  'claimed',
  /** The fresh target session record exists, under the reserved id. */
  'target_created',
  /** The parsed plan is persisted beneath the target, so the import replays it rather than a new one. */
  'plan_persisted',
  /** The target-bound import applied the plan and produced its report. */
  'imported',
  /** The target's OWN transcript provenance has been captured — never the source's, copied. */
  'provenance_captured',
  /** The target is started and the fork is durably done. */
  'completed',
] as const;

const SessionForkPhaseSchema = z.enum(SESSION_FORK_PHASES);
export type SessionForkPhase = z.infer<typeof SessionForkPhaseSchema>;

/** Where a phase sits in the sequence. Higher is later; equality is not progress. */
export function sessionForkPhaseRank(phase: SessionForkPhase): number {
  return SESSION_FORK_PHASES.indexOf(phase);
}

/**
 * The operational facts the import materialised, in the shape the receipt stores them.
 *
 * Structurally the transfer seam's own import outcome. It is re-declared as a SCHEMA here because
 * this value comes back off disk after a restart and an interface cannot parse anything; the unit
 * tests assert the two agree in both directions so the copy cannot drift into a second definition.
 * Omissions are deliberately absent: `receipt.plan.notCarried` is their sole durable fact owner.
 */
const SessionForkImportReportSchema = z.strictObject({
  briefPath: z.string().min(1),
  copiedAttachmentIds: z.array(z.string().min(1)).readonly(),
});
export type SessionForkImportReport = z.infer<typeof SessionForkImportReportSchema>;

const SessionForkPhaseStampSchema = z.strictObject({
  phase: SessionForkPhaseSchema,
  at: InstantSchema,
});

const SessionForkFingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * The whole durable value, parsed rather than asserted.
 *
 * Every cross-field rule below is a property a replay depends on, which is why they are refinements
 * on the schema and not comments: a receipt that violates one is refused on the way IN, before it
 * can be used to decide whether a session has already been created.
 */
const SessionForkReceiptSchema = z
  .strictObject({
    v: z.literal(1),
    /** The outer storage anchor; it must equal both the nested plan id and the derived key id. */
    planId: z.string().min(1),
    sourceSessionId: z.string().min(1),
    requestId: z.string().min(1),
    /** Lets replay reject a changed caller payload without re-reading a moving source. */
    requestFingerprint: SessionForkFingerprintSchema,
    /** Recomputed identity of the explicit target and complete parsed plan. */
    fingerprint: SessionForkFingerprintSchema,
    /** Reserved before creation and reused by every replay, so one fork has one target forever. */
    targetSessionId: z.string().min(1),
    /** The exact decision preparation made. Replayed, never re-derived. */
    plan: SessionTransferPlanSchema,
    phase: SessionForkPhaseSchema,
    /** Append-only, so a restart can see which boundaries were crossed and when. */
    phaseHistory: z.array(SessionForkPhaseStampSchema).min(1).readonly(),
    report: SessionForkImportReportSchema.nullable(),
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
  })
  .superRefine((value, context) => {
    const expectedPlanId = deriveTransferPlanId(value.sourceSessionId, value.requestId);
    if (value.planId !== expectedPlanId)
      context.addIssue({
        code: 'custom',
        message: 'the outer plan id must be derived from this receipt source and request id',
        path: ['planId'],
      });

    if (value.plan.planId !== value.planId)
      context.addIssue({
        code: 'custom',
        message: 'the nested transfer plan id must equal the receipt plan id',
        path: ['plan', 'planId'],
      });

    if (value.plan.source.sessionId !== value.sourceSessionId)
      context.addIssue({
        code: 'custom',
        message: 'the receipt must name the source its own transfer plan was prepared from',
        path: ['sourceSessionId'],
      });

    if (value.plan.source.cutMessagePoint === null)
      context.addIssue({
        code: 'custom',
        message: 'a fork carries a conversation, so its plan must name the exact message it was cut at',
        path: ['plan', 'source', 'cutMessagePoint'],
      });

    if (value.targetSessionId === value.sourceSessionId)
      context.addIssue({
        code: 'custom',
        message: 'a fork always creates a fresh session and never writes into the one it read',
        path: ['targetSessionId'],
      });

    const expectedFingerprint = sessionForkDecisionFingerprint({
      key: { sourceSessionId: value.sourceSessionId, requestId: value.requestId },
      requestFingerprint: value.requestFingerprint,
      targetSessionId: value.targetSessionId,
      plan: value.plan,
    });
    if (value.fingerprint !== expectedFingerprint)
      context.addIssue({
        code: 'custom',
        message: 'the receipt fingerprint must cover its explicit target and complete parsed plan',
        path: ['fingerprint'],
      });

    const ranks = value.phaseHistory.map(stamp => sessionForkPhaseRank(stamp.phase));
    if (value.phaseHistory.at(0)?.phase !== 'claimed')
      context.addIssue({
        code: 'custom',
        message: 'a fork begins by claiming its receipt: nothing precedes the claim',
        path: ['phaseHistory', 0],
      });
    if (!ranks.every((rank, index) => index === 0 || rank === (ranks[index - 1] ?? -1) + 1))
      context.addIssue({
        code: 'custom',
        message: 'the phase history records every boundary exactly once and in order',
        path: ['phaseHistory'],
      });
    if (value.phaseHistory.at(-1)?.phase !== value.phase)
      context.addIssue({
        code: 'custom',
        message: 'the current phase is the last one the history recorded',
        path: ['phase'],
      });

    if (value.phaseHistory.at(0)?.at !== value.createdAt)
      context.addIssue({
        code: 'custom',
        message: 'the claim stamp and receipt creation time must agree',
        path: ['createdAt'],
      });
    if (value.phaseHistory.at(-1)?.at !== value.updatedAt)
      context.addIssue({
        code: 'custom',
        message: 'the last phase stamp and receipt update time must agree',
        path: ['updatedAt'],
      });
    if (value.plan.preparedAt !== value.createdAt)
      context.addIssue({
        code: 'custom',
        message: 'the frozen plan and the claim that owns it must share one decision time',
        path: ['plan', 'preparedAt'],
      });

    const imported = sessionForkPhaseRank(value.phase) >= sessionForkPhaseRank('imported');
    if (imported !== (value.report !== null))
      context.addIssue({
        code: 'custom',
        message: 'the import report exists exactly once the import has run, and never before it',
        path: ['report'],
      });
  });
export type SessionForkReceipt = z.infer<typeof SessionForkReceiptSchema>;

/**
 * Reads a stored document as this key's receipt, refusing anything else.
 *
 * The key check is not paranoia about the store: a receipt answered for the wrong pair would let
 * one caller's fork be reported as another's, and the composite key is the only thing that
 * distinguishes two callers who minted the same request id.
 */
export function parseSessionForkReceipt(document: unknown, key: SessionForkKey): SessionForkReceipt {
  const parsed = SessionForkReceiptSchema.safeParse(document);
  if (!parsed.success)
    throw new SessionForkReceiptInvalidError(
      key,
      parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; '),
    );
  if (parsed.data.sourceSessionId !== key.sourceSessionId || parsed.data.requestId !== key.requestId)
    throw new SessionForkReceiptInvalidError(
      key,
      `it belongs to ${parsed.data.sourceSessionId} under request ${parsed.data.requestId}`,
    );
  return parsed.data;
}

/** Everything decided before a fork is allowed to create anything. */
export interface SessionForkClaim {
  readonly key: SessionForkKey;
  readonly requestFingerprint: string;
  readonly targetSessionId: string;
  readonly plan: SessionTransferPlan;
  readonly at: string;
}

/** The receipt as it is first written: a reserved target, an exact plan, and no work done. */
export function claimSessionForkReceipt(claim: SessionForkClaim): SessionForkReceipt {
  const planId = deriveTransferPlanId(claim.key.sourceSessionId, claim.key.requestId);
  const fingerprint = sessionForkDecisionFingerprint({
    key: claim.key,
    requestFingerprint: claim.requestFingerprint,
    targetSessionId: claim.targetSessionId,
    plan: claim.plan,
  });
  return parseSessionForkReceipt(
    {
      v: 1,
      planId,
      sourceSessionId: claim.key.sourceSessionId,
      requestId: claim.key.requestId,
      requestFingerprint: claim.requestFingerprint,
      fingerprint,
      targetSessionId: claim.targetSessionId,
      plan: claim.plan,
      phase: 'claimed',
      phaseHistory: [{ phase: 'claimed', at: claim.at }],
      report: null,
      createdAt: claim.at,
      updatedAt: claim.at,
    },
    claim.key,
  );
}

/** One boundary crossed, and whatever crossing it produced. */
export interface SessionForkAdvance {
  readonly phase: SessionForkPhase;
  readonly at: string;
  readonly report?: SessionForkImportReport;
}

/**
 * The next receipt, re-proved against the schema.
 *
 * Re-parsing on every transition is what makes the cross-field rules hold for the whole life of the
 * receipt rather than only at its birth — an advance that produced an inconsistent value is refused
 * here, before it is written down and believed by the next attempt.
 */
export function advanceSessionForkReceipt(
  receipt: SessionForkReceipt,
  advance: SessionForkAdvance,
): SessionForkReceipt {
  if (sessionForkPhaseRank(advance.phase) <= sessionForkPhaseRank(receipt.phase))
    throw new SessionForkPhaseRegressionError(receipt.phase, advance.phase);
  return parseSessionForkReceipt(
    {
      ...receipt,
      phase: advance.phase,
      phaseHistory: [...receipt.phaseHistory, { phase: advance.phase, at: advance.at }],
      report: advance.report ?? receipt.report,
      updatedAt: advance.at,
    },
    { sourceSessionId: receipt.sourceSessionId, requestId: receipt.requestId },
  );
}

/**
 * The durable operational report of what the import materialised.
 *
 * The schema already ties the report's presence to the phase, so this refuses rather than returns a
 * placeholder: a fork that reached its last phase without a report is a receipt this daemon wrote
 * wrong, and reporting "nothing was omitted" would be a confident lie about a transfer nobody can
 * reconstruct. Omission reporting always reads `receipt.plan.notCarried`; this report never owns a
 * second omission inventory.
 */
export function sessionForkReport(receipt: SessionForkReceipt): SessionForkImportReport {
  if (receipt.report === null)
    throw new SessionForkReceiptInvalidError(
      { sourceSessionId: receipt.sourceSessionId, requestId: receipt.requestId },
      `it reached ${receipt.phase} carrying no import report`,
    );
  return receipt.report;
}
