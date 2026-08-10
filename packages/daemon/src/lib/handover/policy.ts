/**
 * The handover's decisions, with nothing that can touch a disk.
 *
 * Everything here is a pure function of a receipt plus a snapshot of the world, which is what makes
 * the ladder testable phase by phase instead of only end to end. The service beside this file owns
 * the effects; this file owns what the effects are allowed to be.
 *
 * THE THREE RULES WORTH READING BEFORE THE CODE:
 *
 * 1. NOTHING INVENTS A FRESH ID PER ATTEMPT. Every board step id is a pure function of the receipt,
 *    so re-driving a step after a crash is a replay by construction, answered by the board reducer's
 *    own applied-operation ledger rather than by a second idempotency mechanism here.
 *
 * 2. ONE WAIT HAS A CLOCK, AND ONLY ONE. The deadline governs the wait for the replacement's
 *    verification, because that is the only step whose completion depends on something outside this
 *    daemon. Every other effect is deterministic and replayable, so elapsed wall time is not evidence
 *    that it failed — a timer over the coordinator leg would strand handovers that were about to work.
 *
 * 3. IRREVERSIBILITY IS A BOARD FACT, NOT A LADDER POSITION. A board handover becomes irreversible at
 *    `accepted`, because from there the board carries two active roots and nothing in this repository
 *    revokes a grant. A boardless handover never reaches `accepted` at all, so its replacement stays
 *    disposable right up until the predecessor is stopped.
 */

import { createHash } from 'node:crypto';
import { HarnessSchema } from '@ferretry/protocol';
import { isTerminalStatus } from '../warden/types.ts';
import type {
  HandoverBoardMembership,
  HandoverBoardObservation,
  HandoverFailure,
  HandoverPhase,
  HandoverReceipt,
  HandoverRequestBody,
  HandoverResolvedTarget,
  HandoverSessionView,
} from './types.ts';

/** The protocol's family union, as the eligibility check proves it. */
type HandoverHarness = ReturnType<typeof HarnessSchema.parse>;

/**
 * Whether the receipt has durably recorded that the gate cleared and the retirement has begun.
 *
 * A STRUCTURED FIELD, not a sentence in the phase history. `draining` is one phase name over two
 * situations — a handover parked waiting for the predecessor's own work, and one whose relinquish/stop
 * may already have been applied — and the invariant checks differ between them. Reading that
 * distinction out of a detail string would make a comment load-bearing.
 */
export function handoverIsRetiring(receipt: HandoverReceipt): boolean {
  if (receipt.effectIntent === 'retiring') return true;
  // THE COMMITTED EVENT COUNTS TOO, for the same reason irreversibility reads it: writing a settlement
  // intent CLEARS the active field, so a receipt that has just recorded why it is stopping would
  // otherwise stop looking like a retirement at the exact moment that mattered. The durable schema
  // agrees from the other side — a committed retiring tail may only roll forward, and settling it as
  // abandoned or stranded is a receipt it refuses outright.
  return receipt.phaseHistory.some(entry => entry.phase === 'draining' && entry.effectIntent === 'retiring');
}

/** A named refusal cause with the sentence an operator acts on. */
export interface HandoverRefusal {
  readonly failure: HandoverFailure;
  readonly message: string;
}

/** Phases a handover never leaves. */
const TERMINAL_PHASES = {
  requested: false,
  replacement_creating: false,
  replacement_created: false,
  invited: false,
  approved: false,
  accepted: false,
  replacement_started: false,
  verified: false,
  coordinator_creating: false,
  coordinator_created: false,
  coordinator_granted: false,
  coordinator_started: false,
  coordinator_replaced: false,
  draining: false,
  relinquished: false,
  predecessor_stopped: false,
  completed: true,
  refused: true,
  abandoned: true,
  stranded: true,
  failed: true,
} as const satisfies { readonly [K in HandoverPhase]: boolean };

/**
 * Where a BOARD handover has passed the point of no return.
 *
 * `accepted` is the line, and the reason is concrete: after it the board carries two active roots and
 * `TaskBoardOperationKind` names a `grant.revoke` no reducer implements, so the second root cannot be
 * taken back off. `refused` and `abandoned` are terminal states of a handover that never crossed;
 * `stranded` and `failed` are terminal states of one that did.
 */
const BOARD_PAST_NO_RETURN = {
  requested: false,
  replacement_creating: false,
  replacement_created: false,
  invited: false,
  approved: false,
  accepted: true,
  replacement_started: true,
  verified: true,
  coordinator_creating: true,
  coordinator_created: true,
  coordinator_granted: true,
  coordinator_started: true,
  coordinator_replaced: true,
  draining: true,
  relinquished: true,
  predecessor_stopped: true,
  completed: true,
  refused: false,
  abandoned: false,
  stranded: true,
  failed: true,
} as const satisfies { readonly [K in HandoverPhase]: boolean };

