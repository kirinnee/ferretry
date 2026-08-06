/**
 * The handover state machine: the one place a durable receipt turns into effects.
 *
 * THE SHAPE IS "WRITE THE INTENTION, THEN DO THE THING". Every phase is written before the effect it
 * authorizes and re-stamped after, so a daemon that dies mid-handover restarts holding a document
 * that names exactly what it was about to do. Nothing here performs a step on an unrecorded
 * intention, and nothing invents a fresh id per attempt: every board write carries an id derived from
 * the receipt, so re-driving a step after a crash is a replay the board's own ledger answers.
 *
 * THE ORCHESTRATOR CANNOT PRODUCE THE PROOF, AND THAT IS THE POINT. It drives up to the launch and
 * then WAITS for an inbound `invitation.verify` made by the replacement's own pane with the
 * capability delivered into its environment. `HandoverBoardPort` has no `verify` for that reason, and
 * this class holds no other way to reach one.
 *
 * SERIALIZED PER PREDECESSOR. A begin, a cancel and a reconciler tick all mutate one document, and
 * two overlapping runs would each read it before the other wrote. The chain here makes every call for
 * one source wait for the previous one, and it survives a FAILED call — chaining only on success
 * would wedge that session's handover permanently the first time anything threw.
 */

import type { SessionTransferPlan } from '@ferretry/protocol';
import { isTerminalStatus } from '../warden/types.ts';
import {
  derivedStepId,
  handoverEligibility,
  handoverSettlement,
  handoverFingerprint,
  handoverPlanId,
  type HandoverPlan,
  type HandoverStep,
  type HandoverWorld,
  isTerminalHandoverPhase,
  nextPhase,
  receiptIsIrreversible,
} from './policy.ts';
import type { SessionHandoverEffectIntent as HandoverEffectIntent } from '@ferretry/protocol';
import {
  DEFAULT_HANDOVER_SETTINGS,
  type HandoverFailure,
  type HandoverPhase,
  type HandoverPorts,
  type HandoverReceipt,
  type HandoverRequestBody,
  type HandoverResolvedTarget,
  type HandoverSettings,
  HandoverError,
} from './types.ts';

/** The event both journals record, so one word describes one thing on both sides. */
const HANDOVER_COMPLETED_EVENT = 'session.handover_completed';

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What a human can actually do about a handover whose subject died underneath it.
 *
 * It never says "still running and still a member", because that is the one thing that is not true
 * here: the predecessor is gone. Past acceptance the replacement is also unrevokeable, so the honest
 * advice is about the board it now sits on rather than about a choice between two live sessions.
 */
function sourceLostRemedy(receipt: HandoverReceipt): string {
  const replacement = receipt.replacementSessionId ?? 'the replacement';
  return (
    `${receipt.sourceSessionId} stopped outside this handover, so there is no predecessor left to hand ` +
    `anything over from and the handover is recorded as failed. ${replacement} was already accepted onto ` +
    `board ${receipt.board?.boardId ?? 'none'} and nothing in this daemon revokes a grant, so it is still ` +
    `there: decide whether to let it take over — start it and have it run \`fy task-board invite-verify\` ` +
    `— or to stop it and re-seat the board yourself.`
  );
}

export class SessionHandoverService {
  /** One settled promise chain per source session id, deleted when its queue drains. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly ports: HandoverPorts,
    private readonly settings: HandoverSettings = DEFAULT_HANDOVER_SETTINGS,
  ) {}

  /** The durable receipt at whatever phase it has reached, terminal included. */
  async receipt(sourceSessionId: string): Promise<HandoverReceipt> {
    const receipt = await this.ports.receipts.read(sourceSessionId);
    if (receipt !== null) return receipt;
    throw new HandoverError(
      'source_not_found',
      `session ${sourceSessionId} has no handover receipt: nothing has been handed over, and an empty ` +
        'answer would be indistinguishable from one that had',
    );
  }

  /**
   * Accepts a handover, or refuses it before anything exists.
   *
   * It writes the receipt at `requested` and returns; the reconciler drives from there. That split is
   * deliberate — a caller must not have to hold a connection open across a create, four board writes,
   * a launch and a stop, and a handover must survive the caller hanging up.
   *
   * `wardenId` is the authority a warden presented for this action. Its only effect is that a
   * warden-driven handover of a BOARD root is refused: widening board membership needs the explicit
   * invitation authority a per-assignment warden capability does not carry.
   */
  async begin(
    sourceSessionId: string,
    request: HandoverRequestBody,
    requestId: string,
    wardenId?: string,
  ): Promise<HandoverReceipt> {
    return await this.serialize(sourceSessionId, async () => {
      const id = requestId.trim();
      if (id === '') {
        throw new HandoverError(
          'request_conflict',
          'a handover request id must not be blank: a request that cannot be recognised on its second ' +
            'arrival cannot be protected from creating a second replacement',
        );
      }
      const fingerprint = handoverFingerprint(request);
      const existing = await this.ports.receipts.read(sourceSessionId);
      const replay = this.replayDecision(existing, id, fingerprint);
      if (replay !== null) return replay;
      return await this.accept(sourceSessionId, request, id, fingerprint, wardenId, existing);
    });
  }

