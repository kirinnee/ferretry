import type { TaskBoardMembership, TaskBoardRelinquishResponse } from '@ferretry/protocol';
import { TASK_BOARD_OPERATOR_ACTOR_NAME, type TaskBoardAuthorizationService } from './authorization-service.ts';
import {
  appendTaskBoardAudit,
  bindingForGrant,
  membershipForGrant,
  replaceTaskBoard,
  requireTaskBoardRequestId,
  requireTaskBoardSession,
  taskBoardFingerprint,
} from './domain-helpers.ts';
import { TaskBoardError } from './error.ts';
import {
  actionsForTaskBoardRole,
  CURRENT_COORDINATOR_ACTIONS,
  isCurrentCoordinator,
  isGrantWithinActiveMembershipTree,
  liveMembershipRootGrant,
  sameTaskBoardActions,
  sessionLineage,
} from './policy.ts';
import type {
  TaskBoard,
  TaskBoardAppliedOperation,
  TaskBoardAuthorization,
  TaskBoardCredential,
  TaskBoardGrant,
  TaskBoardMutation,
  TaskBoardRepositoryState,
  TaskBoardSecret,
  TaskBoardSession,
} from './types.ts';

export interface RelinquishMembershipCommand {
  readonly member: TaskBoardCredential;
  readonly requestId: string;
  readonly at: string;
}

export interface ReplaceCoordinatorCommand {
  readonly boardId: string;
  /** The protocol member locator used to resolve `boardId`; part of the idempotency payload. */
  readonly memberSessionId: string;
  /**
   * The principal taking the coordinator's authority away. It is a non-session principal by
   * construction: the operator holds the board admin capability, and no member of a board — not even a
   * membership root — may re-appoint the coordinator that governs it.
   */
  readonly administrator: TaskBoardAuthorization;
  /** The live descendant which becomes the new coordinator. */
  readonly coordinatorSessionId: string;
  /** The exact live root whose tree the replacement must belong to. */
  readonly replacementRootSessionId: string;
  readonly requestId: string;
  readonly at: string;
}

export interface ReplaceCoordinatorMaterial {
  readonly grantId: string;
  readonly capability: TaskBoardSecret;
}

export type CoordinatorReplacementResult = { readonly replaced: true; readonly membership: TaskBoardMembership };

export const CHILD_GRANT_PROMOTION_REVOKE_REASON = 'child grant promoted to coordinator';

/**
 * A relinquish replay is trusted only when the durable operation, its retired actor grant, and the
 * capability-derived subject all describe the same original decision. This check deliberately does
 * not require a live binding: the successful operation removes that binding before its HTTP receipt
 * can be delivered.
 */
export function isExactRelinquishReplay(
  operation: TaskBoardAppliedOperation,
  grant: TaskBoardGrant,
  member: TaskBoardCredential,
): boolean {
  return (
    operation.kind === 'membership.relinquish' &&
    operation.actorGrantId === grant.id &&
    operation.actorSessionId === grant.sessionId &&
    operation.actorRuntimeGeneration === grant.runtimeGeneration &&
    operation.resultSessionId === grant.sessionId &&
    member.sessionId === grant.sessionId &&
    member.runtimeGeneration === grant.runtimeGeneration &&
    member.capabilityHash === grant.capabilityHash &&
    operation.fingerprint === taskBoardFingerprint(['membership.relinquish', grant.id, grant.runtimeGeneration])
  );
}

/**
 * Board-owned, append-only and deduplicated: a session retires once and stays retired.
 *
 * Retirement is not the inverse of membership and cannot be derived from the grants — a revoked grant
 * says the session may not ACT, while this list says its tasks are still addressable BY the board. The
 * two answers differ for exactly the sessions a handover retires, which is why the fact is stored.
 */
function withRetiredSessions(existing: readonly string[], retiring: readonly string[]): readonly string[] {
  const retired = [...existing];
  for (const sessionId of retiring) {
    if (!retired.includes(sessionId)) retired.push(sessionId);
  }
  return retired;
}

function requireBoard(state: TaskBoardRepositoryState, boardId: string): TaskBoard {
  const board = state.boards.find(candidate => candidate.id === boardId);
  if (board === undefined) throw new TaskBoardError('not-found', 'the task board was not found');
  return board;
}

