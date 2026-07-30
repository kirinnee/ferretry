import type { TaskBoardInvitationView, TaskBoardMembership } from '@ferretry/protocol';
import { TaskBoardAuthorizationService } from './authorization-service.ts';
import {
  appendTaskBoardAudit,
  bindingForGrant,
  membershipForGrant,
  replaceTaskBoard,
  requireTaskBoardRequestId,
  requireTaskBoardSession,
  taskBoardFingerprint,
  taskBoardIntentExpiry,
} from './domain-helpers.ts';
import { TaskBoardError } from './error.ts';
import {
  actionsForTaskBoardRole,
  hasExplicitInvitationAuthority,
  isCurrentCoordinator,
  isInvitationProofBoundToSession,
  isInvitationProofUnexpired,
} from './policy.ts';
import type {
  TaskBoard,
  TaskBoardCredential,
  TaskBoardGrant,
  TaskBoardInvitation,
  TaskBoardInvitationProof,
  TaskBoardMutation,
  TaskBoardRepositoryState,
  TaskBoardSecret,
  TaskBoardSession,
} from './types.ts';

export interface RequestExternalInvitationCommand {
  readonly source: TaskBoardCredential;
  readonly targetSessionId: string;
  readonly requestId: string;
  readonly at: string;
}

export interface ApproveExternalInvitationCommand {
  readonly coordinator: TaskBoardCredential;
  readonly invitationRequestId: string;
  readonly requestId: string;
  readonly at: string;
}

export interface AcceptExternalInvitationCommand {
  readonly target: TaskBoardCredential;
  readonly invitationCapability: string;
  readonly requestId: string;
  readonly at: string;
}

export interface ApproveExternalInvitationMaterial {
  readonly acceptanceCapability: TaskBoardSecret;
}

export interface AcceptExternalInvitationMaterial {
  readonly grantId: string;
  readonly capability: TaskBoardSecret;
}

export type ApprovalResult =
  | { readonly approved: true; readonly invitation: TaskBoardInvitationView; readonly acceptanceCapability: string }
  | { readonly approved: false; readonly invitation: TaskBoardInvitationView };

export type AcceptanceResult =
  | { readonly accepted: true; readonly membership: TaskBoardMembership }
  | { readonly accepted: false; readonly invitation: TaskBoardInvitationView };

function invitationView(invitation: TaskBoardInvitation): TaskBoardInvitationView {
  const common = {
    requestId: invitation.requestId,
    sourceSessionId: invitation.sourceSessionId,
    targetSessionId: invitation.targetSessionId,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
  };
  return invitation.status === 'refused'
    ? { ...common, status: 'refused', refusalReason: invitation.refusalReason ?? 'refused' }
    : { ...common, status: invitation.status };
}

function requireBoard(state: TaskBoardRepositoryState, boardId: string): TaskBoard {
  const board = state.boards.find(candidate => candidate.id === boardId);
  if (board === undefined) throw new TaskBoardError('unavailable', 'the authoritative task board is unavailable');
  return board;
}

function requireCurrentCoordinator(board: TaskBoard, sessions: readonly TaskBoardSession[]): TaskBoardGrant {
  const grant = board.grants.find(candidate => candidate.id === board.coordinatorGrantId);
  const session = grant === undefined ? undefined : sessions.find(candidate => candidate.id === grant.sessionId);
  if (grant === undefined || session === undefined || !session.active || !isCurrentCoordinator(board, grant)) {
    throw new TaskBoardError('unavailable', 'the board has no exact live current coordinator');
  }
  return grant;
}

export class TaskBoardInvitationService {
  constructor(
    private readonly authorization: TaskBoardAuthorizationService,
    private readonly hashCapability: (capability: string) => string,
  ) {}