  /**
   * Stops a handover that has not passed its point of no return.
   *
   * The cancellation INTENT is written before anything is cleaned up. Without that, a cancel that
   * stopped the replacement and then died would restart into the ordinary forward ladder and resume
   * the very handover an operator had just stopped — the replacement gone, the receipt still walking
   * towards retiring a predecessor on its behalf.
   *
   * A repeated cancel is idempotent by OUTCOME rather than by its own id: once the receipt is
   * terminal there is nothing left to do, so every later cancel — the retry of this one or a fresh
   * one — reads the terminal receipt and performs nothing. The cancel's request id is recorded in the
   * phase history so the record names which call stopped it.
   */
  async cancel(sourceSessionId: string, requestId: string): Promise<HandoverReceipt> {
    return await this.serialize(sourceSessionId, async () => {
      const receipt = await this.receipt(sourceSessionId);
      if (isTerminalHandoverPhase(receipt.phase)) return receipt;
      // A CANCELLATION ALREADY UNDER WAY IS NOT RE-OPENED. The intent is durable and names the call
      // that wrote it, so the retry of that call resumes it and a DIFFERENT one must not overwrite the
      // record of who stopped this handover — a second id replacing the first would make the receipt
      // attribute an operator's decision to whoever asked last.
      // KEYED ON THE RECORDED ID, NOT ON THE REFUSAL CAUSE. Source loss can supersede a cancellation
      // mid-flight, leaving a nonterminal receipt whose refusal reads `source_lost` while
      // `cancelRequestId` — immutable provenance — still names C1. Reading the cause here would drop
      // both callers through to the checks below, so C1 would lose its resume and C2 its conflict for
      // exactly the operation that most needs one identity.
      if (receipt.cancelRequestId !== undefined) {
        if (receipt.cancelRequestId === requestId) return await this.drive(receipt);
        throw new HandoverError(
          'request_conflict',
          `this handover is already being cancelled under request id ${receipt.cancelRequestId ?? 'an earlier call'}; ` +
            'present that id to follow it rather than starting a second cancellation of one operation',
        );
      }
      // A DEAD PREDECESSOR IS CLASSIFIED, NOT REFUSED. Source loss outranks cancellation everywhere
      // else, and this was the one door where it did not: throwing here answered a caller 409 about a
      // handover whose subject had already gone, and left nothing durable saying so until some later
      // reconcile tick noticed. Driving instead lets `nextPhase` reach the same conclusion it would
      // have reached anyway — `failed`/`source_lost`, or the committed retirement tail if the stop was
      // this handover's own — and the caller is answered with the receipt rather than an error about
      // the wrong thing. No cancellation intent is written, because none of this was a cancellation.
      const source = await this.ports.sessions.read(sourceSessionId);
      if (source === null || isTerminalStatus(source.status)) return await this.drive(receipt);
      if (receipt.effectIntent !== undefined) {
        throw new HandoverError(
          'cancelled',
          `this handover cannot be cancelled: it is mid-${receipt.effectIntent} and the side effect that ` +
            'names may already have committed, so there is nothing a cancellation could take back',
        );
      }
      if (receiptIsIrreversible(receipt)) {
        throw new HandoverError(
          'cancelled',
          `this handover cannot be cancelled: it passed the point of no return at ${receipt.phase}. The board ` +
            'carries two active roots and no reducer in this daemon revokes a grant, so there is nothing to ' +
            'undo — the honest moves are to let it finish or to resolve it forward by hand',
        );
      }
      const at = this.ports.clock.now();
      const message =
        `cancelled by an operator under request id ${requestId}; the replacement is stopped and any ` +
        'invitation is left to expire on its own, because nothing in this daemon revokes one';
      const withIntent = this.stamp({ ...receipt, cancelRequestId: requestId }, receipt.phase, at, {
        detail: `cancellation requested under ${requestId}`,
        refusal: { failure: 'cancelled', message },
      });
      await this.ports.receipts.write(withIntent);
      return await this.drive(withIntent);
    });
  }

  /**
   * Drives one handover as far as it can go right now.
   *
   * `null` when the session has no receipt at all, which is how the reconciler tolerates a roster
   * that named a session whose document has since been removed.
   */
  async advance(sourceSessionId: string): Promise<HandoverReceipt | null> {
    return await this.serialize(sourceSessionId, async () => {
      const receipt = await this.ports.receipts.read(sourceSessionId);
      if (receipt === null) return null;
      return await this.drive(receipt);
    });
  }

  /**
   * The advance loop.
   *
   * Unbounded on purpose, and safe because the phase graph is a ladder: every plan this applies moves
   * the receipt strictly forward or to a terminal phase, and a plan that cannot move it — a wait, a
   * refused preflight, a step that threw — returns `null` and ends the pass. A cycle is therefore
   * impossible unless somebody adds a backwards edge, which the ladder-monotonicity test refuses.
   *
   * It exists rather than one-step-per-tick because adjacency matters: the binding preflight's answer
   * is only true at the instant it is read, so the relinquish and the stop it authorizes must follow
   * it in the same pass rather than on a later one.
   */
  private async drive(start: HandoverReceipt): Promise<HandoverReceipt> {
    let receipt = start;
    for (;;) {
      const world = await this.observe(receipt);
      const advanced = await this.apply(receipt, nextPhase(receipt, world), world);
      if (advanced === null) return await this.settled(receipt);
      receipt = advanced;
    }
  }

  /**
   * What the pass ANSWERS WITH when it stops without advancing the phase.
   *
   * `null` from `apply` means "no further progress", NOT "nothing was written". Several of those paths
   * write first and stop second: a gate refusal records a changed reason, a transient step error
   * records why, a named error records its settlement intent, and a failed Attention records that the
   * ledger could not be reached. Returning the receipt this pass STARTED with would hand a caller a
   * document that disagrees with the one on disk — worst case the durable refusal already reads
   * `source_lost` while the answer still says `cancelled`. Both the route and this method promise the
   * CURRENT durable receipt, so it is re-read.
   *
   * A damaged document is deliberately NOT caught here. If the store cannot read what it just wrote,
   * that is the one thing a caller must be told rather than served a plausible older copy of. A
   * genuinely absent one — removed underneath us — falls back to what this pass held, which is the
   * only honest answer left.
   */
  private async settled(receipt: HandoverReceipt): Promise<HandoverReceipt> {
    return (await this.ports.receipts.read(receipt.sourceSessionId)) ?? receipt;
  }

  private async apply(
    receipt: HandoverReceipt,
    plan: HandoverPlan,
    world: HandoverWorld,
  ): Promise<HandoverReceipt | null> {
    switch (plan.kind) {
      case 'settled':
        return null;
      case 'wait':
        return null;
      case 'refuse':
        return await this.settle(receipt, 'refused', plan.failure, plan.reason);
      case 'abandon':
        return await this.abandon(receipt, plan.failure, plan.reason);
      case 'strand':
        return await this.strand(receipt, plan.failure, plan.reason);
      case 'fail':
        return plan.failure === 'source_lost'
          ? await this.failSourceLost(receipt, plan.reason)
          : await this.settle(receipt, 'failed', plan.failure, plan.reason);
      default:
        return await this.attempt(receipt, plan.step, world);
    }
  }

  /**
   * Runs one step, and decides what an error from it MEANS.
   *
   * A {@link HandoverError} is a named, non-retryable condition the step established — a plan that
   * drifted, a source that is gone — so it settles the receipt in the direction the point of no
   * return allows. Anything else is treated as transient: the reason is recorded on the receipt and
   * the pass ends, so the next tick replays the same step under the same derived ids. Elapsed time is
   * never evidence that a deterministic effect failed, so nothing here converts a slow step into a
   * terminal one.
   */
  private async attempt(
    receipt: HandoverReceipt,
    step: HandoverStep,
    world: HandoverWorld,
  ): Promise<HandoverReceipt | null> {
    try {
      return await this.step(receipt, step, world);
    } catch (error) {
      // THE DURABLE RECEIPT, NOT THE ONE THIS PASS STARTED WITH. A step may have written before it
      // failed — `accept` persists its `accepting` intent ahead of the board call, and the board may
      // then commit while delivery throws — so continuing with the stale in-memory copy would classify
      // an already-accepted handover as reversible and abandon a replacement the board has admitted.
      // Re-reading is what makes the error path see everything the step made durable.
      const durable = (await this.ports.receipts.read(receipt.sourceSessionId)) ?? receipt;
      if (error instanceof HandoverError) return await this.settleNamed(durable, error);
      // A TRANSIENT ERROR KEEPS THE EFFECT INTENT. The window it names is still open — the board may
      // have committed while delivery failed — so the retry must resume inside it rather than start the
      // step over as though nothing had happened.
      await this.ports.receipts.write(
        this.stamp(durable, durable.phase, this.ports.clock.now(), {
          detail: `${step} did not complete: ${detail(error)}`,
        }),
      );
      return null;
    }
  }