function refreshBindings(
  bindings: readonly import('./types.ts').TaskBoardBinding[],
  grants: readonly TaskBoardGrant[],
  board: TaskBoard,
  at: string,
): readonly import('./types.ts').TaskBoardBinding[] {
  return bindings.flatMap(binding => {
    const grant = grants.find(candidate => candidate.id === binding.grantId);
    return grant === undefined || !grant.active ? [] : [bindingForGrant(board, grant, binding.capability, at)];
  });
}

export class TaskBoardMembershipService {
  constructor(private readonly authorization: TaskBoardAuthorizationService) {}

  relinquish(
    state: TaskBoardRepositoryState,
    sessions: readonly TaskBoardSession[],
    command: RelinquishMembershipCommand,
  ): TaskBoardMutation<TaskBoardRelinquishResponse> {
    const requestId = requireTaskBoardRequestId(command.requestId);
    /**
     * Resolve an exact committed replay before live authorization. A successful relinquish removes
     * its source binding, so asking `authorize` first makes a crash after commit but before receipt
     * permanently unrecoverable. The historical capability is identity only here: it can return a
     * result solely when the persisted operation and retired actor grant pass every pin below.
     */
    const replayCandidates = state.boards.flatMap(board =>
      board.grants
        .filter(
          candidate =>
            candidate.sessionId === command.member.sessionId &&
            candidate.runtimeGeneration === command.member.runtimeGeneration &&
            candidate.capabilityHash === command.member.capabilityHash,
        )
        .flatMap(grant =>
          board.appliedOperations
            .filter(operation => operation.requestId === requestId)
            .map(operation => ({ grant, operation })),
        ),
    );
    if (replayCandidates.length > 0) {
      const replay = replayCandidates.length === 1 ? replayCandidates[0] : undefined;
      if (replay === undefined || !isExactRelinquishReplay(replay.operation, replay.grant, command.member)) {
        throw new TaskBoardError('conflict', 'the membership relinquish request id was reused');
      }
      return { state, result: { relinquished: true, sessionId: replay.grant.sessionId, sessionStopped: false } };
    }
    const authorization = this.authorization.authorize(state, sessions, command.member, 'membership_relinquish');
    const board = requireBoard(state, authorization.boardId);
    const grant = board.grants.find(candidate => candidate.id === authorization.grantId);
    const fingerprint = taskBoardFingerprint([
      'membership.relinquish',
      authorization.grantId,
      authorization.runtimeGeneration,
    ]);
    const replay = board.appliedOperations.find(operation => operation.requestId === requestId);
    if (replay !== undefined) {
      if (grant === undefined || !isExactRelinquishReplay(replay, grant, command.member))
        throw new TaskBoardError('conflict', 'the membership relinquish request id was reused');
      return { state, result: { relinquished: true, sessionId: authorization.sessionId, sessionStopped: false } };
    }
    const verifiedReplacement = board.invitations.find(
      invitation =>
        invitation.status === 'accepted' &&
        invitation.sourceSessionId === authorization.sessionId &&
        invitation.verifiedAt !== undefined &&
        invitation.verifiedBySessionId === invitation.targetSessionId &&
        invitation.grantId !== undefined &&
        board.grants.some(
          candidate =>
            candidate.id === invitation.grantId &&
            candidate.active &&
            candidate.role === 'top_agent' &&
            candidate.sessionId === invitation.targetSessionId &&
            candidate.membershipRootSessionId === candidate.sessionId,
        ),
    );
    if (
      grant === undefined ||
      grant.role !== 'top_agent' ||
      grant.membershipRootSessionId !== grant.sessionId ||
      verifiedReplacement === undefined
    ) {
      throw new TaskBoardError(
        'forbidden',
        'only a membership root with a verified accepted replacement root may relinquish access',
      );
    }
    const boardEpoch = board.boardEpoch + 1;
    const revokedIds = new Set(
      board.grants
        .filter(candidate => candidate.active && candidate.membershipRootSessionId === grant.sessionId)
        .map(candidate => candidate.id),
    );
    const currentCoordinator = board.grants.find(candidate => candidate.id === board.coordinatorGrantId);
    const revokesCurrentCoordinator =
      currentCoordinator !== undefined &&
      isCurrentCoordinator(board, currentCoordinator) &&
      revokedIds.has(currentCoordinator.id);
    const survivingLiveRoot = board.grants.find(candidate => {
      if (revokedIds.has(candidate.id)) return false;
      return (
        liveMembershipRootGrant({
          board,
          bindings: state.bindings,
          sessions,
          sessionId: candidate.sessionId,
        })?.id === candidate.id
      );
    });
    if (revokesCurrentCoordinator && survivingLiveRoot !== undefined) {
      throw new TaskBoardError(
        'forbidden',
        'move the coordinator into a surviving membership tree first, before relinquishing this one',
      );
    }
    /**
     * Every session this tree ever held, not merely the ones still active. A coordinator replaced one
     * phase earlier is already revoked by the time the old root relinquishes, and it is precisely the
     * session whose tasks a reader is most likely to want afterwards; retiring only the live grants
     * would drop it.
     */
    const retiredSessionIds = withRetiredSessions(board.retiredSessionIds, [
      grant.sessionId,
      ...board.grants
        .filter(candidate => candidate.membershipRootSessionId === grant.sessionId)
        .map(candidate => candidate.sessionId),
    ]);
    const grants = board.grants.map(candidate => {
      if (revokedIds.has(candidate.id))
        return {
          ...candidate,
          active: false,
          revokedAt: command.at,
          revokedBySessionId: authorization.sessionId,
          revokeReason: 'membership relinquished',
        };
      return candidate.active ? { ...candidate, boardEpoch, coordinatorEpoch: board.coordinatorEpoch } : candidate;
    });
    let updated: TaskBoard = {
      ...board,
      boardEpoch,
      mutationGeneration: board.mutationGeneration + 1,
      grants,
      retiredSessionIds,
      appliedOperations: [
        ...board.appliedOperations,
        {
          requestId,
          kind: 'membership.relinquish',
          fingerprint,
          actorSessionId: authorization.sessionId,
          actorGrantId: authorization.grantId,
          actorRuntimeGeneration: authorization.runtimeGeneration,
          resultSessionId: authorization.sessionId,
          appliedAt: command.at,
        },
      ],
    };
    updated = appendTaskBoardAudit(updated, {
      at: command.at,
      event: 'membership.relinquished',
      requestId,
      actorSessionId: authorization.sessionId,
      outcome: 'applied',
      detail: { revokedGrantCount: revokedIds.size, retiredSessionCount: retiredSessionIds.length },
    });
    return {
      state: replaceTaskBoard(state, updated, {
        bindings: refreshBindings(state.bindings, grants, updated, command.at),
      }),
      result: { relinquished: true, sessionId: authorization.sessionId, sessionStopped: false },
    };
  }