  request(
    state: TaskBoardRepositoryState,
    sessions: readonly TaskBoardSession[],
    command: RequestExternalInvitationCommand,
  ): TaskBoardMutation<TaskBoardInvitationView> {
    const requestId = requireTaskBoardRequestId(command.requestId);
    const authorization = this.authorization.authorize(state, sessions, command.source, 'invite_request');
    const board = requireBoard(state, authorization.boardId);
    const source = requireTaskBoardSession(sessions, authorization.sessionId);
    const target = requireTaskBoardSession(sessions, command.targetSessionId);
    const activeRoots = board.grants.filter(
      grant => grant.active && grant.role === 'top_agent' && grant.membershipRootSessionId === grant.sessionId,
    );
    if (
      !hasExplicitInvitationAuthority(board, authorization, 'request') ||
      activeRoots.length !== 1 ||
      source.mode !== 'interactive' ||
      source.parentSessionId !== null ||
      !source.active ||
      target.id === source.id ||
      target.mode !== 'interactive' ||
      target.parentSessionId !== null ||
      !target.active ||
      state.bindings.some(binding => binding.sessionId === target.id)
    ) {
      throw new TaskBoardError(
        'forbidden',
        'an external invitation requires the sole live interactive membership root and an unbound live top-level target',
      );
    }
    if (board.invitations.some(invitation => invitation.status === 'pending' || invitation.status === 'approved')) {
      throw new TaskBoardError('conflict', 'the board already has an outstanding external invitation');
    }
    const coordinator = requireCurrentCoordinator(board, sessions);
    const fingerprint = taskBoardFingerprint([
      'invitation.request',
      board.id,
      board.boardEpoch,
      authorization.grantId,
      target.id,
      target.incarnation,
      target.runtimeGeneration,
      coordinator.id,
      board.coordinatorEpoch,
    ]);
    const replay = board.invitations.find(invitation => invitation.requestId === requestId);
    if (replay !== undefined) {
      if (replay.fingerprint !== fingerprint)
        throw new TaskBoardError('conflict', 'the invitation request id was reused with another payload');
      return { state, result: invitationView(replay) };
    }
    const invitation: TaskBoardInvitation = {
      requestId,
      fingerprint,
      boardEpoch: board.boardEpoch,
      sourceGrantId: authorization.grantId,
      sourceSessionId: source.id,
      sourceSessionIncarnation: source.incarnation,
      sourceRuntimeGeneration: source.runtimeGeneration,
      targetSessionId: target.id,
      targetSessionIncarnation: target.incarnation,
      targetRuntimeGeneration: target.runtimeGeneration,
      coordinatorGrantId: coordinator.id,
      coordinatorSessionId: coordinator.sessionId,
      coordinatorSessionIncarnation: coordinator.sessionIncarnation,
      coordinatorRuntimeGeneration: coordinator.runtimeGeneration,
      coordinatorLineage: [coordinator.sessionId, source.id],
      coordinatorEpoch: board.coordinatorEpoch,
      createdAt: command.at,
      expiresAt: taskBoardIntentExpiry(command.at),
      status: 'pending',
    };
    const updated = appendTaskBoardAudit(
      { ...board, mutationGeneration: board.mutationGeneration + 1, invitations: [...board.invitations, invitation] },
      {
        at: command.at,
        event: 'invitation.requested',
        requestId,
        actorSessionId: source.id,
        outcome: 'applied',
        detail: { targetSessionId: target.id },
      },
    );
    return { state: replaceTaskBoard(state, updated), result: invitationView(invitation) };
  }