  /**
   * Where a NAMED step error lands, which is not one answer but three.
   *
   * `stranded` says "irreversible, nothing destroyed, a human decides" and it is board-only by
   * definition: a boardless handover has no second root to leave behind, so the only irreversible
   * thing it can have done is stop the predecessor — and past that the honest word is `failed`.
   * Before the point of no return the receipt unwinds like any other cleanup.
   */
  private async settleNamed(receipt: HandoverReceipt, error: HandoverError): Promise<HandoverReceipt | null> {
    // RE-OBSERVED, not decided from the snapshot this pass began with. A create that succeeded between
    // that read and this failure would otherwise be settled as `refused` — a terminal claim that
    // nothing was made — and the session it did make would be left running with nothing to stop it.
    const now = await this.observe(receipt);
    const settlement = handoverSettlement(receipt, now, error.failure, error.message);
    if (settlement === null) {
      await this.ports.receipts.write(
        this.stamp(receipt, receipt.phase, this.ports.clock.now(), {
          detail: `${error.failure}: ${error.message}`,
        }),
      );
      return null;
    }
    return await this.apply(receipt, settlement, now);
  }

  private async step(
    receipt: HandoverReceipt,
    step: HandoverStep,
    world: HandoverWorld,
  ): Promise<HandoverReceipt | null> {
    switch (step) {
      case 'claim_replacement_identity':
        return await this.claimReplacementIdentity(receipt);
      case 'create_replacement':
        return await this.createReplacement(receipt);
      case 'invite':
        return await this.invite(receipt);
      case 'approve':
        return await this.approve(receipt);
      case 'accept':
        return await this.accept_(receipt);
      case 'start_replacement':
        return await this.startReplacement(receipt);
      case 'record_verified':
        return await this.advanceTo(receipt, 'verified', 'the replacement verified the membership it was granted');
      case 'claim_coordinator_identity':
        return await this.claimCoordinatorIdentity(receipt);
      case 'create_coordinator':
        return await this.createCoordinator(receipt);
      case 'grant_coordinator':
        return await this.grantCoordinator(receipt);
      case 'start_coordinator':
        return await this.startCoordinator(receipt);
      case 'replace_coordinator':
        return await this.replaceCoordinator(receipt);
      case 'enter_draining':
        return await this.advanceTo(receipt, 'draining', 'waiting for the predecessor to be safe to stop');
      case 'drain':
        return await this.drain(receipt);
      case 'retire_without_gate':
        return await this.retireWithoutGate(receipt);
      case 'stop_predecessor':
        return await this.stopPredecessor(receipt, world);
      default:
        return await this.complete(receipt);
    }
  }

  // ─── the ladder ───────────────────────────────────────────────────────────────────────────────

  /**
   * Writes the replacement's id BEFORE the session exists.
   *
   * This is what makes the create idempotent. A create under a freshly minted id would produce a
   * second session on every retry and leave the first orphaned with no document naming it; a create
   * under an id the receipt already carries is a replay.
   */
  private async claimReplacementIdentity(receipt: HandoverReceipt): Promise<HandoverReceipt> {
    const next = { ...receipt, replacementSessionId: this.ports.identity.sessionId() };
    return await this.write(next, 'replacement_creating', 'the replacement identity is claimed');
  }

  /**
   * Freezes the transfer plan, creates the record, then imports into it.
   *
   * THE FREEZE COMES FIRST, before the create, and that ordering is the whole of the durability
   * argument: `planId` hashes the source and the request id, not the plan's CONTENT, so a crash
   * answered by preparing again would import a different decision under the same id. Loading the
   * frozen document instead means every attempt applies the same plan, and a document whose id does
   * not match the receipt's is a refusal rather than a silently different session.
   */
  private async createReplacement(receipt: HandoverReceipt): Promise<HandoverReceipt> {
    const replacementId = this.requireReplacementId(receipt);
    const plan = receipt.plan;
    // EVERY DURABLE FACT COMES FROM THE FROZEN PLAN, not from the source as it is right now. The
    // source has been running since the plan was cut, and a create that read it again could give the
    // replacement a working directory, a mode or a label the plan does not describe — an interactive
    // replacement for an auto source, say, or a session in a directory the operator has since moved.
    await this.ports.sessions.create({
      sessionId: replacementId,
      account: receipt.resolvedTarget.replacement,
      parentSessionId: null,
      cwd: plan.durable.cwd,
      mode: plan.durable.mode,
      label: plan.durable.label,
    });
    await this.ports.importer.importPlan(plan, replacementId);
    return await this.write(receipt, 'replacement_created', `the replacement was created as ${replacementId}`);
  }

  private assertPlanId(expected: string, plan: SessionTransferPlan): SessionTransferPlan {
    if (plan.planId === expected) return plan;
    throw new HandoverError(
      'plan_drifted',
      `this handover recorded plan ${expected} and the transfer seam answered with ${plan.planId}; a handover ` +
        'imports the decision it wrote down, not a different one that happens to be available',
    );
  }

  private async invite(receipt: HandoverReceipt): Promise<HandoverReceipt> {
    const board = this.requireBoard(receipt);
    const replacementId = this.requireReplacementId(receipt);
    const { invitationRequestId } = await this.ports.board.requestInvitation({
      boardId: board.boardId,
      sourceSessionId: receipt.sourceSessionId,
      targetSessionId: replacementId,
      requestId: derivedStepId(receipt, 'handover.invite'),
    });
    const next = { ...receipt, board: { ...board, invitationRequestId } };
    return await this.write(next, 'invited', `the replacement was invited onto board ${board.boardId}`);
  }

  private async approve(receipt: HandoverReceipt): Promise<HandoverReceipt> {
    const board = this.requireBoard(receipt);
    await this.ports.board.approveInvitation({
      boardId: board.boardId,
      invitationRequestId: this.requireInvitation(receipt),
      targetSessionId: this.requireReplacementId(receipt),
      requestId: derivedStepId(receipt, 'handover.approve'),
    });
    return await this.write(receipt, 'approved', 'the coordinator approved the invitation');
  }

  /**
   * The point of no return.
   *
   * Acceptance writes the grant and delivers the board capability into the replacement's
   * `environment.json` — which is why it happens BEFORE the launch: a pane reads its environment once,
   * at launch, so a capability delivered afterwards would land in a file the replacement has already
   * read past and it could never verify on its first incarnation.
   *
   * The trailing underscore keeps this off the public `accept` name the begin path owns.
   */
  private async accept_(receipt: HandoverReceipt): Promise<HandoverReceipt> {
    const board = this.requireBoard(receipt);
    // THE INTENT IS DURABLE BEFORE THE CALL. The reducer may commit the grant and the two-root state
    // while the delivery or this receipt's own write fails, and a receipt still reading `approved` with
    // nothing else recorded would let a cancellation try to stop a replacement the board has already
    // admitted. Written here, that window is classified as irreversible from the first instant.
    const accepting = this.stamp(receipt, receipt.phase, this.ports.clock.now(), {
      detail: 'accepting the invitation',
      effectIntent: 'accepting',
    });
    await this.ports.receipts.write(accepting);
    const { grantId } = await this.ports.board.acceptInvitation({
      boardId: board.boardId,
      invitationRequestId: this.requireInvitation(receipt),
      targetSessionId: this.requireReplacementId(receipt),
      requestId: derivedStepId(receipt, 'handover.accept'),
    });
    const next = { ...accepting, board: { ...board, grantId } };
    return await this.write(next, 'accepted', `the replacement holds grant ${grantId}; this is the point of no return`);
  }

