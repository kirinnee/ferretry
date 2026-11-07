import { describe, it } from 'bun:test';
import should from 'should';
import type {
  HandoverBoardPort,
  HandoverChildGrantApproval,
  HandoverCoordinatorReplacement,
  HandoverInvitationStepCommand,
} from '../../../src/lib/handover/types.ts';

/**
 * What a handover's board leg must survive: a crash AFTER the board committed and BEFORE the
 * capability reached the replacement's environment.
 *
 * WHY THIS FILE EXISTS AND WHAT IT DELIBERATELY DOES NOT DO. The defect these cases describe lives in
 * `src/lib/task-boards/invitation-service.ts` and `src/lib/runtime/mounts/task-boards.ts`, which this
 * unit does not own and must not edit. So this is a CONTRACT test over `HandoverBoardPort` — the seam
 * the handover actually consumes — rather than a test of the board's internals. It states, executably,
 * the property the fixed chain has to have, and the day the real adapter is wired in it can be
 * substituted for the double below without changing a single assertion.
 *
 * THE PROPERTY, in one sentence: a replayed board step must re-deliver THE CAPABILITY THAT IS
 * PERSISTED, never a freshly minted one.
 *
 * Why that is the whole ballgame for row 48. The capability reaches the replacement through its
 * `environment.json`, and the replacement proves it holds a working membership by calling
 * `invitation.verify` with it — which is the ONE proof the orchestrator is structurally unable to
 * forge, and therefore the only thing standing between "the board says two roots" and "a replacement
 * that can actually coordinate". A replay that delivers a newly minted secret hands the replacement a
 * credential whose hash matches no binding: it authenticates nothing, `invite-verify` can never
 * succeed, and the handover strands past the point of no return with the board carrying two active
 * roots and no way back — there is no grant-revoke reducer in this repository.
 *
 * Two failure modes are pinned separately because they have different fixes:
 *   1. the step is REPLAYABLE AT ALL — a replayed accept must not be refused outright;
 *   2. the step RE-DELIVERS THE PERSISTED VALUE — not a fresh mint.
 * A chain that fixes only the second still strands, and a chain that fixes only the first delivers a
 * capability that authenticates nothing. Both are required, so both are asserted.
 */

/** What a delivered environment write looked like: which session, and which secret. */
interface Delivery {
  readonly sessionId: string;
  readonly capability: string;
}

/**
 * A board that behaves the way the FIXED chain must.
 *
 * It models exactly the two things the reviewed fix has to establish, and nothing else: the persisted
 * binding keeps the capability that was committed, and a replayed step recovers and re-delivers that
 * same value instead of minting again. Its `crashAfterCommit` switch reproduces the real window — the
 * transaction committed, the process died before the environment write.
 */
class ReplayableBoard implements HandoverBoardPort {
  /** Every environment write, in order. The assertions are all about this list. */
  readonly deliveries: Delivery[] = [];
  /** grantId -> the capability the board PERSISTED for it, as `TaskBoardBinding.capability` does. */
  private readonly persisted = new Map<string, string>();
  /** requestId -> the grant that request already produced: the applied-operation ledger. */
  private readonly applied = new Map<string, string>();
  private minted = 0;
  /** Set to make the next committing step die between the commit and the delivery. */
  crashAfterCommit = false;

  async requestInvitation(): Promise<{ readonly invitationRequestId: string }> {
    return { invitationRequestId: 'invite-1' };
  }

  async approveInvitation(): Promise<void> {}

  async acceptInvitation(input: HandoverInvitationStepCommand): Promise<{ readonly grantId: string }> {
    return { grantId: this.commitAndDeliver(input.requestId, input.targetSessionId) };
  }

  async requestChildGrant(): Promise<{ readonly grantRequestId: string }> {
    return { grantRequestId: 'child-grant-1' };
  }

  async approveChildGrant(input: HandoverChildGrantApproval): Promise<{ readonly grantId: string }> {
    return { grantId: this.commitAndDeliver(input.requestId, 'coordinator-1') };
  }

  async replaceCoordinator(input: HandoverCoordinatorReplacement): Promise<void> {
    this.commitAndDeliver(input.requestId, input.coordinatorSessionId);
  }

  async relinquish(): Promise<void> {}

  /**
   * One committing board step, then the environment write.
   *
   * THE ORDER HERE IS THE FIX. The ledger is consulted FIRST, so a replayed request id recovers the
   * grant that already exists and the capability persisted beside it; only a genuinely fresh request
   * mints. The broken chain does the opposite — it mints before the transaction and then delivers that
   * mint even when the reducer answered from its ledger.
   */
  private commitAndDeliver(requestId: string, sessionId: string): string {
    const replayed = this.applied.get(requestId);
    // The increment is its own statement rather than an assignment inside the template: buried in an
    // expression it reads as side-effect-free, and here it is precisely the side effect that decides
    // whether this call minted a new grant or recovered one.
    if (replayed === undefined) this.minted += 1;
    const grantId = replayed ?? `grant-${this.minted}`;
    if (replayed === undefined) {
      this.applied.set(requestId, grantId);
      this.persisted.set(grantId, `capability-${grantId}`);
    }
    const capability = this.persisted.get(grantId);
    if (capability === undefined) throw new Error(`no persisted capability for ${grantId}`);
    // The commit is durable at this point. A crash HERE is the window the whole contract is about.
    if (this.crashAfterCommit) {
      this.crashAfterCommit = false;
      throw new Error('the daemon died after the board committed and before the capability was delivered');
    }
    this.deliveries.push({ sessionId, capability });
    return grantId;
  }
}

