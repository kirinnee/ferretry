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
  CURRENT_COORDINATOR_ACTIONS,
  isCurrentCoordinator,
  liveMembershipRootGrant,
  sessionLineage,
} from './policy.ts';
import type {
  TaskBoard,
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
  /**
   * The principal taking the coordinator's authority away. It is a non-session principal by
   * construction: the operator holds the board admin capability, and no member of a board — not even a
   * membership root — may re-appoint the coordinator that governs it.
   */
  readonly administrator: TaskBoardAuthorization;
  /** The unbound live descendant of a live membership root which becomes the new coordinator. */
  readonly coordinatorSessionId: string;
  readonly requestId: string;
  readonly at: string;
}

export interface ReplaceCoordinatorMaterial {
  readonly grantId: string;
  readonly capability: TaskBoardSecret;
}

export type CoordinatorReplacementResult = { readonly replaced: true; readonly membership: TaskBoardMembership };

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
      if (replay.fingerprint !== fingerprint || replay.resultSessionId !== authorization.sessionId)
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
      administrator.role,
      replacement.id,
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
      return { state, result: { replaced: true, membership: membershipForGrant(grant) } };
    }
    const lineage = sessionLineage(sessions, replacement.id);
    /**
     * The tree the new coordinator is re-homed into must be LIVE, not merely un-revoked: its root has
     * to resolve to a running session at the grant's exact incarnation and runtime generation, and to
     * still hold a current binding. A root grant outlives the pane it was written for, and a
     * coordinator rooted in a tree that has already stopped is a board whose only approval key belongs
     * to nobody. During a two-root handover this is also what puts the key in the surviving tree: name
     * a descendant of the retiring root and the relinquish that follows revokes it.
     */
    const root =
      lineage === null
        ? null
        : (lineage
            .slice(1)
            .map(ancestor =>
              liveMembershipRootGrant({ board, bindings: state.bindings, sessions, sessionId: ancestor }),
            )
            .find(candidate => candidate !== null) ?? null);
    if (
      !replacement.active ||
      replacement.parentSessionId === null ||
      lineage === null ||
      root === null ||
      state.bindings.some(binding => binding.sessionId === replacement.id)
    ) {
      throw new TaskBoardError(
        'forbidden',
        'the replacement coordinator must be an unbound live descendant of exactly one live membership root',
      );
    }
    const previous = board.grants.find(candidate => candidate.id === board.coordinatorGrantId);
    if (previous === undefined || !isCurrentCoordinator(board, previous))
      throw new TaskBoardError('unavailable', 'the board has no current coordinator to replace');
    if (board.grants.some(grant => grant.id === material.grantId || grant.capabilityHash === material.capability.hash))
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
        candidate.id === previous.id
          ? {
              ...candidate,
              active: false,
              revokedAt: command.at,
              revokedBySessionId: null,
              revokeReason: 'coordinator replaced',
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