  private async startReplacement(receipt: HandoverReceipt): Promise<HandoverReceipt> {
    const replacementId = this.requireReplacementId(receipt);
    await this.ports.sessions.start(replacementId);
    return await this.write(receipt, 'replacement_started', `the replacement ${replacementId} is running`);
  }

  private async claimCoordinatorIdentity(receipt: HandoverReceipt): Promise<HandoverReceipt> {
    const next = { ...receipt, coordinatorSessionId: this.ports.identity.sessionId() };
    return await this.write(next, 'coordinator_creating', 'the coordinator identity is claimed');
  }

  /**
   * Creates the coordinator descendant WITHOUT starting it.
   *
   * The board capability reaches a session through its environment and a pane reads that once, so the
   * grant has to be written before the launch. A coordinator started here would come up holding
   * nothing and would have to be relaunched to coordinate anything.
   */
  private async createCoordinator(receipt: HandoverReceipt): Promise<HandoverReceipt> {
    const coordinatorId = this.requireCoordinatorId(receipt);
    const plan = receipt.plan;
    const account = receipt.resolvedTarget.coordinator;
    if (account === null) {
      throw new HandoverError(
        'coordinator_required',
        `this handover reached the coordinator leg with no coordinator account recorded for board ` +
          `${this.requireBoard(receipt).boardId}; a board root's replacement must seat one`,
      );
    }
    await this.ports.sessions.create({
      sessionId: coordinatorId,
      account,
      parentSessionId: this.requireReplacementId(receipt),
      cwd: plan.durable.cwd,
      mode: plan.durable.mode,
      label: plan.durable.label,
    });
    return await this.write(receipt, 'coordinator_created', `the coordinator was created as ${coordinatorId}`);
  }

  private async grantCoordinator(receipt: HandoverReceipt): Promise<HandoverReceipt> {
    const board = this.requireBoard(receipt);
    const { grantRequestId } = await this.ports.board.requestChildGrant({
      boardId: board.boardId,
      rootSessionId: this.requireReplacementId(receipt),
      targetSessionId: this.requireCoordinatorId(receipt),
      requestId: derivedStepId(receipt, 'handover.child-grant.request'),
    });
    const { grantId } = await this.ports.board.approveChildGrant({
      boardId: board.boardId,
      grantRequestId,
      requestId: derivedStepId(receipt, 'handover.child-grant.approve'),
    });
    return await this.write(receipt, 'coordinator_granted', `the coordinator holds grant ${grantId}`);
  }

  /**
   * Starts the coordinator, PROVES it, then seats it.
   *
   * Two conjuncts before the board is touched, and both exist because `coordinator.replace` accepts
   * any live root's descendant:
   *
   *  - the coordinator is live, because a seat handed to a session that never came up leaves the
   *    board unable to approve anything the moment the predecessor relinquishes;
   *  - its parent is THIS handover's replacement root, because a coordinator whose lineage runs
   *    through the OLD root would be revoked by the very relinquish that follows — the board would
   *    lose its coordinator in the same write that was supposed to give it a new one.
   */
  /**
   * Starts the coordinator and PROVES it, as a durable boundary of its own.
   *
   * Its board capability was written into its environment by the grant one phase back, and a pane
   * reads its environment at launch — so the start has to come after the grant and the seat has to
   * come after the start. Recording the launch as its own phase is what makes the seat a separate,
   * replayable step rather than something hidden inside another one.
   */
  private async startCoordinator(receipt: HandoverReceipt): Promise<HandoverReceipt> {
    const coordinatorId = this.requireCoordinatorId(receipt);
    await this.ports.sessions.start(coordinatorId);
    return await this.write(receipt, 'coordinator_started', `the coordinator ${coordinatorId} is running`);
  }

  private async replaceCoordinator(receipt: HandoverReceipt): Promise<HandoverReceipt> {
    const board = this.requireBoard(receipt);
    const coordinatorId = this.requireCoordinatorId(receipt);
    const replacementId = this.requireReplacementId(receipt);
    const coordinator = await this.ports.sessions.read(coordinatorId);
    if (coordinator === null || isTerminalStatus(coordinator.status)) {
      throw new HandoverError(
        'step_failed',
        `coordinator ${coordinatorId} is not live, so seating it would leave board ${board.boardId} unable to ` +
          'approve anything as soon as the predecessor relinquishes',
      );
    }
    if (coordinator.parentSessionId !== replacementId) {
      throw new HandoverError(
        'step_failed',
        `coordinator ${coordinatorId} descends from ${coordinator.parentSessionId ?? 'no root'} rather than from ` +
          `the replacement ${replacementId}; relinquishing the predecessor revokes every grant beneath it, so ` +
          'seating a coordinator from the retiring tree would revoke the seat in the same write',
      );
    }
    await this.ports.board.replaceCoordinator({
      boardId: board.boardId,
      coordinatorSessionId: coordinatorId,
      requestId: derivedStepId(receipt, 'handover.coordinator.replace'),
    });
    return await this.write(
      receipt,
      'coordinator_replaced',
      `board ${board.boardId} is coordinated by ${coordinatorId}`,
    );
  }

