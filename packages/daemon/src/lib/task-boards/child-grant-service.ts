import type { TaskBoardChildAccess, TaskBoardGrantRequestView, TaskBoardMembership } from '@ferretry/protocol';
import { TaskBoardAuthorizationService } from './authorization-service.ts';
import {
  appendTaskBoardAudit,
  bindingForGrant,
  membershipForGrant,
  replaceTaskBoard,
  requireTaskBoardRequestId,
  requireTaskBoardSession,
  sameTaskBoardStrings,
  taskBoardFingerprint,
  taskBoardIntentExpiry,
} from './domain-helpers.ts';
import { TaskBoardError } from './error.ts';
import {
  actionsForTaskBoardRole,
  isCurrentCoordinator,
  isGrantWithinActiveMembershipTree,
  sameTaskBoardActions,
  sessionLineage,
} from './policy.ts';
import type {
  TaskBoard,
  TaskBoardChildGrantIntent,
  TaskBoardCredential,
  TaskBoardGrant,
  TaskBoardMutation,
  TaskBoardRepositoryState,
  TaskBoardSecret,
  TaskBoardSession,
} from './types.ts';

export interface RequestChildGrantCommand {
  readonly source: TaskBoardCredential;
  readonly targetSessionId: string;
  readonly role: TaskBoardChildAccess;
  readonly requestId: string;
  readonly at: string;
}

export interface ApproveChildGrantCommand {
  readonly coordinator: TaskBoardCredential;
  readonly grantRequestId: string;
  readonly requestId: string;
  readonly at: string;
}

export interface ApproveChildGrantMaterial {
  readonly grantId: string;
  readonly capability: TaskBoardSecret;
}

export type ApproveChildGrantResult =
  | { readonly approved: true; readonly membership: TaskBoardMembership }
  | { readonly approved: false; readonly request: TaskBoardGrantRequestView };

function childGrantView(intent: TaskBoardChildGrantIntent): TaskBoardGrantRequestView {
  const common = {
    requestId: intent.requestId,
    targetSessionId: intent.targetSessionId,
    requestedRole: intent.requestedRole,
    createdAt: intent.createdAt,
    expiresAt: intent.expiresAt,
  };
  if (intent.status === 'refused') {
    return { ...common, status: 'refused', refusalReason: intent.refusalReason ?? 'refused' };
  }
  return { ...common, status: intent.status };
}

function requireBoard(state: TaskBoardRepositoryState, boardId: string): TaskBoard {
  const board = state.boards.find(candidate => candidate.id === boardId);
  if (board === undefined) throw new TaskBoardError('unavailable', 'the authoritative task board is unavailable');
  return board;
}

function requireCoordinator(
  board: TaskBoard,
  sessions: readonly TaskBoardSession[],
): { readonly grant: TaskBoardGrant; readonly session: TaskBoardSession; readonly lineage: readonly string[] } {
  const grant = board.grants.find(candidate => candidate.id === board.coordinatorGrantId);
  const session = grant === undefined ? null : (sessions.find(candidate => candidate.id === grant.sessionId) ?? null);
  const lineage = session === null ? null : sessionLineage(sessions, session.id);
  if (
    grant === undefined ||
    session === null ||
    lineage === null ||
    !session.active ||
    !isCurrentCoordinator(board, grant) ||
    !isGrantWithinActiveMembershipTree(board, grant, sessions)
  ) {
    throw new TaskBoardError('unavailable', 'the board has no exact live current coordinator');
  }
  return { grant, session, lineage };
}

export class TaskBoardChildGrantService {
  constructor(private readonly authorization: TaskBoardAuthorizationService) {}