const ACCEPT: HandoverInvitationStepCommand = {
  boardId: 'board-1',
  invitationRequestId: 'invite-1',
  targetSessionId: 'replacement-1',
  requestId: 'derived:handover.accept',
};

describe('the handover board leg, replayed after a crash', () => {
  it('should re-deliver the PERSISTED capability when an accept is replayed, never a fresh mint', async () => {
    // The capability reaches the replacement through its environment, and it proves its membership by
    // calling invitation.verify with it. A replay that delivered a newly minted secret would hand over
    // a credential whose hash matches no binding: verify could never succeed, and the handover would
    // strand past the point of no return.
    // Arrange: the board commits, then the daemon dies before the environment write.
    const board = new ReplayableBoard();
    board.crashAfterCommit = true;
    let crashed = false;
    await board.acceptInvitation(ACCEPT).catch(() => {
      crashed = true;
    });
    should(crashed).be.true();
    should(board.deliveries).be.empty();

    // Act: the reconciler replays the step under the SAME derived request id.
    const replayed = await board.acceptInvitation(ACCEPT);

    // Assert: exactly one delivery, carrying the capability the board persisted at commit time.
    should(board.deliveries).have.length(1);
    should(board.deliveries[0]?.sessionId).equal('replacement-1');
    should(board.deliveries[0]?.capability).equal(`capability-${replayed.grantId}`);
  });

  it('should answer a replayed accept rather than refusing it, so the handover can still finish', async () => {
    // The second half of the defect, and the one that makes it unrecoverable rather than merely wrong:
    // in the broken chain the accept looks only for an invitation whose status is still `approved`,
    // while a successful accept sets `accepted` — so an identical replay is refused outright and the
    // predecessor can never be retired. A replay must ANSWER, with the grant it already produced.
    // Arrange
    const board = new ReplayableBoard();

    // Act
    const first = await board.acceptInvitation(ACCEPT);
    const replayed = await board.acceptInvitation(ACCEPT);

    // Assert: the same grant, and no second membership minted behind it.
    should(replayed.grantId).equal(first.grantId);
    should(board.deliveries.map(delivery => delivery.capability)).deepEqual([
      `capability-${first.grantId}`,
      `capability-${first.grantId}`,
    ]);
  });

  it('should re-deliver the persisted capability for a replayed child-grant approval', async () => {
    // The coordinator descendant reaches the board the same way and breaks the same way: the mount
    // mints before the transaction here too.
    // Arrange
    const board = new ReplayableBoard();
    const approval: HandoverChildGrantApproval = {
      boardId: 'board-1',
      grantRequestId: 'child-grant-1',
      requestId: 'derived:handover.child-grant.approve',
    };
    board.crashAfterCommit = true;
    let crashed = false;
    await board.approveChildGrant(approval).catch(() => {
      crashed = true;
    });
    should(crashed).be.true();

    // Act
    const replayed = await board.approveChildGrant(approval);

    // Assert
    should(board.deliveries).have.length(1);
    should(board.deliveries[0]).deepEqual({
      sessionId: 'coordinator-1',
      capability: `capability-${replayed.grantId}`,
    });
  });

  it('should re-deliver the persisted capability for a replayed coordinator replacement', async () => {
    // The succession itself is a committing step, and a coordinator seated with a capability that
    // authenticates nothing leaves the board unable to approve anything ever again.
    // Arrange
    const board = new ReplayableBoard();
    const replacement: HandoverCoordinatorReplacement = {
      boardId: 'board-1',
      coordinatorSessionId: 'coordinator-1',
      requestId: 'derived:handover.coordinator.replace',
    };
    board.crashAfterCommit = true;
    let crashed = false;
    await board.replaceCoordinator(replacement).catch(() => {
      crashed = true;
    });
    should(crashed).be.true();

    // Act
    await board.replaceCoordinator(replacement);

    // Assert: one delivery, and it carries a persisted value rather than a second mint.
    should(board.deliveries).have.length(1);
    should(board.deliveries[0]?.sessionId).equal('coordinator-1');
    should(board.deliveries[0]?.capability).match(/^capability-grant-/);
  });

  it('should keep two genuinely different board steps distinct, rather than deduplicating by session', async () => {
    // The derived request id is what identifies a step. Collapsing two different operations on one
    // session would silently skip the second — which for this chain means a coordinator that was never
    // actually seated while the receipt records that it was.
    // Arrange
    const board = new ReplayableBoard();

    // Act
    const accepted = await board.acceptInvitation(ACCEPT);
    const seated = await board.approveChildGrant({
      boardId: 'board-1',
      grantRequestId: 'child-grant-1',
      requestId: 'derived:handover.child-grant.approve',
    });

    // Assert
    should(seated.grantId).not.equal(accepted.grantId);
    should(board.deliveries).have.length(2);
  });
});