  approve(
    state: TaskBoardRepositoryState,
    sessions: readonly TaskBoardSession[],
    command: ApproveExternalInvitationCommand,
    material: ApproveExternalInvitationMaterial,
  ): TaskBoardMutation<ApprovalResult> {
    const requestId = requireTaskBoardRequestId(command.requestId);
    const authorization = this.authorization.authorize(state, sessions, command.coordinator, 'invite_approve');
    const board = requireBoard(state, authorization.boardId);
    const coordinator = requireCurrentCoordinator(board, sessions);
    const invitation = board.invitations.find(candidate => candidate.requestId === command.invitationRequestId);
    if (invitation === undefined) throw new TaskBoardError('not-found', 'the external invitation was not found');
    const fingerprint = taskBoardFingerprint([
      'invitation.approve',
      invitation.requestId,
      authorization.grantId,
      authorization.runtimeGeneration,
    ]);
    const replay = board.appliedOperations.find(operation => operation.requestId === requestId);
    if (replay !== undefined) {
      if (replay.fingerprint !== fingerprint || invitation.status !== 'approved')
        throw new TaskBoardError('conflict', 'the invitation approval request id was reused');
      const proof = state.invitationProofs.find(candidate => candidate.invitationRequestId === invitation.requestId);
      if (proof === undefined)
        throw new TaskBoardError('unavailable', 'the approved invitation has no acceptance proof');
      return {
        state,
        result: {
          approved: true,
          invitation: invitationView(invitation),
          acceptanceCapability: proof.invitationCapability,
        },
      };
    }
    if (!hasExplicitInvitationAuthority(board, authorization, 'approve') || coordinator.id !== authorization.grantId)
      throw new TaskBoardError('forbidden', 'only the exact current coordinator may approve an external invitation');
    if (invitation.status !== 'pending') throw new TaskBoardError('conflict', 'the external invitation is not pending');
    if (Date.parse(command.at) >= Date.parse(invitation.expiresAt)) {
      const expired = { ...invitation, status: 'expired' as const };
      const updated = appendTaskBoardAudit(
        {
          ...board,
          mutationGeneration: board.mutationGeneration + 1,
          invitations: board.invitations.map(candidate =>
            candidate.requestId === invitation.requestId ? expired : candidate,
          ),
        },
        {
          at: command.at,
          event: 'invitation.expired',
          requestId,
          actorSessionId: authorization.sessionId,
          outcome: 'denied',
          detail: { invitationRequestId: invitation.requestId },
        },
      );
      return {
        state: replaceTaskBoard(state, updated),
        result: { approved: false, invitation: invitationView(expired) },
      };
    }
    const target = requireTaskBoardSession(sessions, invitation.targetSessionId);
    if (
      !target.active ||
      target.mode !== 'interactive' ||
      target.parentSessionId !== null ||
      target.incarnation !== invitation.targetSessionIncarnation ||
      target.runtimeGeneration !== invitation.targetRuntimeGeneration ||
      invitation.boardEpoch !== board.boardEpoch ||
      invitation.coordinatorEpoch !== board.coordinatorEpoch ||
      invitation.coordinatorGrantId !== coordinator.id ||
      state.bindings.some(binding => binding.sessionId === target.id)
    )
      throw new TaskBoardError('forbidden', 'the invitation authority or target identity changed before approval');
    const approved = {
      ...invitation,
      status: 'approved' as const,
      approvedAt: command.at,
      approvedBySessionId: authorization.sessionId,
      acceptanceCapabilityHash: material.acceptanceCapability.hash,
    };
    const proof: TaskBoardInvitationProof = {
      boardId: board.id,
      invitationRequestId: invitation.requestId,
      targetSessionId: target.id,
      targetSessionIncarnation: target.incarnation,
      targetRuntimeGeneration: target.runtimeGeneration,
      sessionCapabilityHash: target.sessionCapabilityHash,
      invitationCapability: material.acceptanceCapability.value,
      invitationCapabilityHash: material.acceptanceCapability.hash,
      expiresAt: invitation.expiresAt,
    };
    const updated = appendTaskBoardAudit(
      {
        ...board,
        mutationGeneration: board.mutationGeneration + 1,
        invitations: board.invitations.map(candidate =>
          candidate.requestId === invitation.requestId ? approved : candidate,
        ),
        appliedOperations: [
          ...board.appliedOperations,
          {
            requestId,
            kind: 'invitation.approve',
            fingerprint,
            actorSessionId: authorization.sessionId,
            actorGrantId: authorization.grantId,
            actorRuntimeGeneration: authorization.runtimeGeneration,
            appliedAt: command.at,
          },
        ],
      },
      {
        at: command.at,
        event: 'invitation.approved',
        requestId,
        actorSessionId: authorization.sessionId,
        outcome: 'applied',
        detail: { invitationRequestId: invitation.requestId },
      },
    );
    return {
      state: replaceTaskBoard(state, updated, { invitationProofs: [...state.invitationProofs, proof] }),
      result: {
        approved: true,
        invitation: invitationView(approved),
        acceptanceCapability: material.acceptanceCapability.value,
      },
    };
  }

