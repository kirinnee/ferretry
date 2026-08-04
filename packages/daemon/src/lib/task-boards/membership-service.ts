import type { TaskBoardMembership, TaskBoardRelinquishResponse } from '@ferretry/protocol';
import type { TaskBoardAuthorizationService } from './authorization-service.ts';
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
import { CURRENT_COORDINATOR_ACTIONS, isCurrentCoordinator, sessionLineage } from './policy.ts';
import type {
  TaskBoard,
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
  readonly administratorSessionId: string;
  readonly replacementSessionId: string;
  readonly requestId: string;
  readonly at: string;
}

export interface ReplaceCoordinatorMaterial {
  readonly grantId: string;
  readonly capability: TaskBoardSecret;
}

export type CoordinatorReplacementResult = { readonly replaced: true; readonly membership: TaskBoardMembership };

export type TaskBoardAdministrator = (boardId: string, sessionId: string) => boolean;

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
  constructor(
    private readonly authorization: TaskBoardAuthorizationService,
    private readonly canAdminister: TaskBoardAdministrator,
  ) {}

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
      detail: { revokedGrantCount: revokedIds.size },
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
    if (!this.canAdminister(board.id, command.administratorSessionId))
      throw new TaskBoardError('forbidden', 'coordinator replacement requires explicit board administrator authority');
    const replacement = requireTaskBoardSession(sessions, command.replacementSessionId);
    const fingerprint = taskBoardFingerprint([
      'coordinator.replace',
      board.id,
      command.administratorSessionId,
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
    const roots = board.grants.filter(
      candidate =>
        candidate.active && candidate.role === 'top_agent' && candidate.membershipRootSessionId === candidate.sessionId,
    );
    const root = lineage === null ? undefined : roots.find(candidate => lineage.slice(1).includes(candidate.sessionId));
    if (
      !replacement.active ||
      replacement.parentSessionId === null ||
      lineage === null ||
      root === undefined ||
      state.bindings.some(binding => binding.sessionId === replacement.id)
    ) {
      throw new TaskBoardError(
        'forbidden',
        'the replacement coordinator must be an unbound live descendant of exactly one membership root',
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
      grantedBySessionId: command.administratorSessionId,
    };
    const grants = [
      ...board.grants.map(candidate =>
        candidate.id === previous.id
          ? {
              ...candidate,
              active: false,
              revokedAt: command.at,
              revokedBySessionId: command.administratorSessionId,
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
      appliedOperations: [
        ...board.appliedOperations,
        {
          requestId,
          kind: 'coordinator.replace',
          fingerprint,
          actorSessionId: command.administratorSessionId,
          actorGrantId: null,
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
      actorSessionId: command.administratorSessionId,
      outcome: 'applied',
      detail: { replacementSessionId: replacement.id },
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