  replaceCoordinator(
    state: TaskBoardRepositoryState,
    sessions: readonly TaskBoardSession[],
    command: ReplaceCoordinatorCommand,
    material: ReplaceCoordinatorMaterial,
  ): TaskBoardMutation<CoordinatorReplacementResult> {
    const requestId = requireTaskBoardRequestId(command.requestId);
    const board = requireBoard(state, command.boardId);
    /**
     * The authority is the PRINCIPAL, re-checked here rather than trusted from the caller. A member's
     * authorization can never satisfy this: it carries a session id and one of the member roles, and
     * both are wrong here. That is what stops a board capability — including a root's — from reaching
     * the one operation that could hand the board's approval key to another tree.
     */
    const administrator = command.administrator;
    if (
      (administrator.role !== 'human_admin' && administrator.role !== 'daemon') ||
      administrator.sessionId !== null ||
      administrator.runtimeGeneration !== null ||
      administrator.boardId !== board.id
    ) {
      throw new TaskBoardError('forbidden', 'coordinator replacement requires the board operator principal');
    }
    const replacement = requireTaskBoardSession(sessions, command.coordinatorSessionId);
    const fingerprint = taskBoardFingerprint([
      'coordinator.replace',
      board.id,
      command.memberSessionId,
      administrator.role,
      replacement.id,
      command.replacementRootSessionId,
      replacement.incarnation,
      replacement.runtimeGeneration,
    ]);
    const replay = board.appliedOperations.find(operation => operation.requestId === requestId);
    if (replay !== undefined) {
      if (replay.fingerprint !== fingerprint || replay.resultGrantId === undefined)
        throw new TaskBoardError('conflict', 'the coordinator replacement request id was reused');
      const grant = board.grants.find(candidate => candidate.id === replay.resultGrantId);
      if (grant === undefined || !grant.active)
        throw new TaskBoardError('unavailable', 'the coordinator replacement has no active grant');
      if (grant.capabilityHash !== material.capability.hash) {
        throw new TaskBoardError('unavailable', 'the recorded coordinator capability can no longer be recovered');
      }
      return { state, result: { replaced: true, membership: membershipForGrant(grant) } };
    }
    const lineage = sessionLineage(sessions, replacement.id);
    /**
     * The tree the new coordinator is re-homed into must be LIVE, not merely un-revoked: its root has
     * to resolve to a running session at the grant's exact incarnation and runtime generation, and to
     * still hold a current binding. A root grant outlives the pane it was written for, and a
     * coordinator rooted in a tree that has already stopped is a board whose only approval key belongs
     * to nobody. Every live root in the ancestry is collected: silently choosing the nearest would make
     * the stated exactly-one boundary false and make later retirement depend on an implicit tie-break.
     */
    const roots =
      lineage === null
        ? []
        : lineage
            .slice(1)
            .map(ancestor =>
              liveMembershipRootGrant({ board, bindings: state.bindings, sessions, sessionId: ancestor }),
            )
            .filter((candidate): candidate is TaskBoardGrant => candidate !== null);
    const root: TaskBoardGrant | null = roots.length === 1 ? (roots[0] ?? null) : null;
    const replacementBinding = state.bindings.find(binding => binding.sessionId === replacement.id);
    const replacementGrant =
      replacementBinding === undefined
        ? undefined
        : board.grants.find(candidate => candidate.id === replacementBinding.grantId);
    /**
     * A handover grants the coordinator descendant BEFORE its first launch. Replacement promotes that
     * exact child capability into a fresh coordinator grant: the old grant remains as revoked history,
     * while the already-running pane keeps one byte-identical secret that gains coordinator authority
     * atomically. An arbitrary existing membership is never silently elevated.
     */
    const promotion =
      replacementBinding !== undefined &&
      replacementGrant !== undefined &&
      replacementBinding.boardId === board.id &&
      replacementBinding.grantId === replacementGrant.id &&
      replacementBinding.sessionId === replacement.id &&
      replacementBinding.sessionIncarnation === replacement.incarnation &&
      replacementBinding.runtimeGeneration === replacement.runtimeGeneration &&
      replacementBinding.role === 'coordinator' &&
      sameTaskBoardActions(replacementBinding.allowedActions, actionsForTaskBoardRole('coordinator')) &&
      replacementBinding.boardEpoch === board.boardEpoch &&
      replacementBinding.coordinatorEpoch === board.coordinatorEpoch &&
      replacementBinding.capability === material.capability.value &&
      replacementGrant.active &&
      replacementGrant.sessionId === replacement.id &&
      replacementGrant.sessionIncarnation === replacement.incarnation &&
      replacementGrant.runtimeGeneration === replacement.runtimeGeneration &&
      replacementGrant.parentSessionId === replacement.parentSessionId &&
      replacementGrant.role === 'coordinator' &&
      sameTaskBoardActions(replacementGrant.allowedActions, actionsForTaskBoardRole('coordinator')) &&
      replacementGrant.membershipRootSessionId === command.replacementRootSessionId &&
      replacementGrant.boardEpoch === board.boardEpoch &&
      replacementGrant.coordinatorEpoch === board.coordinatorEpoch &&
      replacementGrant.capabilityHash === material.capability.hash &&
      isGrantWithinActiveMembershipTree(board, replacementGrant, sessions)
        ? replacementGrant
        : null;
    if (
      !replacement.active ||
      replacement.parentSessionId === null ||
      lineage === null ||
      root === null ||
      root.sessionId !== command.replacementRootSessionId ||
      (replacementBinding !== undefined && promotion === null)
    ) {
      throw new TaskBoardError(
        'forbidden',
        'the replacement coordinator must belong to exactly one expected live membership root and be unbound or hold its current coordinator child grant',
      );
    }
    const previous = board.grants.find(candidate => candidate.id === board.coordinatorGrantId);
    if (previous === undefined || !isCurrentCoordinator(board, previous))
      throw new TaskBoardError('unavailable', 'the board has no current coordinator to replace');
    if (
      board.grants.some(
        grant =>
          grant.id === material.grantId ||
          (grant.capabilityHash === material.capability.hash && grant.id !== promotion?.id),
      )
    )
      throw new TaskBoardError('conflict', 'the replacement coordinator material is already in use');
    const boardEpoch = board.boardEpoch + 1;
    const coordinatorEpoch = board.coordinatorEpoch + 1;
    const coordinator: TaskBoardGrant = {
      id: material.grantId,
      capabilityHash: material.capability.hash,
      sessionId: replacement.id,
      sessionIncarnation: replacement.incarnation,
      runtimeGeneration: replacement.runtimeGeneration,
      role: 'coordinator',
      allowedActions: CURRENT_COORDINATOR_ACTIONS,
      membershipRootSessionId: root.sessionId,
      parentSessionId: replacement.parentSessionId,
      boardEpoch,
      coordinatorEpoch,
      active: true,
      grantedAt: command.at,
      grantedBySessionId: null,
    };
    const grants = [
      ...board.grants.map(candidate =>
        candidate.id === previous.id || candidate.id === promotion?.id
          ? {
              ...candidate,
              active: false,
              revokedAt: command.at,
              revokedBySessionId: null,
              revokeReason: candidate.id === previous.id ? 'coordinator replaced' : CHILD_GRANT_PROMOTION_REVOKE_REASON,
            }
          : candidate.active
            ? { ...candidate, boardEpoch, coordinatorEpoch }
            : candidate,
      ),
      coordinator,
    ];
    const refusedIntents = board.childGrantIntents.map(intent =>
      intent.status === 'pending'
        ? { ...intent, status: 'refused' as const, refusalReason: 'coordinator replaced before approval' }
        : intent,
    );
    const refusedInvitations = board.invitations.map(invitation =>
      invitation.status === 'pending' || invitation.status === 'approved'
        ? { ...invitation, status: 'refused' as const, refusalReason: 'coordinator replaced before approval' }
        : invitation,
    );
    let updated: TaskBoard = {
      ...board,
      coordinatorSessionId: replacement.id,
      coordinatorGrantId: coordinator.id,
      boardEpoch,
      coordinatorEpoch,
      mutationGeneration: board.mutationGeneration + 1,
      grants,
      childGrantIntents: refusedIntents,
      invitations: refusedInvitations,
      /**
       * The outgoing coordinator retires in the SAME write that revokes it. Doing it here rather than
       * leaving it to the later relinquish is the whole point: between the two there is otherwise an
       * interval in which the old coordinator holds no binding and appears on no board, and its tasks
       * are addressable by nobody.
       */
      retiredSessionIds: withRetiredSessions(board.retiredSessionIds, [previous.sessionId]),
      appliedOperations: [
        ...board.appliedOperations,
        {
          requestId,
          kind: 'coordinator.replace',
          fingerprint,
          /**
           * The operator is not a session and gets no session's name. `actorGrantId` carries the
           * principal's own id rather than the root's: the root did not decide this, it is only where
           * the new coordinator was re-homed.
           */
          actorSessionId: null,
          actorGrantId: administrator.grantId,
          actorRuntimeGeneration: null,
          resultGrantId: coordinator.id,
          resultSessionId: replacement.id,
          appliedAt: command.at,
        },
      ],
    };
    updated = appendTaskBoardAudit(updated, {
      at: command.at,
      event: 'coordinator.replaced',
      requestId,
      actorSessionId: null,
      actorName: administrator.role === 'human_admin' ? TASK_BOARD_OPERATOR_ACTOR_NAME : 'daemon',
      outcome: 'applied',
      detail: { coordinatorSessionId: replacement.id, membershipRootSessionId: root.sessionId },
    });
    return {
      state: replaceTaskBoard(state, updated, {
        bindings: [
          ...refreshBindings(state.bindings, grants, updated, command.at),
          bindingForGrant(updated, coordinator, material.capability.value, command.at),
        ],
        invitationProofs: state.invitationProofs.filter(
          proof =>
            !refusedInvitations.some(
              invitation => invitation.requestId === proof.invitationRequestId && invitation.status === 'refused',
            ),
        ),
      }),
      result: { replaced: true, membership: membershipForGrant(coordinator) },
    };
  }
}