  request(
    state: TaskBoardRepositoryState,
    sessions: readonly TaskBoardSession[],
    command: RequestChildGrantCommand,
  ): TaskBoardMutation<TaskBoardGrantRequestView> {
    const requestId = requireTaskBoardRequestId(command.requestId);
    const authorization = this.authorization.authorize(state, sessions, command.source, 'grant_request');
    const board = requireBoard(state, authorization.boardId);
    const sourceGrant = board.grants.find(candidate => candidate.id === authorization.grantId);
    const source = requireTaskBoardSession(sessions, authorization.sessionId);
    if (
      sourceGrant === undefined ||
      sourceGrant.role !== 'top_agent' ||
      sourceGrant.membershipRootSessionId !== source.id ||
      source.parentSessionId !== null ||
      source.mode !== 'interactive' ||
      !source.active
    ) {
      throw new TaskBoardError('forbidden', 'only a live interactive membership root may request child access');
    }
    const target = requireTaskBoardSession(sessions, command.targetSessionId);
    const targetLineage = sessionLineage(sessions, target.id);
    if (
      !target.active ||
      target.parentSessionId === null ||
      targetLineage === null ||
      !targetLineage.slice(1).includes(source.id)
    ) {
      throw new TaskBoardError('forbidden', 'the target is not a live descendant of the membership root');
    }
    if (state.bindings.some(binding => binding.sessionId === target.id)) {
      throw new TaskBoardError('conflict', 'the target session already has task-board membership');
    }
    const coordinator = requireCoordinator(board, sessions);
    const allowedActions = actionsForTaskBoardRole(command.role);
    const fingerprint = taskBoardFingerprint([
      'child-grant.request',
      board.id,
      board.boardEpoch,
      sourceGrant.id,
      source.id,
      source.incarnation,
      source.runtimeGeneration,
      target.id,
      target.incarnation,
      target.runtimeGeneration,
      ...targetLineage,
      command.role,
      coordinator.grant.id,
      coordinator.session.incarnation,
      coordinator.session.runtimeGeneration,
      board.coordinatorEpoch,
    ]);
    const replay = board.childGrantIntents.find(candidate => candidate.requestId === requestId);
    if (replay !== undefined) {
      if (replay.fingerprint !== fingerprint) {
        throw new TaskBoardError('conflict', 'the child-grant request id was reused with another payload');
      }
      return { state, result: childGrantView(replay) };
    }
    const intent: TaskBoardChildGrantIntent = {
      requestId,
      fingerprint,
      boardEpoch: board.boardEpoch,
      sourceGrantId: sourceGrant.id,
      sourceSessionId: source.id,
      sourceSessionIncarnation: source.incarnation,
      sourceRuntimeGeneration: source.runtimeGeneration,
      membershipRootSessionId: source.id,
      targetSessionId: target.id,
      targetSessionIncarnation: target.incarnation,
      targetRuntimeGeneration: target.runtimeGeneration,
      targetLineage,
      requestedRole: command.role,
      allowedActions,
      coordinatorGrantId: coordinator.grant.id,
      coordinatorSessionId: coordinator.session.id,
      coordinatorSessionIncarnation: coordinator.session.incarnation,
      coordinatorRuntimeGeneration: coordinator.session.runtimeGeneration,
      coordinatorLineage: coordinator.lineage,
      coordinatorEpoch: board.coordinatorEpoch,
      createdAt: command.at,
      expiresAt: taskBoardIntentExpiry(command.at),
      status: 'pending',
    };
    const updated = appendTaskBoardAudit(
      {
        ...board,
        mutationGeneration: board.mutationGeneration + 1,
        childGrantIntents: [...board.childGrantIntents, intent],
      },
      {
        at: command.at,
        event: 'grant.requested',
        requestId,
        actorSessionId: source.id,
        outcome: 'applied',
        detail: { targetSessionId: target.id, requestedRole: command.role },
      },
    );
    return { state: replaceTaskBoard(state, updated), result: childGrantView(intent) };
  }