  /**
   * The binding gate, and the retirement it authorizes.
   *
   * The verdict is only true at the instant it is read, so the relinquish that follows it happens in
   * the same pass rather than on a later tick. A refusal is NOT a failure: the replacement already
   * holds the board, and the correct behaviour is to wait for the predecessor's own work to finish,
   * for as long as that takes. There is no force flag, because a gate that could be forced past would
   * make the whole inspection decorative.
   */
  private async drain(receipt: HandoverReceipt): Promise<HandoverReceipt | null> {
    const verdict = await this.ports.preflight.evaluate(receipt.sourceSessionId);
    const carried = verdict.reportPath === null ? receipt : { ...receipt, inflightReportPath: verdict.reportPath };
    if (!verdict.proceed) return await this.park(carried, verdict.reason);
    // RE-OBSERVED BETWEEN THE VERDICT AND THE INTENT, and this is the last place it could be missed.
    // Stamping `retiring` makes a terminal source EXEMPT from source loss — it becomes the expected
    // proof of this handover's own committed stop. So a predecessor that died DURING the preflight
    // would be laundered by the very next line: the death predates the retirement, but the receipt
    // would claim it as its own, and the boardless path would go on to record a completion for a stop
    // it never performed. The window is narrow and the misreport is total, so it is closed here.
    const source = await this.ports.sessions.read(receipt.sourceSessionId);
    if (source === null || isTerminalStatus(source.status)) {
      return await this.failSourceLost(
        carried,
        `${receipt.sourceSessionId} stopped while the gate was being read, before this handover ` +
          'recorded any retirement of its own',
      );
    }
    // THE INTENT IS WRITTEN BEFORE THE PAIR. It is the last unrecorded window in the ladder: without
    // it, a daemon that died between the relinquish and the phase write would restart with no record
    // that the gate had ever cleared.
    const retiring = this.stamp(carried, 'draining', this.ports.clock.now(), {
      detail: `${verdict.reason}; retiring the predecessor now`,
      effectIntent: 'retiring',
    });
    await this.ports.receipts.write(retiring);
    const board = receipt.board;
    if (board === null) {
      await this.ports.sessions.stop(receipt.sourceSessionId, this.retirementReason(receipt));
      return await this.write(retiring, 'predecessor_stopped', verdict.reason);
    }
    await this.ports.board.relinquish({
      boardId: board.boardId,
      memberSessionId: receipt.sourceSessionId,
      requestId: derivedStepId(receipt, 'handover.relinquish'),
    });
    return await this.write(retiring, 'relinquished', `${verdict.reason}; the predecessor gave up its membership`);
  }

  /**
   * Records that the gate refused, at most once per distinct reason.
   *
   * A parked handover is re-evaluated on every tick, and writing the same sentence into the phase
   * history each time would turn a receipt into a log of a session doing its job. A CHANGED reason is
   * written, because that is the part an operator watching the drain needs to see.
   */
  private async park(receipt: HandoverReceipt, reason: string): Promise<null> {
    const last = receipt.phaseHistory[receipt.phaseHistory.length - 1];
    if (last?.phase === receipt.phase && last.detail === reason) return null;
    await this.ports.receipts.write(this.stamp(receipt, receipt.phase, this.ports.clock.now(), { detail: reason }));
    return null;
  }

  /**
   * Records the tail of a retirement whose destructive half already happened.
   *
   * Reached only when the receipt says the gate cleared and the source is already stopped, so nothing
   * here re-runs the gate and the boardless case does not re-issue a stop it can see the result of.
   * The board case still relinquishes: the marker proves the gate cleared, not that the relinquish
   * landed, and the derived id makes a second attempt a replay the board's own ledger answers.
   */
  private async retireWithoutGate(receipt: HandoverReceipt): Promise<HandoverReceipt> {
    const board = receipt.board;
    if (board === null) {
      // A LIVE source here is a crash between the intent and the stop, not a reason to re-gate: the
      // gate cleared before the intent was persisted. The stop is idempotent, so replaying it is the
      // whole recovery; a terminal source is the observed proof that it already happened.
      const source = await this.ports.sessions.read(receipt.sourceSessionId);
      if (source !== null && !isTerminalStatus(source.status)) {
        await this.ports.sessions.stop(receipt.sourceSessionId, this.retirementReason(receipt));
        return await this.write(receipt, 'predecessor_stopped', 'the retirement resumed and stopped the predecessor');
      }
      return await this.write(
        receipt,
        'predecessor_stopped',
        'the predecessor was already stopped when this handover resumed; the stop it recorded is the one that happened',
      );
    }
    // A COMMITTED RELINQUISH IS OBSERVED, NEVER REPLAYED, and this is not an optimisation.
    // `membership.relinquish` authorizes the caller BEFORE it consults its applied-operation ledger,
    // and the commit it performs revokes the very binding that authorization reads — so a second call
    // after a successful one cannot authenticate and would fail permanently rather than replay. The
    // board's own roster is the durable evidence: a source that is no longer an active root has already
    // relinquished, and the honest move is to record that and carry on to the stop.
    const roots = (await this.ports.boardReader.observe(board.boardId, board.invitationRequestId))
      ?.activeRootSessionIds;
    if (roots !== undefined && !roots.includes(receipt.sourceSessionId)) {
      return await this.write(
        receipt,
        'relinquished',
        'the predecessor is no longer an active root, so its relinquish had already committed when this ' +
          'handover resumed',
      );
    }
    await this.ports.board.relinquish({
      boardId: board.boardId,
      memberSessionId: receipt.sourceSessionId,
      requestId: derivedStepId(receipt, 'handover.relinquish'),
    });
    return await this.write(
      receipt,
      'relinquished',
      'the predecessor was already stopped when this handover resumed; its membership is relinquished',
    );
  }

  /**
   * The last destructive act, and it OBSERVES before it performs.
   *
   * By this phase the relinquish has committed, so a crash before the phase write leaves a retry here
   * against a predecessor that may already be stopped — or gone from the registry entirely. A stop is
   * idempotent against a stopped RECORD, but not against a missing one: the lifecycle needs a record
   * to stop, so an unconditional call would throw every pass and park the handover forever, one write
   * short of finishing, with the membership already given up.
   *
   * So a source that is terminal or absent is the observed proof that the stop already happened, and
   * the receipt records it. Only a live one is actually stopped.
   */
  private async stopPredecessor(receipt: HandoverReceipt, world: HandoverWorld): Promise<HandoverReceipt> {
    const still = world.replacement === null ? '' : ` in favour of ${world.replacement.sessionId}`;
    if (world.source === null || isTerminalStatus(world.source.status)) {
      return await this.write(
        receipt,
        'predecessor_stopped',
        `the predecessor was already ${world.source === null ? 'gone' : world.source.status} when the ` +
          `retirement resumed${still}`,
      );
    }
    await this.ports.sessions.stop(receipt.sourceSessionId, this.retirementReason(receipt));
    return await this.write(receipt, 'predecessor_stopped', `the predecessor was stopped${still}`);
  }

  private retirementReason(receipt: HandoverReceipt): string {
    return `handover to ${receipt.replacementSessionId ?? 'its replacement'}`;
  }

  /**
   * The completion fact, on both journals, in one fixed order.
   *
   * PREDECESSOR FIRST, ALWAYS. The order is not cosmetic: the receipt lives beside the predecessor
   * and the predecessor is the subject of every phase, so a reader reconstructing what happened reads
   * the two histories in the order they were written and finds the same story on both sides.
   *
   * `appendOnce` is what makes the pair replayable. A crash between the two appends re-runs this step,
   * and a plain append would then write the predecessor's completion twice — leaving the fleet's own
   * history claiming one session was handed over two times.
   */
  private async complete(receipt: HandoverReceipt): Promise<HandoverReceipt> {
    const replacementId = this.requireReplacementId(receipt);
    const data = {
      requestId: receipt.requestId,
      sourceSessionId: receipt.sourceSessionId,
      replacementSessionId: replacementId,
      boardId: receipt.board?.boardId ?? null,
      planId: receipt.planId,
    };
    await this.ports.journal.appendOnce({
      sessionId: receipt.sourceSessionId,
      operationId: derivedStepId(receipt, 'handover.journal.source'),
      type: HANDOVER_COMPLETED_EVENT,
      data,
    });
    await this.ports.journal.appendOnce({
      sessionId: replacementId,
      operationId: derivedStepId(receipt, 'handover.journal.replacement'),
      type: HANDOVER_COMPLETED_EVENT,
      data,
    });
    return await this.write(receipt, 'completed', `${receipt.sourceSessionId} was handed over to ${replacementId}`);
  }

