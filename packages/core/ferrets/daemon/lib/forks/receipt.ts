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

import {
  SESSION_FORK_PHASES,
  type SessionForkImportReport,
  type SessionForkPhase,
  type SessionForkReceipt,
  SessionForkReceiptSchema,
  type SessionTransferPlan,
  SessionTransferPlanSchema,
  sessionForkPhaseRank,
} from '../../../contract/transfer.ts';
import { deriveTransferPlanId } from '../transfer/prepare.ts';
import { SessionForkPhaseRegressionError, SessionForkReceiptInvalidError } from './failures.ts';
import { type SessionForkKey, sessionForkDecisionFingerprint } from './identity.ts';

/**
 * The phases, the import report and the receipt's schema are the CONTRACT's (`contract/transfer.ts`): the document is
 * the body of `state/ferrets/forks/<planId>.json`, so the state port parses it and a second schema here would be a
 * second owner of the same value. What stays here is what a contract cannot hold, because it imports no hashing: the
 * plan id derived from (source, request) and the decision fingerprint, both sha256 checks, added by
 * {@link parseSessionForkReceipt} on top of the contract's own parse.
 */
export { SESSION_FORK_PHASES, sessionForkPhaseRank };
export type { SessionForkImportReport, SessionForkPhase, SessionForkReceipt };

/**
 * The two cross-checks the contract's schema cannot make because they hash: the outer plan id must be the one
 * derived from this receipt's source and request id, and the fingerprint must cover the explicit target and the
 * complete parsed plan. Each reads `<path> <sentence>`, as a schema issue does.
 *
 * It reads the raw document, so a receipt the contract's own parse refuses is still told everything that is wrong with
 * it in one message, as the single schema with refinements always told it. A field it cannot read is not a complaint of
 * its own: the contract's issues already name it.
 */
function hashedDisagreements(document: unknown): readonly string[] {
  const fields =
    typeof document === 'object' && document !== null ? (document as Readonly<Record<string, unknown>>) : {};
  const complaints: string[] = [];
  const { sourceSessionId, requestId, planId, requestFingerprint, targetSessionId, fingerprint } = fields;
  if (typeof sourceSessionId !== 'string' || typeof requestId !== 'string') return complaints;
  if (typeof planId === 'string' && planId !== deriveTransferPlanId(sourceSessionId, requestId))
    complaints.push('planId the outer plan id must be derived from this receipt source and request id');
  const plan = SessionTransferPlanSchema.safeParse(fields.plan);
  if (
    plan.success &&
    typeof requestFingerprint === 'string' &&
    typeof targetSessionId === 'string' &&
    typeof fingerprint === 'string' &&
    fingerprint !==
      sessionForkDecisionFingerprint({
        key: { sourceSessionId, requestId },
        requestFingerprint,
        targetSessionId,
        plan: plan.data,
      })
  )
    complaints.push('fingerprint the receipt fingerprint must cover its explicit target and complete parsed plan');
  return complaints;
}

/**
 * Reads a stored document as this key's receipt, refusing anything else.
 *
 * The key check is not paranoia about the store: a receipt answered for the wrong pair would let
 * one caller's fork be reported as another's, and the composite key is the only thing that
 * distinguishes two callers who minted the same request id.
 */
export function parseSessionForkReceipt(document: unknown, key: SessionForkKey): SessionForkReceipt {
  const parsed = SessionForkReceiptSchema.safeParse(document);
  const hashed = hashedDisagreements(document);
  if (!parsed.success)
    throw new SessionForkReceiptInvalidError(
      key,
      [...hashed, ...parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`)].join('; '),
    );
  if (hashed.length > 0) throw new SessionForkReceiptInvalidError(key, hashed.join('; '));
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
