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
  handoverCleanupPlan,
  handoverFingerprint,
  HANDOVER_RETIRING_MARKER,
  handoverPlanId,
  type HandoverPlan,
  type HandoverStep,
  type HandoverWorld,
  isTerminalHandoverPhase,
  nextPhase,
  receiptIsIrreversible,
} from './policy.ts';
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
      if (receipt.refusal?.failure === 'cancelled') {
        if (receipt.cancelRequestId === requestId) return await this.drive(receipt);
        throw new HandoverError(
          'request_conflict',
          `this handover is already being cancelled under request id ${receipt.cancelRequestId ?? 'an earlier call'}; ` +
            'present that id to follow it rather than starting a second cancellation of one operation',
        );
      }
      const source = await this.ports.sessions.read(sourceSessionId);
      if (source !== null && isTerminalStatus(source.status)) {
        throw new HandoverError(
          'cancelled',
          `this handover cannot be cancelled: ${sourceSessionId} has already been stopped, so the one ` +
            'destructive act a cancellation exists to prevent has happened; the receipt records where it got to',
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
      if (advanced === null) return receipt;
      receipt = advanced;
    }
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
        return await this.abandon(receipt, world, plan.failure, plan.reason);
      case 'strand':
        return await this.strand(receipt, plan.failure, plan.reason);
      case 'fail':
        return await this.settle(receipt, 'failed', plan.failure, plan.reason);
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
      if (error instanceof HandoverError) return await this.settleNamed(receipt, world, error);
      await this.ports.receipts.write(
        this.stamp(receipt, receipt.phase, this.ports.clock.now(), {
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
  private async settleNamed(
    receipt: HandoverReceipt,
    world: HandoverWorld,
    error: HandoverError,
  ): Promise<HandoverReceipt | null> {
    if (!receiptIsIrreversible(receipt)) {
      const unwind = handoverCleanupPlan(receipt, world, error.failure, error.message);
      return unwind.kind === 'refuse'
        ? await this.settle(receipt, 'refused', unwind.failure, unwind.reason)
        : await this.abandon(receipt, world, unwind.failure, unwind.reason);
    }
    if (receipt.board === null || receipt.phase === 'predecessor_stopped') {
      return await this.settle(receipt, 'failed', error.failure, error.message);
    }
    return await this.strand(receipt, error.failure, error.message);
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
    const { grantId } = await this.ports.board.acceptInvitation({
      boardId: board.boardId,
      invitationRequestId: this.requireInvitation(receipt),
      targetSessionId: this.requireReplacementId(receipt),
      requestId: derivedStepId(receipt, 'handover.accept'),
    });
    const next = { ...receipt, board: { ...board, grantId } };
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
    // THE INTENT IS WRITTEN BEFORE THE PAIR. It is the last unrecorded window in the ladder: without
    // it, a daemon that died between the relinquish and the phase write would restart with no record
    // that the gate had ever cleared.
    const retiring = this.stamp(carried, 'draining', this.ports.clock.now(), {
      detail: `${verdict.reason}; ${HANDOVER_RETIRING_MARKER}`,
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

  private async stopPredecessor(receipt: HandoverReceipt, world: HandoverWorld): Promise<HandoverReceipt> {
    await this.ports.sessions.stop(receipt.sourceSessionId, this.retirementReason(receipt));
    const still = world.replacement === null ? '' : ` in favour of ${world.replacement.sessionId}`;
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
    world: HandoverWorld,
    failure: HandoverFailure,
    reason: string,
  ): Promise<HandoverReceipt> {
    if (world.replacement !== null) await this.ports.sessions.stop(world.replacement.sessionId, reason);
    return await this.settle(receipt, 'abandoned', failure, reason);
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
    if (!(await this.raiseStranded(receipt, reason))) return null;
    return await this.settle(receipt, 'stranded', failure, reason);
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
    try {
      await this.ports.attention.raise({
        sessionId: receipt.sourceSessionId,
        sourceRef: `handover:${receipt.requestId}`,
        subject: `the handover of ${receipt.sourceSessionId} is stranded`,
        why: reason,
        howToResolve:
          `This handover passed the point of no return, so nothing was undone and nothing was destroyed: ` +
          `${receipt.sourceSessionId} is still running and still a member of its board. Decide whether to let ` +
          `${receipt.replacementSessionId ?? 'the replacement'} take over — start it and have it run ` +
          '`fy task-board invite-verify` — or to stop it and leave the predecessor in place.',
      });
    } catch (error) {
      await this.ports.receipts.write(
        this.stamp(receipt, receipt.phase, this.ports.clock.now(), {
          detail: `this handover is stranded and the attention could not be raised: ${detail(error)}`,
        }),
      );
      return false;
    }
    return true;
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
    },
  ): HandoverReceipt {
    return {
      ...receipt,
      ...(extra.refusal === undefined ? {} : { refusal: extra.refusal }),
      phase,
      phaseHistory: [
        ...receipt.phaseHistory,
        { phase, at, ...(extra.detail === undefined ? {} : { detail: extra.detail }) },
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