  approve(
    state: TaskBoardRepositoryState,
    sessions: readonly TaskBoardSession[],
    command: ApproveChildGrantCommand,
    material: ApproveChildGrantMaterial,
  ): TaskBoardMutation<ApproveChildGrantResult> {
    const requestId = requireTaskBoardRequestId(command.requestId);
    const authorization = this.authorization.authorize(state, sessions, command.coordinator, 'grant_approve');
    const board = requireBoard(state, authorization.boardId);
    const currentCoordinator = requireCoordinator(board, sessions);
    if (currentCoordinator.grant.id !== authorization.grantId) {
      throw new TaskBoardError('forbidden', 'only the exact current coordinator may approve a child grant');
    }
    const intent = board.childGrantIntents.find(candidate => candidate.requestId === command.grantRequestId);
    if (intent === undefined) throw new TaskBoardError('not-found', 'the child-grant request was not found');
    const fingerprint = taskBoardFingerprint([
      'child-grant.approve',
      intent.requestId,
      authorization.grantId,
      authorization.runtimeGeneration,
    ]);
    const replay = board.appliedOperations.find(candidate => candidate.requestId === requestId);
    if (replay !== undefined)
      return this.replayApproval(state, board, replay.fingerprint, fingerprint, replay.resultGrantId);
    if (intent.status !== 'pending') throw new TaskBoardError('conflict', 'the child-grant request is not pending');
    if (Date.parse(command.at) >= Date.parse(intent.expiresAt)) {
      const expired = { ...intent, status: 'expired' as const };
      const updated = appendTaskBoardAudit(
        {
          ...board,
          mutationGeneration: board.mutationGeneration + 1,
          childGrantIntents: board.childGrantIntents.map(candidate =>
            candidate.requestId === intent.requestId ? expired : candidate,
          ),
        },
        {
          at: command.at,
          event: 'grant.expired',
          requestId,
          actorSessionId: authorization.sessionId,
          outcome: 'denied',
          detail: { grantRequestId: intent.requestId },
        },
      );
      return { state: replaceTaskBoard(state, updated), result: { approved: false, request: childGrantView(expired) } };
    }
    const sourceGrant = board.grants.find(candidate => candidate.id === intent.sourceGrantId);
    const source = requireTaskBoardSession(sessions, intent.sourceSessionId);
    const target = requireTaskBoardSession(sessions, intent.targetSessionId);
    const targetLineage = sessionLineage(sessions, target.id);
    if (
      sourceGrant === undefined ||
      !sourceGrant.active ||
      !isGrantWithinActiveMembershipTree(board, sourceGrant, sessions) ||
      sourceGrant.role !== 'top_agent' ||
      sourceGrant.membershipRootSessionId !== source.id ||
      source.incarnation !== intent.sourceSessionIncarnation ||
      source.runtimeGeneration !== intent.sourceRuntimeGeneration ||
      !source.active ||
      target.incarnation !== intent.targetSessionIncarnation ||
      target.runtimeGeneration !== intent.targetRuntimeGeneration ||
      !target.active ||
      targetLineage === null ||
      !sameTaskBoardStrings(targetLineage, intent.targetLineage) ||
      state.bindings.some(binding => binding.sessionId === target.id) ||
      intent.boardEpoch !== board.boardEpoch ||
      intent.coordinatorEpoch !== board.coordinatorEpoch ||
      intent.coordinatorGrantId !== currentCoordinator.grant.id ||
      intent.coordinatorSessionId !== currentCoordinator.session.id ||
      intent.coordinatorSessionIncarnation !== currentCoordinator.session.incarnation ||
      intent.coordinatorRuntimeGeneration !== currentCoordinator.session.runtimeGeneration ||
      !sameTaskBoardStrings(intent.coordinatorLineage, currentCoordinator.lineage) ||
      !sameTaskBoardActions(intent.allowedActions, actionsForTaskBoardRole(intent.requestedRole))
    ) {
      throw new TaskBoardError('forbidden', 'the child-grant authority or captured session lineage changed');
    }
    if (
      board.grants.some(grant => grant.id === material.grantId) ||
      board.grants.some(grant => grant.capabilityHash === material.capability.hash)
    ) {
      throw new TaskBoardError('conflict', 'the child-grant material is already in use');
    }
    const grant: TaskBoardGrant = {
      id: material.grantId,
      capabilityHash: material.capability.hash,
      sessionId: target.id,
      sessionIncarnation: target.incarnation,
      runtimeGeneration: target.runtimeGeneration,
      role: intent.requestedRole,
      allowedActions: [...intent.allowedActions],
      membershipRootSessionId: intent.membershipRootSessionId,
      parentSessionId: target.parentSessionId,
      boardEpoch: board.boardEpoch,
      coordinatorEpoch: board.coordinatorEpoch,
      active: true,
      grantedAt: command.at,
      grantedBySessionId: authorization.sessionId,
    };
    const approved = {
      ...intent,
      status: 'approved' as const,
      approvedAt: command.at,
      approvedBySessionId: authorization.sessionId,
      grantId: grant.id,
    };
    let updated: TaskBoard = {
      ...board,
      mutationGeneration: board.mutationGeneration + 1,
      grants: [...board.grants, grant],
      childGrantIntents: board.childGrantIntents.map(candidate =>
        candidate.requestId === intent.requestId ? approved : candidate,
      ),
      appliedOperations: [
        ...board.appliedOperations,
        {
          requestId,
          kind: 'child-grant.approve' as const,
          fingerprint,
          actorSessionId: authorization.sessionId,
          actorGrantId: authorization.grantId,
          actorRuntimeGeneration: authorization.runtimeGeneration,
          resultGrantId: grant.id,
          resultSessionId: target.id,
          appliedAt: command.at,
        },
      ],
    };
    updated = appendTaskBoardAudit(updated, {
      at: command.at,
      event: 'grant.approved',
      requestId,
      actorSessionId: authorization.sessionId,
      outcome: 'applied',
      detail: { grantRequestId: intent.requestId, targetSessionId: target.id, role: grant.role },
    });
    const nextState = replaceTaskBoard(state, updated, {
      bindings: [...state.bindings, bindingForGrant(updated, grant, material.capability.value, command.at)],
    });
    return { state: nextState, result: { approved: true, membership: membershipForGrant(grant) } };
  }

  private replayApproval(
    state: TaskBoardRepositoryState,
    board: TaskBoard,
    storedFingerprint: string,
    fingerprint: string,
    resultGrantId: string | undefined,
  ): TaskBoardMutation<ApproveChildGrantResult> {
    if (storedFingerprint !== fingerprint || resultGrantId === undefined) {
      throw new TaskBoardError('conflict', 'the child-grant approval request id was reused');
    }
    const grant = board.grants.find(candidate => candidate.id === resultGrantId);
    const binding = state.bindings.find(candidate => candidate.grantId === resultGrantId);
    if (grant === undefined || binding === undefined || !grant.active) {
      throw new TaskBoardError('unavailable', 'the approved child grant has no durable binding');
    }
    return { state, result: { approved: true, membership: membershipForGrant(grant) } };
  }
}