  // ─── terminal outcomes ────────────────────────────────────────────────────────────────────────

  /**
   * Stops a replacement that was created and never accepted, then records the abandonment.
   *
   * The invitation is deliberately NOT withdrawn: no reducer in this daemon revokes one, and a
   * hand-rolled withdrawal at this layer would be an authorization decision made outside the only
   * place that makes them. It expires by itself, and until it does a DIFFERENT request id is refused
   * `board_busy` — which is the reducer being right rather than a gap.
   */
  private async abandon(
    receipt: HandoverReceipt,
    failure: HandoverFailure,
    reason: string,
  ): Promise<HandoverReceipt | null> {
    // THE INTENT FIRST, THEN THE STOP. A crash between them otherwise restarts into the forward ladder
    // with the replacement already gone — inviting or starting a session that no longer exists.
    const intended = await this.intend(receipt, failure, reason);
    // RE-OBSERVED AFTER THE INTENT, never decided from the snapshot this pass opened with. A create
    // that landed between that read and this write would otherwise be terminalised as `abandoned`
    // without ever being stopped — a receipt claiming a tidy undo while the session it made keeps
    // running. And if the PREDECESSOR died in the same window, source loss outranks this settlement
    // entirely: `abandoned` would promise an undo of a handover whose subject no longer exists.
    const now = await this.observe(intended);
    if (now.source === null || isTerminalStatus(now.source.status)) {
      return await this.failSourceLost(
        intended,
        `${receipt.sourceSessionId} stopped outside this handover while it was being abandoned`,
      );
    }
    if (now.replacement !== null) await this.ports.sessions.stop(now.replacement.sessionId, reason);
    return await this.settle(intended, 'abandoned', failure, reason);
  }

  /**
   * Records a handover that cannot finish and cannot be undone, and raises the one item about it.
   *
   * THE ATTENTION IS RAISED BEFORE THE TERMINAL WRITE. `stranded` is terminal, so a later pass does
   * nothing at all — raising afterwards would mean a failed raise left a stranded handover with
   * nobody told. Raising first makes the pass retry until somebody is, and the ledger's own
   * source-reference deduplication turns a repeat into a refresh rather than a second item.
   */
  private async strand(
    receipt: HandoverReceipt,
    failure: HandoverFailure,
    reason: string,
  ): Promise<HandoverReceipt | null> {
    // THE INTENT FIRST, THEN THE RAISE. A crash after a successful raise otherwise lets a late
    // verification resume the forward ladder, retiring a predecessor a human has already been told to
    // decide about. The retry re-raises under the same source reference, which the ledger refreshes.
    const intended = await this.intend(receipt, failure, reason);
    // RE-OBSERVED AFTER THE INTENT, exactly as the abandon path is, and for a sharper reason. Every
    // word of a stranding is a claim about a LIVE predecessor: still running, still a member, yours to
    // decide about. If the source died between the intent and this raise, that message is false in
    // every clause — and `stranded` is terminal, so once written no later pass can let source loss
    // outrank it. The classification has to happen before the point of no return, not after.
    const now = await this.observe(intended);
    if (now.source === null || isTerminalStatus(now.source.status)) {
      return await this.failSourceLost(
        intended,
        `${receipt.sourceSessionId} stopped outside this handover while it was being stranded`,
      );
    }
    if (!(await this.raiseStranded(intended, reason))) return null;
    return await this.settle(intended, 'stranded', failure, reason);
  }

  /**
   * Raises the item, or parks the pass so the next one tries again.
   *
   * `false` rather than a throw, because the phase this is about to write is TERMINAL: a settled
   * `stranded` receipt is never looked at again, so a raise that failed after the write would leave a
   * handover parked past its point of no return with nobody told. Parking keeps the receipt live and
   * the ledger's own source-reference deduplication turns the eventual retry into one item, not two.
   */
  private async raiseStranded(receipt: HandoverReceipt, reason: string): Promise<boolean> {
    return await this.raiseAttention(
      receipt,
      `the handover of ${receipt.sourceSessionId} is stranded`,
      reason,
      `This handover passed the point of no return, so nothing was undone and nothing was destroyed: ` +
        `${receipt.sourceSessionId} is still running and still a member of its board. Decide whether to let ` +
        `${receipt.replacementSessionId ?? 'the replacement'} take over — start it and have it run ` +
        '`fy task-board invite-verify` — or to stop it and leave the predecessor in place.',
    );
  }

  /**
   * One item, one source reference, and WORDS THAT MATCH WHAT HAPPENED.
   *
   * The subject and the remedy are arguments rather than a fixed sentence because the two situations
   * that raise one are genuinely different, and a shared sentence would be false for one of them: a
   * stranded handover leaves its predecessor running and still a member, while a source-loss failure
   * has no predecessor left at all. Telling a human to go and decide about a session that is already
   * gone is worse than telling them nothing.
   */
  private async raiseAttention(
    receipt: HandoverReceipt,
    subject: string,
    reason: string,
    howToResolve: string,
  ): Promise<boolean> {
    try {
      await this.ports.attention.raise({
        sessionId: receipt.sourceSessionId,
        // The SAME reference either way, so a handover that strands and is later superseded refreshes
        // one item rather than leaving a human two rows about one operation.
        sourceRef: `handover:${receipt.requestId}`,
        subject,
        why: reason,
        howToResolve,
      });
    } catch (error) {
      await this.ports.receipts.write(
        this.stamp(receipt, receipt.phase, this.ports.clock.now(), {
          detail: `this handover needs a human and the attention could not be raised: ${detail(error)}`,
        }),
      );
      return false;
    }
    return true;
  }

  /**
   * Persists the settlement decision on the CURRENT phase, before anything terminal is done about it.
   *
   * Idempotent by construction: a receipt already carrying this refusal is returned untouched, so a
   * replayed pass does not grow the phase history a line at a time.
   */
  private async intend(receipt: HandoverReceipt, failure: HandoverFailure, reason: string): Promise<HandoverReceipt> {
    if (receipt.refusal?.failure === failure) return receipt;
    const intended = this.stamp(receipt, receipt.phase, this.ports.clock.now(), {
      detail: `settling: ${failure}`,
      refusal: { failure, message: reason },
      effectIntent: null,
    });
    await this.ports.receipts.write(intended);
    return intended;
  }