/**
 * Where a BOARDLESS handover has passed the point of no return.
 *
 * It never enters the board leg, so it never reaches `accepted` and nothing irreversible happens to
 * anybody else's document. What makes it irreversible is the one destructive act it does perform:
 * stopping the predecessor. Until then its replacement is a session this daemon created and may stop
 * again, `replacement_started` and `draining` included — which is exactly why this is a second table
 * rather than a reuse of the one above.
 */
const BOARDLESS_PAST_NO_RETURN = {
  requested: false,
  replacement_creating: false,
  replacement_created: false,
  invited: false,
  approved: false,
  accepted: false,
  replacement_started: false,
  verified: false,
  coordinator_creating: false,
  coordinator_created: false,
  coordinator_granted: false,
  coordinator_started: false,
  coordinator_replaced: false,
  draining: false,
  relinquished: false,
  predecessor_stopped: true,
  completed: true,
  refused: false,
  abandoned: false,
  stranded: true,
  failed: true,
} as const satisfies { readonly [K in HandoverPhase]: boolean };

export function isTerminalHandoverPhase(phase: HandoverPhase): boolean {
  return TERMINAL_PHASES[phase];
}

/** Whether this handover can still be taken back. The board changes the answer, so it is an input. */
export function isPointOfNoReturn(phase: HandoverPhase, hasBoard: boolean): boolean {
  return hasBoard ? BOARD_PAST_NO_RETURN[phase] : BOARDLESS_PAST_NO_RETURN[phase];
}

/**
 * Whether the receipt itself has passed its own point of no return.
 *
 * THE PHASE IS NOT THE WHOLE ANSWER, and a structured effect intent is why. `accepting` says the board
 * may already carry two active roots while the phase still reads `approved`; `retiring` says a stop or
 * a relinquish may already have been applied while the phase still reads `draining`. Both are windows
 * in which the durable phase understates what has happened, and cancelling inside either would try to
 * take back something already done.
 */
export function receiptIsIrreversible(receipt: HandoverReceipt): boolean {
  if (receipt.effectIntent !== undefined) return true;
  // THE RETAINED PROVENANCE COUNTS, NOT ONLY THE ACTIVE FIELD. Writing a same-phase settlement intent
  // CLEARS the active intent — the schema forbids holding both — so reading only that field would make
  // a receipt look reversible the instant it stopped saying it was mid-flight. The committed event
  // survives, and it is the honest answer: an `accepting` event at `approved` means the board may
  // already hold the grant, whatever the receipt currently says it is doing.
  if (receipt.phaseHistory.some(entry => entry.phase === receipt.phase && entry.effectIntent !== undefined)) {
    return true;
  }
  return isPointOfNoReturn(receipt.phase, receipt.board !== null);
}

/**
 * A digest of the ASK, so a replayed request id carrying a different one is a conflict.
 *
 * IT HASHES THE RAW REQUEST, NOT THE RESOLVED ACCOUNTS, and the difference decides what a retry
 * means. A fleet manifest is editable, so the same body can resolve to a different effort or context
 * window a minute later; fingerprinting the resolution would turn an operator's honest retry into
 * `request_conflict` because somebody else edited a file. What the resolution needs is not to be
 * re-derived at all — it is frozen ON THE RECEIPT and loaded, so drift cannot change a launch either.
 * One question each: this answers "did the caller ask for something else", and the receipt's own
 * `resolvedTarget` and `plan` answer "what exactly are we launching".
 */
export function handoverFingerprint(request: HandoverRequestBody): string {
  return digest([
    'handover.request',
    request.agent,
    request.model ?? '',
    request.coordinator?.agent ?? '',
    request.coordinator?.model ?? '',
    request.reason,
  ]);
}

/**
 * The id of the transfer plan this handover will import.
 *
 * DERIVED, never random: a crash between the create and the import must replay the same plan rather
 * than re-derive one against a source that has moved on. The receipt carries it from its very first
 * write, before a plan exists, so the service can check the prepared plan's own id against it and
 * refuse `plan_drifted` rather than importing a different decision than the one recorded.
 *
 * SEAM NOTE, and the lead must close it: the shared transfer seam owns this decision and exports
 * `deriveTransferPlanId`. That module is not in this tree yet, so this is the same derivation stated
 * once here — `hash(['transfer', sourceSessionId, requestId])`, exactly as the seam specifies. When
 * the seam's SHA lands, delete this function and import the seam's, so one derivation has one owner.
 */
export function handoverPlanId(sourceSessionId: string, requestId: string): string {
  return digest(['transfer', sourceSessionId, requestId]);
}

/** The board operations a handover drives, named so each derived id is provably distinct. */
export type HandoverStepId =
  | 'handover.invite'
  | 'handover.approve'
  | 'handover.accept'
  | 'handover.child-grant.request'
  | 'handover.child-grant.approve'
  | 'handover.coordinator.replace'
  | 'handover.relinquish'
  | 'handover.journal.source'
  | 'handover.journal.replacement';