  accept(
    state: TaskBoardRepositoryState,
    sessions: readonly TaskBoardSession[],
    command: AcceptExternalInvitationCommand,
    material: AcceptExternalInvitationMaterial,
  ): TaskBoardMutation<AcceptanceResult> {
    const requestId = requireTaskBoardRequestId(command.requestId);
    const target = requireTaskBoardSession(sessions, command.target.sessionId);
    const invitation = state.boards
      .flatMap(board => board.invitations.map(candidate => ({ board, candidate })))
      .find(({ candidate }) => candidate.targetSessionId === target.id && candidate.status === 'approved');
    if (invitation === undefined)
      throw new TaskBoardError('forbidden', 'the session has no approved external invitation');
    const board = invitation.board;
    const fingerprint = taskBoardFingerprint([
      'invitation.accept',
      invitation.candidate.requestId,
      target.id,
      target.runtimeGeneration,
    ]);
    const replay = board.appliedOperations.find(operation => operation.requestId === requestId);
    if (replay !== undefined) {
      if (
        replay.fingerprint !== fingerprint ||
        invitation.candidate.status !== 'accepted' ||
        replay.resultGrantId === undefined
      )
        throw new TaskBoardError('conflict', 'the invitation acceptance request id was reused');
      const grant = board.grants.find(candidate => candidate.id === replay.resultGrantId);
      if (grant === undefined)
        throw new TaskBoardError('unavailable', 'the accepted invitation has no membership grant');
      return { state, result: { accepted: true, membership: membershipForGrant(grant) } };
    }
    const proof = state.invitationProofs.find(
      candidate => candidate.invitationRequestId === invitation.candidate.requestId,
    );
    if (
      proof === undefined ||
      !target.active ||
      target.mode !== 'interactive' ||
      target.parentSessionId !== null ||
      command.target.runtimeGeneration !== target.runtimeGeneration ||
      command.target.capabilityHash !== target.sessionCapabilityHash ||
      !isInvitationProofBoundToSession({
        proof,
        invitation: invitation.candidate,
        session: target,
        sessionCapabilityHash: command.target.capabilityHash,
        invitationCapabilityHash: this.hashCapability(command.invitationCapability),
      }) ||
      state.bindings.some(binding => binding.sessionId === target.id)
    )
      throw new TaskBoardError('forbidden', 'the invitation acceptance proof is not bound to this exact live session');
    if (!isInvitationProofUnexpired(proof, command.at)) {
      const expired = { ...invitation.candidate, status: 'expired' as const };
      const updated = appendTaskBoardAudit(
        {
          ...board,
          mutationGeneration: board.mutationGeneration + 1,
          invitations: board.invitations.map(candidate =>
            candidate.requestId === expired.requestId ? expired : candidate,
          ),
        },
        {
          at: command.at,
          event: 'invitation.expired',
          requestId,
          actorSessionId: target.id,
          outcome: 'denied',
          detail: { invitationRequestId: expired.requestId },
        },
      );
      return {
        state: replaceTaskBoard(state, updated, {
          invitationProofs: state.invitationProofs.filter(
            candidate => candidate.invitationRequestId !== expired.requestId,
          ),
        }),
        result: { accepted: false, invitation: invitationView(expired) },
      };
    }
    if (board.grants.some(grant => grant.id === material.grantId || grant.capabilityHash === material.capability.hash))
      throw new TaskBoardError('conflict', 'the invitation membership material is already in use');
    const grant: TaskBoardGrant = {
      id: material.grantId,
      capabilityHash: material.capability.hash,
      sessionId: target.id,
      sessionIncarnation: target.incarnation,
      runtimeGeneration: target.runtimeGeneration,
      role: 'top_agent',
      allowedActions: actionsForTaskBoardRole('top_agent'),
      membershipRootSessionId: target.id,
      parentSessionId: null,
      boardEpoch: board.boardEpoch,
      coordinatorEpoch: board.coordinatorEpoch,
      active: true,
      grantedAt: command.at,
      grantedBySessionId: null,
    };
    const accepted = {
      ...invitation.candidate,
      status: 'accepted' as const,
      acceptedAt: command.at,
      grantId: grant.id,
    };
    const updated = appendTaskBoardAudit(
      {
        ...board,
        mutationGeneration: board.mutationGeneration + 1,
        grants: [...board.grants, grant],
        invitations: board.invitations.map(candidate =>
          candidate.requestId === accepted.requestId ? accepted : candidate,
        ),
        appliedOperations: [
          ...board.appliedOperations,
          {
            requestId,
            kind: 'invitation.accept',
            fingerprint,
            actorSessionId: target.id,
            actorGrantId: null,
            actorRuntimeGeneration: target.runtimeGeneration,
            resultGrantId: grant.id,
            resultSessionId: target.id,
            appliedAt: command.at,
          },
        ],
      },
      {
        at: command.at,
        event: 'invitation.accepted',
        requestId,
        actorSessionId: target.id,
        outcome: 'applied',
        detail: { invitationRequestId: accepted.requestId },
      },
    );
    return {
      state: replaceTaskBoard(state, updated, {
        bindings: [...state.bindings, bindingForGrant(updated, grant, material.capability.value, command.at)],
        invitationProofs: state.invitationProofs.filter(
          candidate => candidate.invitationRequestId !== accepted.requestId,
        ),
      }),
      result: { accepted: true, membership: membershipForGrant(grant) },
    };
  }
}
