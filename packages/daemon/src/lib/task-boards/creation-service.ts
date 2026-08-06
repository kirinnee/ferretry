import type { TaskBoardAction, TaskBoardCreateRequest, TaskBoardCreateResponse } from '@ferretry/protocol';
import {
  appendTaskBoardAudit,
  bindingForGrant,
  membershipForGrant,
  requireTaskBoardRequestId,
  requireTaskBoardSession,
  taskBoardFingerprint,
} from './domain-helpers.ts';
import { TaskBoardError } from './error.ts';
import { actionsForTaskBoardRole, CURRENT_COORDINATOR_ACTIONS, sessionLineage } from './policy.ts';
import type {
  TaskBoard,
  TaskBoardGrant,
  TaskBoardMutation,
  TaskBoardRepositoryState,
  TaskBoardSecret,
  TaskBoardSession,
} from './types.ts';

export interface CreateTaskBoardCommand extends TaskBoardCreateRequest {
  readonly requestId: string;
  readonly at: string;
}

export interface CreateTaskBoardMaterial {
  readonly boardId: string;
  readonly creatorGrantId: string;
  readonly creatorCapability: TaskBoardSecret;
  readonly coordinatorGrantId: string;
  readonly coordinatorCapability: TaskBoardSecret;
}

function initialGrant(input: {
  readonly id: string;
  readonly capabilityHash: string;
  readonly identity: TaskBoardSession;
  readonly role: TaskBoardGrant['role'];
  readonly allowedActions: readonly TaskBoardAction[];
  readonly membershipRootSessionId: string;
  readonly at: string;
  readonly grantedBySessionId: string | null;
}): TaskBoardGrant {
  return {
    id: input.id,
    capabilityHash: input.capabilityHash,
    sessionId: input.identity.id,
    sessionIncarnation: input.identity.incarnation,
    runtimeGeneration: input.identity.runtimeGeneration,
    role: input.role,
    allowedActions: [...input.allowedActions],
    membershipRootSessionId: input.membershipRootSessionId,
    parentSessionId: input.identity.parentSessionId,
    boardEpoch: 1,
    coordinatorEpoch: 1,
    active: true,
    grantedAt: input.at,
    grantedBySessionId: input.grantedBySessionId,
  };
}

export class TaskBoardCreationService {
  create(
    state: TaskBoardRepositoryState,
    sessions: readonly TaskBoardSession[],
    command: CreateTaskBoardCommand,
    material: CreateTaskBoardMaterial,
  ): TaskBoardMutation<TaskBoardCreateResponse> {
    const requestId = requireTaskBoardRequestId(command.requestId);
    const creator = requireTaskBoardSession(sessions, command.creatorSessionId);
    const coordinator = requireTaskBoardSession(sessions, command.coordinatorSessionId);
    const fingerprint = taskBoardFingerprint([
      'board.create',
      creator.id,
      creator.incarnation,
      creator.runtimeGeneration,
      coordinator.id,
      coordinator.incarnation,
      coordinator.runtimeGeneration,
      command.creatorMarkDone === true,
    ]);
    const replay = state.creations.find(candidate => candidate.requestId === requestId);
    if (replay !== undefined) return this.replay(state, replay.boardId, replay.fingerprint, fingerprint);

    if (!creator.active || creator.mode !== 'interactive' || creator.parentSessionId !== null) {
      throw new TaskBoardError('forbidden', 'a board creator must be a live interactive top-level session');
    }
    const coordinatorLineage = sessionLineage(sessions, coordinator.id);
    if (
      !coordinator.active ||
      coordinator.id === creator.id ||
      coordinatorLineage === null ||
      !coordinatorLineage.slice(1).includes(creator.id)
    ) {
      throw new TaskBoardError('forbidden', 'the initial coordinator must be a live descendant of the creator');
    }
    if (
      state.bindings.some(binding => binding.sessionId === creator.id || binding.sessionId === coordinator.id) ||
      state.boards.some(board => board.id === material.boardId)
    ) {
      throw new TaskBoardError('conflict', 'the creator, coordinator, or board id is already in use');
    }

    const creatorActions: readonly TaskBoardAction[] = [
      ...actionsForTaskBoardRole('top_agent'),
      ...(command.creatorMarkDone === true ? (['mark_done'] as const) : []),
    ];
    const creatorGrant = initialGrant({
      id: material.creatorGrantId,
      capabilityHash: material.creatorCapability.hash,
      identity: creator,
      role: 'top_agent',
      allowedActions: creatorActions,
      membershipRootSessionId: creator.id,
      at: command.at,
      grantedBySessionId: null,
    });
    const coordinatorGrant = initialGrant({
      id: material.coordinatorGrantId,
      capabilityHash: material.coordinatorCapability.hash,
      identity: coordinator,
      role: 'coordinator',
      allowedActions: CURRENT_COORDINATOR_ACTIONS,
      membershipRootSessionId: creator.id,
      at: command.at,
      grantedBySessionId: creator.id,
    });
    const initialBoard: TaskBoard = {
      id: material.boardId,
      creatorSessionId: creator.id,
      canonicalSessionId: creator.id,
      coordinatorSessionId: coordinator.id,
      coordinatorGrantId: coordinatorGrant.id,
      boardEpoch: 1,
      coordinatorEpoch: 1,
      mutationGeneration: 1,
      grants: [creatorGrant, coordinatorGrant],
      childGrantIntents: [],
      invitations: [],
      appliedOperations: [],
      audit: [],
      retiredSessionIds: [],
      createdAt: command.at,
      updatedAt: command.at,
    };
    const board = appendTaskBoardAudit(initialBoard, {
      at: command.at,
      event: 'board.created',
      requestId,
      actorSessionId: null,
      outcome: 'applied',
      detail: { creatorSessionId: creator.id, coordinatorSessionId: coordinator.id },
    });
    const nextState: TaskBoardRepositoryState = {
      ...state,
      revision: state.revision + 1,
      boards: [...state.boards, board],
      bindings: [
        ...state.bindings,
        bindingForGrant(board, creatorGrant, material.creatorCapability.value, command.at),
        bindingForGrant(board, coordinatorGrant, material.coordinatorCapability.value, command.at),
      ],
      creations: [...state.creations, { requestId, fingerprint, boardId: board.id }],
    };
    return {
      state: nextState,
      result: {
        created: true,
        creator: membershipForGrant(creatorGrant),
        coordinator: membershipForGrant(coordinatorGrant),
      },
    };
  }

  private replay(
    state: TaskBoardRepositoryState,
    boardId: string,
    storedFingerprint: string,
    fingerprint: string,
  ): TaskBoardMutation<TaskBoardCreateResponse> {
    if (storedFingerprint !== fingerprint) {
      throw new TaskBoardError('conflict', 'the board creation request id was reused with another payload');
    }
    const board = state.boards.find(candidate => candidate.id === boardId);
    const creator = board?.grants.find(
      grant => grant.sessionId === board.creatorSessionId && grant.role === 'top_agent',
    );
    const coordinator = board?.grants.find(grant => grant.id === board.coordinatorGrantId);
    if (board === undefined || creator === undefined || coordinator === undefined) {
      throw new TaskBoardError('unavailable', 'the board creation replay is incomplete');
    }
    return {
      state,
      result: {
        created: false,
        creator: membershipForGrant(creator),
        coordinator: membershipForGrant(coordinator),
      },
    };
  }
}