/**
 * A stable operation id for one step of one handover.
 *
 * The step name distinguishes the operations, the request id distinguishes the handovers, and the
 * session ids pin the subjects — so two genuinely different operations cannot collide and the same
 * operation retried is byte-identical. It is what makes every effect below a replay rather than a
 * second attempt, and it is why nothing here needs a second idempotency mechanism.
 */
export function derivedStepId(receipt: HandoverReceipt, step: HandoverStepId): string {
  return digest([
    step,
    receipt.requestId,
    receipt.sourceSessionId,
    receipt.replacementSessionId ?? '',
    receipt.coordinatorSessionId ?? '',
  ]);
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export interface HandoverEligibilityInput {
  readonly source: HandoverSessionView;
  /** `null` when this root belongs to no board, which is a legitimate and much shorter handover. */
  readonly membership: HandoverBoardMembership | null;
  readonly target: HandoverResolvedTarget;
  /** True when a warden presented the authority for this action rather than an operator. */
  readonly wardenDriven: boolean;
}

/**
 * The eligibility answer, carrying the two families it had to parse to reach it.
 *
 * The parsed harnesses travel out rather than being re-parsed by the caller, because the receipt
 * demands a family the protocol recognises and this is the function that established it. A second
 * parse at the write would be a branch nothing could ever take — an unreachable line pretending to
 * be a safety check.
 */
export type HandoverEligibility =
  | { readonly ok: false; readonly refusal: HandoverRefusal }
  | { readonly ok: true; readonly sourceHarness: HandoverHarness; readonly replacementHarness: HandoverHarness };

/**
 * Whether this session may be handed over at all, decided before anything is created.
 *
 * Every refusal here leaves the subject untouched, running and still a member, and every one of them
 * is retryable with the same request id once the operator has fixed what it names. None of them
 * writes a receipt: there is no durable operation to answer for yet, and a document recording a
 * request the daemon never accepted would be a record of something that did not happen.
 */
export function handoverEligibility(input: HandoverEligibilityInput): HandoverEligibility {
  const { source, membership, target } = input;
  if (source.parentSessionId !== null) {
    return refused('not_top_level', [
      `session ${source.sessionId} has a parent, so its board access is a child grant tied to its lineage`,
      'rather than a membership; replacing it is a child re-grant, which is a different operation',
    ]);
  }
  // THE WARDEN CHECK COMES BEFORE THE FAMILY CHECK, and the order is the mechanism rather than a
  // preference: "a warden cannot widen board membership" must be the answer for EVERY board root a
  // warden names, including one whose target would have been refused for some other reason. Letting a
  // same-family target answer first would mean the prohibition only shows up when nothing else does.
  if (membership !== null && input.wardenDriven) {
    return refused('board_authority_required', [
      `session ${source.sessionId} is a board root, and widening board membership needs the explicit`,
      'invitation authority a warden holds no credential for; a human or an operator-authenticated client',
      'must run this handover',
    ]);
  }
  const harness = harnessDecision(source.harness, target.replacement.harness, target.replacement.agent);
  if (!harness.ok) return harness;
  if (membership === null) {
    // A BOARDLESS ROOT NAMING A COORDINATOR IS THE SAME RULE VIOLATED FROM THE OTHER SIDE. The durable
    // receipt requires board membership and the coordinator target to agree — board IF AND ONLY IF
    // coordinator — so this is `coordinator_required` read in the other direction, not a new cause.
    //
    // IT IS REFUSED, NOT NORMALISED. Dropping the coordinator silently would launch something other
    // than what the operator asked for; creating one would spawn a descendant that nothing ever seats,
    // because there is no board to seat it on. And it has to be caught HERE: left to the write, the
    // caller would get a schema-parse error out of the receipt store instead of a named refusal, which
    // is a stack trace where an actionable answer belongs.
    if (target.coordinator !== null) {
      return refused('coordinator_required', [
        `session ${source.sessionId} belongs to no board, so there is nothing for a coordinator to`,
        `coordinate — but this request names ${target.coordinator.agent}. A coordinator is required`,
        'exactly when a board is present and forbidden when it is not; send `coordinator: null` for a',
        'boardless root rather than a descendant no board would ever seat',
      ]);
    }
    return harness;
  }
  if (source.mode !== 'interactive') {
    return refused('mode_not_invitable', [
      `session ${source.sessionId} runs in ${source.mode} mode, and an external invitation requires both`,
      'roots to be interactive; handing it over without the board would silently drop the board',
    ]);
  }
  if (target.coordinator === null) {
    return refused('coordinator_required', [
      `board ${membership.boardId} would be left with no coordinator: relinquishing a root revokes every`,
      'grant beneath it, the seated coordinator grant included, and a board with no coordinator can never',
      'approve anything again — so a board handover must name the coordinator the replacement will seat',
    ]);
  }
  if (!membership.coordinatorAlive) {
    return refused('no_live_coordinator', [
      `board ${membership.boardId} has no live current coordinator, so no invitation on it could be`,
      'approved; the handover is refused before anything is created',
    ]);
  }
  if (membership.outstandingInvitation) {
    return refused('board_busy', [
      `board ${membership.boardId} already carries an outstanding external invitation, and the reducer`,
      'admits exactly one at a time',
    ]);
  }
  // TWO ACTIVE ROOTS AND NO PENDING INVITATION is the state an accepted-but-unverified handover
  // leaves behind, and it is invisible to the check above because the acceptance consumed the
  // invitation. Refusing it here rather than at the reducer is what stops a second handover minting
  // an identity and creating a session that the board would then decline to admit.
  // SOLE, not merely present. `invitation.request` demands exactly one active root, so an empty
  // roster and a roster this session is missing from are refusals as surely as a second root is —
  // and refusing here rather than at the reducer is what stops a doomed request minting an identity
  // and creating a session first.
  const roots = membership.activeRootSessionIds;
  if (roots.length !== 1 || roots[0] !== source.sessionId) {
    return refused('board_busy', [
      `board ${membership.boardId} does not have ${source.sessionId} as its sole active membership root`,
      `(it reports ${roots.length === 0 ? 'none' : roots.join(', ')}), which an invitation demands;`,
      'an earlier handover of this board has not finished, or this session is no longer its root',
    ]);
  }
  return harness;
}

function refused(failure: HandoverFailure, sentence: readonly string[]): HandoverEligibility {
  return { ok: false, refusal: { failure, message: sentence.join(' ') } };
}

/**
 * The mirror of the migration's family check: a handover refuses SAMENESS.
 *
 * An unrecognised family on either side is a refusal rather than a comparison, for the reason the
 * migration gate already gives: two strings this build cannot parse are not shown to be different
 * just because they look it, and the answer to "I cannot prove this" is not to destroy a pane.
 */
function harnessDecision(sourceHarness: string, targetHarness: string, targetAgent: string): HandoverEligibility {
  const known = HarnessSchema.options.join(', ');
  const source = HarnessSchema.safeParse(sourceHarness);
  if (!source.success) {
    return refused('harness_unknown', [
      `this session records harness ${JSON.stringify(sourceHarness)}, which this daemon does not recognise`,
      `(it knows ${known}); a handover must know the family it is leaving before it can prove the account it`,
      'is moving to is a different one',
    ]);
  }
  const target = HarnessSchema.safeParse(targetHarness);
  if (!target.success) {
    return refused('harness_unknown', [
      `account ${targetAgent} declares harness ${JSON.stringify(targetHarness)}, which this daemon does not`,
      `recognise (it knows ${known}); it cannot be shown to be a different family from this ${source.data}`,
      'session, so the handover is refused rather than guessed at',
    ]);
  }
  if (source.data === target.data) {
    return refused('harness_same', [
      `this session runs the ${source.data} harness and ${targetAgent} is also a ${target.data} account; a`,
      'handover throws the conversation away because the target cannot read it, so moving inside one family',
      'would destroy a transcript for nothing — use a migration, which keeps it',
    ]);
  }
  return { ok: true, sourceHarness: source.data, replacementHarness: target.data };
}

/** One advance of the ladder, as the service performs it. */
export type HandoverStep =
  | 'claim_replacement_identity'
  | 'create_replacement'
  | 'invite'
  | 'approve'
  | 'accept'
  | 'start_replacement'
  | 'record_verified'
  | 'claim_coordinator_identity'
  | 'create_coordinator'
  | 'grant_coordinator'
  | 'start_coordinator'
  | 'replace_coordinator'
  | 'enter_draining'
  | 'drain'
  | 'retire_without_gate'
  | 'stop_predecessor'
  | 'complete';

export type HandoverPlan =
  | { readonly kind: 'step'; readonly step: HandoverStep }
  /** Nothing left to do: the receipt is terminal. */
  | { readonly kind: 'settled' }
  /** Nothing to do YET, and waiting is the correct behaviour rather than a failure. */
  | { readonly kind: 'wait'; readonly reason: string }
  /** Stop before a replacement was ever created: `refused`, and nothing was touched. */
  | { readonly kind: 'refuse'; readonly failure: HandoverFailure; readonly reason: string }
  /** A replacement exists and is disposable: stop it, then `abandoned`. The invitation expires by itself. */
  | { readonly kind: 'abandon'; readonly failure: HandoverFailure; readonly reason: string }
  /** Past the point of no return and unable to finish: roll forward only, and raise a human. */
  | { readonly kind: 'strand'; readonly failure: HandoverFailure; readonly reason: string }
  /** Past the retirement of the predecessor: the receipt records what happened and stops. */
  | { readonly kind: 'fail'; readonly failure: HandoverFailure; readonly reason: string };

export interface HandoverWorld {
  readonly now: string;
  /**
   * The predecessor's own record.
   *
   * Read on every advance because the last destructive act of a handover is stopping it, and a crash
   * between that stop and the phase write leaves a receipt that must be reconciled against what the
   * session IS rather than re-decided from the gate that authorized it. `null` when the record is
   * gone entirely, which is the same fact as terminal for every purpose here.
   */
  readonly source: HandoverSessionView | null;
  /** The replacement's own record, once one exists. */
  readonly replacement: HandoverSessionView | null;
  /** The board the receipt names, re-read on every advance. `null` for a boardless handover. */
  readonly board: HandoverBoardObservation | null;
  readonly verificationDeadlineMinutes: number;
}

/**
 * What this handover should do next.
 *
 * Three questions are answered before the ladder is consulted at all, in this order and for reasons
 * that do not commute: a terminal receipt is finished; a durable cancellation intent outranks forward
 * progress, or a crash between the intent and its cleanup would resume the very handover an operator
 * just stopped; and the board must still exist, because "the board and its tasks never move" is a
 * claim about the whole operation rather than about its first instant.
 */
export function nextPhase(receipt: HandoverReceipt, world: HandoverWorld): HandoverPlan {
  if (isTerminalHandoverPhase(receipt.phase)) return { kind: 'settled' };
  // SOURCE LOSS IS CLASSIFIED FIRST — ahead of a cancellation, ahead of any other settlement, and ahead
  // of every forward step. A predecessor that died outside this handover's own retirement changes what
  // all of those MEAN: an operator's cancel that raced it is not a cancellation outcome, and recording
  // one would promise something false about a session that is already gone.
  const lost = sourceLoss(receipt, world);
  if (lost !== null) return lost;
  // A DURABLE FAILURE INTENT OUTRANKS FORWARD PROGRESS, whatever named it. It is written before the
  // first terminal side effect, so a crash between the two — a replacement stopped but not yet recorded
  // as abandoned, an Attention raised but not yet recorded as stranded — resumes the settlement rather
  // than the ladder. Restricting this to `cancelled` would leave every other named failure with that
  // window wide open.
  const settling = receipt.refusal;
  if (settling !== undefined)
    // A NULL SETTLEMENT MEANS THE TAIL REPLAYS, and WHICH tail step depends on where in it the
    // receipt is: at `draining` the retirement is resumed without re-gating, and from `relinquished`
    // the only work left is the stop. Answering one of them everywhere would skip a committed
    // relinquish or ask a gate that was already cleared.
    return (
      handoverSettlement(receipt, world, settling.failure, settling.message) ?? {
        kind: 'step',
        step: receipt.phase === 'draining' ? 'retire_without_gate' : 'stop_predecessor',
      }
    );
  const moved = boardInvariantBreach(receipt, world);
  if (moved !== null) return moved;
  switch (receipt.phase) {
    case 'requested':
      return { kind: 'step', step: 'claim_replacement_identity' };
    case 'replacement_creating':
      return { kind: 'step', step: 'create_replacement' };
    case 'replacement_created':
      return { kind: 'step', step: receipt.board === null ? 'start_replacement' : 'invite' };
    case 'invited':
      return { kind: 'step', step: 'approve' };
    case 'approved':
      return { kind: 'step', step: 'accept' };
    case 'accepted':
      return { kind: 'step', step: 'start_replacement' };
    case 'replacement_started':
      return receipt.board === null ? { kind: 'step', step: 'enter_draining' } : verification(receipt, world);
    case 'verified':
      return { kind: 'step', step: 'claim_coordinator_identity' };
    case 'coordinator_creating':
      return { kind: 'step', step: 'create_coordinator' };
    case 'coordinator_created':
      return { kind: 'step', step: 'grant_coordinator' };
    case 'coordinator_granted':
      return { kind: 'step', step: 'start_coordinator' };
    case 'coordinator_started':
      return { kind: 'step', step: 'replace_coordinator' };
    case 'coordinator_replaced':
      return { kind: 'step', step: 'enter_draining' };
    case 'draining':
      return draining(receipt);
    case 'relinquished':
      return { kind: 'step', step: 'stop_predecessor' };
    default:
      return completion(receipt);
  }
}

export type HandoverSettlement = Extract<HandoverPlan, { readonly kind: 'refuse' | 'abandon' | 'strand' | 'fail' }>;

/**
 * WHERE A FAILING HANDOVER SETTLES — one table, one owner, every progress phase on both tracks.
 *
 * This is the rule that decides which terminal phase a named failure becomes, and it was worth pulling
 * into one function because it was previously three: the cleanup path, the board-breach path and the
 * service's own step-error path each answered it, and three answers to one question is how they drift.
 *
 * The four outcomes are not interchangeable and an operator reads them differently:
 *
 *  - `refused`   nothing was ever created; the subject is untouched and the same request may try again.
 *  - `abandoned` a replacement exists and is being stopped again; something happened and was undone.
 *  - `stranded`  the board carries two active roots and nothing revokes a grant, so it rolls forward
 *                only, with the predecessor still running and still a member. BOARD ONLY: a boardless
 *                handover has no second root to strand behind it.
 *  - `failed`    the predecessor is already stopped, so the destruction is behind it and there is
 *                nothing left to protect.
 *
 * AND `null`, WHICH IS NOT A FIFTH OUTCOME BUT THE ABSENCE OF ONE. `relinquished` is already inside
 * the retirement tail: the membership is gone and the only work left is a stop that is idempotent and
 * observable. There is no terminal edge out of it — `relinquished -> stranded` is not a legal walk —
 * so a failure there is replayed rather than settled, and the caller parks instead of terminalising.
 *
 * `refused` versus `abandoned` is decided by the OBSERVED record plus the phase trace, never by
 * `replacementSessionId` alone — that field is the write-ahead intent, so reading it as proof of a
 * session would report a cancellation at `replacement_creating` as the abandonment of something that
 * was never made, and would call `stop` on an id no record answers to. The observation must also be a
 * FRESH one: a create that succeeded between an earlier snapshot and the failure would otherwise be
 * terminalised as `refused`, orphaning a session nothing then stops.
 */
export function handoverSettlement(
  receipt: HandoverReceipt,
  world: HandoverWorld,
  failure: HandoverFailure,
  reason: string,
): HandoverSettlement | null {
  // INSIDE THE RETIREMENT TAIL THERE IS NOTHING TO SETTLE TO, and the tail has two entrances rather
  // than one. `relinquished` is the phase; `retiring` is the durable intent that says the gate cleared
  // and the stop or the relinquish it authorized may already have been applied — on EITHER track.
  //
  // Terminalising from here would be a false record twice over. It would clear the very intent that
  // proves the retirement began, and it would claim a failure for a step whose whole recovery is to
  // replay: the stop is idempotent, the relinquish is observable in the board's own roster, and the
  // source's state is the evidence. So a named error in the tail records itself and the pass parks —
  // which is what the caller does with `null`.
  //
  // AN ACTIVE EFFECT INTENT IS ALWAYS REPLAY, NEVER SETTLEMENT — both of them, not just `retiring`.
  // `accepting` names a window in which the board may already hold the grant while the receipt still
  // reads `approved`: the recovery is to replay the accept under its derived id, and settling instead
  // would both abandon a replacement the board has admitted and clear the intent on its own phase,
  // which the durable schema refuses outright.
  if (receipt.phase === 'relinquished' || receipt.effectIntent !== undefined || handoverIsRetiring(receipt)) {
    return null;
  }
  if (receiptIsIrreversible(receipt)) {
    // The only irreversible phase a BOARDLESS handover reaches is the one after its own stop, so the
    // board test below is what separates "two roots on a board" from "the predecessor is gone".
    if (receipt.board === null || receipt.phase === 'predecessor_stopped') {
      return { kind: 'fail', failure, reason };
    }
    return { kind: 'strand', failure, reason };
  }
  if (receipt.replacementSessionId === undefined) return { kind: 'refuse', failure, reason };
  const created = receipt.phaseHistory.some(entry => entry.phase === 'replacement_created');
  if (world.replacement === null && !created) return { kind: 'refuse', failure, reason };
  return { kind: 'abandon', failure, reason };
}

/**
 * The last step, and the one place a receipt may end at `failed`.
 *
 * The predecessor is already stopped, so there is nothing left to protect and nothing to retry
 * against: a receipt that reaches here without the replacement identity it has carried since
 * `replacement_creating` describes a state its own schema forbids, and journalling a completion that
 * names no replacement would write a lie into two sessions' histories. Every other error at this
 * phase is a transient one the reconciler replays, because `appendOnce` makes the retry free.
 */
function completion(receipt: HandoverReceipt): HandoverPlan {
  if (receipt.replacementSessionId !== undefined) return { kind: 'step', step: 'complete' };
  return {
    kind: 'fail',
    failure: 'step_failed',
    reason:
      `the predecessor was stopped but the receipt names no replacement, so there is no completion to ` +
      'journal; the handover is recorded as failed rather than completed against a session that does not exist',
  };
}

/**
 * THE PREDECESSOR SURVIVING IS AN INVARIANT UNTIL THE RETIREMENT IS COMMITTED, not a detail.
 *
 * Every forward effect this machine performs is done ON BEHALF of a session it believes is running: it
 * invites a replacement onto that session's board, seats a coordinator over that session's membership,
 * and finally retires it. A predecessor that has died OUTSIDE the recorded retirement tail is external
 * loss, and it is not evidence that any of that may continue — a handover that kept walking would seat
 * a replacement over the membership of a session nobody can hand anything over from.
 *
 * So this blocks, fail-closed, and it blocks EVERYTHING: no invite, no accept, no launch, no stop. It
 * is checked ahead of the board invariant and ahead of any settlement, because the source's state is
 * the fact that decides whether the other two questions are even worth asking.
 *
 * TWO CASES ARE EXEMPT AND BOTH ARE THE SAME FACT. From `relinquished` onward, and at `draining` once
 * `retiring` is durable, a terminal or absent source is the EXPECTED replay proof of a committed stop
 * rather than a loss — which is exactly the distinction the structured intent exists to draw.
 *
 * IT SETTLES TO `failed` UNDER `source_lost`, which is the ONE cause allowed to reach `failed` before
 * the predecessor was stopped. The other three terminals would each make a false promise about a
 * session that is already gone: `refused` claims nothing was created, `abandoned` claims a tidy
 * undo, and `stranded` claims a predecessor still running and still a member. Only `failed` says what
 * happened, and only `source_lost` says why.
 */
function sourceLoss(receipt: HandoverReceipt, world: HandoverWorld): HandoverPlan | null {
  if (receipt.phase === 'relinquished' || receipt.phase === 'predecessor_stopped') return null;
  if (handoverIsRetiring(receipt)) return null;
  if (world.source !== null && !isTerminalStatus(world.source.status)) return null;
  const state = world.source === null ? 'gone' : world.source.status;
  return {
    kind: 'fail',
    failure: 'source_lost',
    reason:
      `the predecessor ${receipt.sourceSessionId} is ${state} outside this handover's own retirement, so ` +
      'every forward effect is blocked: a replacement must not be seated over the membership of a ' +
      'session nobody can hand anything over from',
  };
}

/**
 * What to do at `draining`, which is two different situations wearing one phase name.
 *
 * ORDINARILY it is a wait: run the binding gate, and retire the predecessor the moment it clears.
 *
 * BUT ONCE THE RETIREMENT HAS BEGUN AND THE SOURCE IS ALREADY GONE, the gate is the wrong question
 * and asking it again is worse than useless. The gate inspects a live pane's in-flight work; against
 * a session that has already stopped it can only refuse for want of evidence or fail outright, and
 * either answer would park this handover at `draining` for ever — with the predecessor stopped, the
 * board possibly already relinquished, and nothing left that would ever move it on. A stopped source
 * IS the durable proof the gate was going to be asked to authorize, so the receipt records the tail
 * it already has rather than re-deriving permission for something that has happened.
 *
 * The marker is required, not just the terminal source: a source that died while the gate was still
 * refusing was killed by something else, and that is a board-moved-underneath-us situation the
 * invariant check above answers, not a retirement this handover may claim.
 */
function draining(receipt: HandoverReceipt): HandoverPlan {
  // THE INTENT ALONE DECIDES, not the intent plus a dead source. The gate was already cleared before
  // `retiring` was persisted, so asking it again is asking a question that has been answered — and on a
  // still-live predecessor it can answer differently the second time and park a retirement that has
  // already begun. Once the intent is durable the only work left is the committed tail.
  if (handoverIsRetiring(receipt)) return { kind: 'step', step: 'retire_without_gate' };
  return { kind: 'step', step: 'drain' };
}

/**
 * The conjuncts that together mean "the replacement accepted AND can act".
 *
 * The liveness check runs FIRST and deliberately: a verification receipt from a session that has
 * since died proves the capability arrived, not that anybody is there to use it, and reading the
 * receipt before the liveness would let a dead replacement retire a live predecessor.
 */
function verification(receipt: HandoverReceipt, world: HandoverWorld): HandoverPlan {
  const replacement = world.replacement;
  const named = receipt.replacementSessionId ?? 'unknown';
  if (replacement === null || isTerminalStatus(replacement.status)) {
    return {
      kind: 'strand',
      failure: 'replacement_terminal',
      reason:
        `replacement ${named} is no longer live, so nothing it may have written proves that anybody is there ` +
        'to use the membership it was granted',
    };
  }
  // FOUR CONJUNCTS, not one. The receipt has to be the one THIS handover created, about the session
  // THIS handover created, verified BY that session. Reading only `verifiedAt` would let a receipt
  // belonging to another invitation on the same board retire this predecessor.
  const invitation = world.board?.invitation ?? null;
  const verified =
    invitation !== null &&
    invitation.requestId === receipt.board?.invitationRequestId &&
    invitation.targetSessionId === receipt.replacementSessionId &&
    invitation.verifiedAt !== undefined &&
    invitation.verifiedBySessionId === receipt.replacementSessionId;
  if (verified) return { kind: 'step', step: 'record_verified' };
  if (isVerificationOverdue(receipt, world)) {
    return {
      kind: 'strand',
      failure: 'verification_timeout',
      reason:
        `replacement ${named} did not verify its membership within ${world.verificationDeadlineMinutes} ` +
        'minutes; the predecessor keeps running and keeps its membership, and nothing has been destroyed',
    };
  }
  return { kind: 'wait', reason: 'waiting for the replacement to verify the membership it was granted' };
}

/**
 * The board must still be the board this handover started against.
 *
 * TWO CONJUNCTS. The four-field ANCHOR the receipt captured at begin — board id, creator, canonical
 * session and creation instant — still describes the board that answers to that id; and the source is
 * still one of its active roots, which is the membership the whole operation exists to replace.
 *
 * THE ANCHOR IS COMPARED WITH ITSELF, NOT WITH THE SOURCE. `canonicalSessionId` records the session
 * that CREATED the board and is never restamped, so on the second handover of one board it names
 * neither the retiring root nor the arriving one; an equality against the source would fail on
 * exactly the case this feature creates. Comparing it against what begin recorded asks the question
 * that is actually worth asking — did the document move underneath us — and it is sound at every
 * handover, first or fifth.
 *
 * The anchor is checked until the predecessor is stopped. The ACTIVE-ROOT conjunct stops earlier, at
 * `draining`: the relinquish lives inside that step, so from there the source's absence from the roots
 * is the operation working rather than the board moving.
 */
function boardInvariantBreach(receipt: HandoverReceipt, world: HandoverWorld): HandoverPlan | null {
  const pinned = receipt.board;
  if (pinned === null) return null;
  if (receipt.phase === 'predecessor_stopped') return null;
  // ONCE THE RETIREMENT IS COMMITTED THE BOARD IS NO LONGER THIS HANDOVER'S QUESTION. The relinquish
  // may already have been applied, so the board is EXPECTED to have changed underneath — complaining
  // about it would be describing the operation succeeding. Worse, the complaint could only settle:
  // `stranded` is what an irreversible breach maps to, and a committed retiring tail may never strand,
  // so the receipt it produced would be one no reader can parse. The tail replays instead.
  if (handoverIsRetiring(receipt)) return null;
  const observed = world.board;
  if (observed === null) {
    return breach(
      receipt,
      world,
      `no board answers to ${pinned.boardId} any more; a board id is minted once and never reused, so the ` +
        'board this handover started against is not the board underneath it now',
    );
  }
  const drifted =
    observed.boardId !== pinned.boardId ||
    observed.creatorSessionId !== pinned.creatorSessionId ||
    observed.canonicalSessionId !== pinned.canonicalSessionId ||
    observed.createdAt !== pinned.createdAt;
  if (drifted) {
    return breach(
      receipt,
      world,
      `board ${pinned.boardId} no longer matches the anchor this handover captured ` +
        `(created by ${pinned.creatorSessionId}, canonical ${pinned.canonicalSessionId}, at ${pinned.createdAt}); ` +
        `it now reports creator ${observed.creatorSessionId}, canonical ${observed.canonicalSessionId}, at ` +
        `${observed.createdAt}`,
    );
  }
  // THE ACTIVE-ROOT CONJUNCT STOPS AT THE RETIREMENT MARKER, not at the phase. A handover parked at
  // `draining` waiting for the predecessor's in-flight work to finish is still a handover whose root
  // must be on the board; only once the gate has cleared and the retirement has durably begun is the
  // source's absence this operation's own doing rather than the board moving underneath it. Without
  // the marker, a crash between the relinquish and the phase write would strand a handover whose only
  // remaining work is stopping a predecessor that has already given up its membership.
  if (receipt.phase === 'relinquished' || handoverIsRetiring(receipt)) return null;
  if (observed.activeRootSessionIds.includes(receipt.sourceSessionId)) return null;
  return breach(
    receipt,
    world,
    `board ${pinned.boardId} no longer counts ${receipt.sourceSessionId} among its active roots, so the ` +
      'membership this handover is replacing is already gone',
  );
}

/** A board breach unwinds like any other stop, and the point of no return decides how far back it can go. */
function breach(receipt: HandoverReceipt, world: HandoverWorld, reason: string): HandoverPlan {
  // `relinquished` never reaches here — the invariant check stops before it — so the tail case cannot
  // arise, and falling back to the stop would be describing a state this function is never in.
  return handoverSettlement(receipt, world, 'board_moved', reason) ?? { kind: 'step', step: 'stop_predecessor' };
}

/** Whether the wait for verification has run past its deadline. */
function isVerificationOverdue(receipt: HandoverReceipt, world: HandoverWorld): boolean {
  // The FIRST entry for this phase, never the last. A parked pass appends a detail entry at the same
  // phase, so reading the latest one would restart the deadline every time the wait reported on
  // itself — and a handover that keeps saying "still waiting" would wait forever.
  const entry = receipt.phaseHistory.find(candidate => candidate.phase === receipt.phase);
  const since = Date.parse(entry?.at ?? receipt.updatedAt);
  const now = Date.parse(world.now);
  // An unreadable timestamp is not evidence that a deadline passed. The receipt is written by this
  // daemon's own clock, so the only way here is a document somebody edited — and stranding a live
  // handover over a typo would destroy more than it reports.
  if (!Number.isFinite(since) || !Number.isFinite(now)) return false;
  return now - since >= world.verificationDeadlineMinutes * 60_000;
}