  /**
   * The predecessor died outside this handover's own retirement, and the handover settles honestly.
   *
   * `failed` is the only terminal that does not lie here. `refused` would claim nothing was created,
   * `abandoned` would claim a tidy undo, and `stranded` would claim a predecessor still running and
   * still a member — of a session that is gone. `source_lost` is the one cause the protocol lets reach
   * `failed` before a recorded stop, precisely so this case has somewhere true to land.
   *
   * WHAT HAPPENS TO THE REPLACEMENT DEPENDS ON WHETHER IT IS STILL DISPOSABLE, re-observed rather than
   * assumed. Before acceptance it is a session this daemon made and may stop again. At or after it, the
   * board has admitted a root nothing revokes — so it is left running and a human is told, under the
   * same deduplicated source reference every other stranding uses.
   *
   * A CANCELLATION IN FLIGHT IS SUPERSEDED, NOT ERASED. Source loss wins the race and decides the
   * terminal, but `cancelRequestId` stays on the receipt: the operator did ask, that ask is what a
   * retry under the same id resumes, and rewriting history to say they never did would lose the only
   * record of who tried to stop this.
   */
  private async failSourceLost(receipt: HandoverReceipt, reason: string): Promise<HandoverReceipt | null> {
    // THE INTENT IS PERSISTED FIRST, then the world is re-observed, then the cleanup runs. Source loss
    // is re-derivable — the predecessor's record is durable, so a later pass would reach the same
    // conclusion — but the intent still earns its write: it makes the DECISION durable at the same
    // instant the cause is, so a crash between the cleanup and the terminal resumes as a settlement
    // rather than as a fresh classification of a world that may have moved on again.
    //
    // A superseded cancellation keeps its `cancelRequestId` right through this, from the nonterminal
    // intent to the terminal `failed`. The operator did ask; source loss decides the OUTCOME, not who
    // asked, and erasing that would lose the only record of who tried to stop this.
    const intended = await this.intend(receipt, 'source_lost', reason);
    const disposable = !receiptIsIrreversible(intended);
    if (disposable) {
      // RE-OBSERVED after the intent, because a create that landed between the pass's opening read and
      // this failure would otherwise be left running with nothing to stop it.
      const now = await this.observe(intended);
      if (now.replacement !== null) await this.ports.sessions.stop(now.replacement.sessionId, reason);
    } else if (
      !(await this.raiseAttention(
        intended,
        `the handover of ${receipt.sourceSessionId} lost its subject`,
        reason,
        sourceLostRemedy(intended),
      ))
    ) {
      return null;
    }
    return await this.settle(intended, 'failed', 'source_lost', reason);
  }

  private async settle(
    receipt: HandoverReceipt,
    phase: HandoverPhase,
    failure: HandoverFailure,
    reason: string,
  ): Promise<HandoverReceipt> {
    const settled = this.stamp(receipt, phase, this.ports.clock.now(), {
      detail: reason,
      refusal: { failure, message: reason },
    });
    await this.ports.receipts.write(settled);
    return settled;
  }

  // ─── the begin path ───────────────────────────────────────────────────────────────────────────

  /**
   * What an existing receipt means for a fresh begin.
   *
   * `null` says "carry on and accept it". Everything else is decided here so the accept path below
   * reads as one story: a receipt in flight is replayed or refused, a terminal one is either a
   * finished operation this request may not reopen or a stopped one the same request id may try
   * again — which is exactly the retryability the phase table promises.
   */
  private replayDecision(
    existing: HandoverReceipt | null,
    requestId: string,
    fingerprint: string,
  ): HandoverReceipt | null {
    if (existing === null) return null;
    if (existing.requestId !== requestId) {
      if (!isTerminalHandoverPhase(existing.phase)) {
        throw new HandoverError(
          'in_flight',
          `session ${existing.sourceSessionId} is already being handed over under request id ` +
            `${existing.requestId}, currently at ${existing.phase}; present that id to follow it`,
        );
      }
      if (existing.phase === 'completed') {
        throw new HandoverError(
          'already_completed',
          `session ${existing.sourceSessionId} has already been handed over to ` +
            `${existing.replacementSessionId ?? 'a replacement'}; it is not a session a second handover can move`,
        );
      }
      if (existing.phase === 'stranded' || existing.phase === 'failed') {
        throw new HandoverError(
          'in_flight',
          `an earlier handover of ${existing.sourceSessionId} ended at ${existing.phase} and has not been ` +
            'resolved; its effects are still outstanding, so beginning another would act on a board that is ' +
            'already carrying the first one',
        );
      }
      return null;
    }
    if (existing.fingerprint !== fingerprint) {
      throw new HandoverError(
        'request_conflict',
        `request id ${requestId} was already used for a handover of ${existing.sourceSessionId} that asked for ` +
          'something else; a retry must carry the request it is retrying',
      );
    }
    // A stopped handover retried under its own id starts over, which is what `refused` and
    // `abandoned` promise. Every other phase replays the receipt as it stands.
    return existing.phase === 'refused' || existing.phase === 'abandoned' ? null : existing;
  }

  private async accept(
    sourceSessionId: string,
    request: HandoverRequestBody,
    requestId: string,
    fingerprint: string,
    wardenId: string | undefined,
    previous: HandoverReceipt | null,
  ): Promise<HandoverReceipt> {
    const source = await this.ports.sessions.read(sourceSessionId);
    if (source === null) {
      throw new HandoverError('source_not_found', `this daemon holds no session ${sourceSessionId}`);
    }
    const membership = await this.ports.boardReader.membership(sourceSessionId);
    // A RETRY LOADS, IT DOES NOT RE-RESOLVE. A receipt already written under this request id is
    // authoritative, so a fleet manifest edited between a refusal and the retry cannot launch facts
    // the operator never asked for under an id they think they are repeating.
    const target = previous?.requestId === requestId ? previous.resolvedTarget : await this.resolve(request);
    const eligibility = handoverEligibility({
      source,
      membership,
      target,
      wardenDriven: wardenId !== undefined,
    });
    if (!eligibility.ok) throw new HandoverError(eligibility.refusal.failure, eligibility.refusal.message);
    const advisory = await this.ports.preflight.evaluate(sourceSessionId);
    if (!advisory.proceed) {
      throw new HandoverError(
        'preflight_blocked',
        `${sourceSessionId} is not safe to interrupt: ${advisory.reason}. A handover ends by stopping it, so ` +
          'beginning one now would queue a destruction behind work this daemon cannot account for',
      );
    }
    // THE RECEIPT IS THE ONE FROZEN AUTHORITY, written before any identity is claimed and any session
    // is created. It carries the resolved accounts and the whole plan, so nothing downstream resolves
    // an account or prepares a plan a second time: an edited fleet manifest cannot change what an
    // in-flight handover launches, and a crash cannot import a plan cut against a source that has
    // moved on. A retry under the same request id re-uses this document rather than deriving another.
    const planId = handoverPlanId(sourceSessionId, requestId);
    const plan =
      previous?.requestId === requestId
        ? previous.plan
        : this.assertPlanId(
            planId,
            await this.ports.preparer.prepare({
              sourceSessionId,
              requestId,
              target: target.replacement,
              cutMessagePoint: null,
            }),
          );
    const at = this.ports.clock.now();
    const receipt: HandoverReceipt = {
      requestId,
      fingerprint,
      reason: request.reason,
      sourceSessionId,
      sourceHarness: eligibility.sourceHarness,
      sourceAgent: source.agent,
      ...(source.teammate === null ? {} : { sourceTeammate: source.teammate }),
      resolvedTarget: target,
      planId,
      plan,
      board:
        membership === null
          ? null
          : {
              boardId: membership.boardId,
              creatorSessionId: membership.creatorSessionId,
              canonicalSessionId: membership.canonicalSessionId,
              createdAt: membership.createdAt,
            },
      phase: 'requested',
      phaseHistory: [{ phase: 'requested', at, detail: request.reason }],
      ...(advisory.reportPath === null ? {} : { inflightReportPath: advisory.reportPath }),
      createdAt: at,
      updatedAt: at,
    };
    await this.ports.receipts.write(receipt);
    return receipt;
  }

  /** One resolution of each account, so nothing downstream can look one up a second time. */
  private async resolve(request: HandoverRequestBody): Promise<HandoverResolvedTarget> {
    const replacement = await this.ports.accounts.resolve(request.agent, request.model ?? null);
    if (request.coordinator === null) return { replacement, coordinator: null };
    const coordinator = await this.ports.accounts.resolve(request.coordinator.agent, request.coordinator.model ?? null);
    return { replacement, coordinator };
  }

  // ─── reading the world, and the small demands each step makes of the receipt ──────────────────

  private async observe(receipt: HandoverReceipt): Promise<HandoverWorld> {
    const replacement =
      receipt.replacementSessionId === undefined ? null : await this.ports.sessions.read(receipt.replacementSessionId);
    const board =
      receipt.board === null
        ? null
        : await this.ports.boardReader.observe(receipt.board.boardId, receipt.board.invitationRequestId);
    return {
      now: this.ports.clock.now(),
      source: await this.ports.sessions.read(receipt.sourceSessionId),
      replacement,
      board,
      verificationDeadlineMinutes: this.settings.verificationDeadlineMinutes,
    };
  }

  private requireReplacementId(receipt: HandoverReceipt): string {
    if (receipt.replacementSessionId !== undefined) return receipt.replacementSessionId;
    throw new HandoverError(
      'step_failed',
      `handover ${receipt.requestId} reached ${receipt.phase} without a replacement identity, which its own ` +
        'schema forbids',
    );
  }

  private requireCoordinatorId(receipt: HandoverReceipt): string {
    if (receipt.coordinatorSessionId !== undefined) return receipt.coordinatorSessionId;
    throw new HandoverError(
      'step_failed',
      `handover ${receipt.requestId} reached ${receipt.phase} without a coordinator identity, which its own ` +
        'schema forbids',
    );
  }

  private requireBoard(receipt: HandoverReceipt): NonNullable<HandoverReceipt['board']> {
    if (receipt.board !== null) return receipt.board;
    throw new HandoverError(
      'board_moved',
      `handover ${receipt.requestId} reached a board step with no board recorded; a boardless root has no ` +
        'membership to move',
    );
  }

  private requireInvitation(receipt: HandoverReceipt): string {
    const invitation = this.requireBoard(receipt).invitationRequestId;
    if (invitation !== undefined) return invitation;
    throw new HandoverError(
      'step_failed',
      `handover ${receipt.requestId} reached ${receipt.phase} without the invitation it recorded at invite`,
    );
  }

  // ─── writing the receipt ──────────────────────────────────────────────────────────────────────

  private async advanceTo(receipt: HandoverReceipt, phase: HandoverPhase, why: string): Promise<HandoverReceipt> {
    return await this.write(receipt, phase, why);
  }

  private async write(receipt: HandoverReceipt, phase: HandoverPhase, why: string): Promise<HandoverReceipt> {
    const next = this.stamp(receipt, phase, this.ports.clock.now(), { detail: why });
    await this.ports.receipts.write(next);
    return next;
  }

  /**
   * The one place a receipt changes.
   *
   * The phase history is append-only and always ends at the current phase, which is what the durable
   * schema demands and what makes the document its own audit trail: no phase is ever rewritten, so a
   * receipt read after the fact says not just where a handover got to but every step it took there.
   */
  private stamp(
    receipt: HandoverReceipt,
    phase: HandoverPhase,
    at: string,
    extra: {
      readonly detail?: string;
      readonly refusal?: { readonly failure: HandoverFailure; readonly message: string };
      /** `null` clears the substep intent; omitted keeps whatever the receipt already carries. */
      readonly effectIntent?: HandoverEffectIntent | null;
    },
  ): HandoverReceipt {
    // THE INTENT IS CLEARED BY THE TRANSITION IT AUTHORIZED. An `accepting` receipt that has reached
    // `accepted`, or a `retiring` one that has left `draining`, is describing a window that has closed
    // — and the durable schema refuses to hold either intent outside its own phase, so carrying one
    // forward would make the very next write unreadable.
    const cleared = phase !== receipt.phase || extra.effectIntent === null;
    const intent = extra.effectIntent ?? (cleared ? undefined : receipt.effectIntent);
    const { effectIntent: _dropped, ...rest } = receipt;
    return {
      ...rest,
      ...(intent === undefined || intent === null ? {} : { effectIntent: intent }),
      ...(extra.refusal === undefined ? {} : { refusal: extra.refusal }),
      phase,
      // THE PROVENANCE IS STAMPED IN THE SAME WRITE THAT ACTIVATES THE INTENT, and it is append-only:
      // the active field is cleared by the transition it authorized, but the EVENT stays. That is what
      // lets a later reader — and the durable schema — justify a terminal shortcut that would otherwise
      // look like a skipped ladder: a receipt that went `approved -> stranded` is only legal because
      // the history proves the acceptance was committed, and the active field is long gone by then.
      //
      // IT IS STAMPED FROM THE RESULTING INTENT, NOT ONLY FROM A NEWLY PASSED ONE. The schema demands
      // that an active intent appear on the receipt's LAST same-phase event, so a same-phase append
      // that merely records a transient error — an accept whose delivery threw, a stop that failed —
      // has to carry it forward too. Stamping only on activation made exactly those writes
      // unreadable, which turned every retryable error inside a window into a permanent one.
      phaseHistory: [
        ...receipt.phaseHistory,
        {
          phase,
          at,
          ...(extra.detail === undefined ? {} : { detail: extra.detail }),
          ...(intent === undefined || intent === null ? {} : { effectIntent: intent }),
        },
      ],
      updatedAt: at,
    };
  }

  /**
   * One queue per source session id.
   *
   * The chain is advanced with a swallowing continuation rather than the call's own promise, so a
   * rejected call leaves the chain settled and the NEXT call still happens; the rejection itself is
   * still delivered to this caller. The entry is deleted once its own tail settles, so a daemon that
   * hands over a thousand sessions does not keep a thousand resolved promises.
   */
  private async serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const queued = previous.then(task, task);
    const settled = queued.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, settled);
    void settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return await queued;
  }
}
