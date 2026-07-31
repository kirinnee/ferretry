import type { TaskBoardAction } from '@ferretry/protocol';
import { TaskBoardError } from './error.ts';
import {
  canWorkerPerformAssignedMutation,
  isCapabilityBoundToSession,
  isGrantWithinActiveMembershipTree,
} from './policy.ts';
import type {
  TaskBoard,
  TaskBoardAuthorization,
  TaskBoardCredential,
  TaskBoardRepositoryState,
  TaskBoardSession,
} from './types.ts';

export interface CentralTaskScope {
  readonly kind: 'board';
  readonly sessionId: string;
  readonly board: TaskBoard;
  readonly authorization: TaskBoardAuthorization;
}

export interface TaskBoardAuthorizationOptions {
  readonly assignedSessionId?: string | null;
}

export type TaskBoardCapabilityHash = (capability: string) => string;

export class TaskBoardAuthorizationService {
  constructor(private readonly hashCapability: TaskBoardCapabilityHash) {}

  authorize(
    state: TaskBoardRepositoryState,
    sessions: readonly TaskBoardSession[],
    credential: TaskBoardCredential,
    action: TaskBoardAction,
    options: TaskBoardAuthorizationOptions = {},
  ): TaskBoardAuthorization {
    const binding = state.bindings.find(candidate => candidate.sessionId === credential.sessionId);
    if (binding === undefined)
      throw new TaskBoardError('forbidden', 'the session has no explicit task-board membership');
    const board = state.boards.find(candidate => candidate.id === binding.boardId);
    if (board === undefined)
      throw new TaskBoardError('unavailable', 'the task-board binding has no authoritative board');
    const grant = board.grants.find(candidate => candidate.id === binding.grantId);
    const session = sessions.find(candidate => candidate.id === credential.sessionId);
    if (grant === undefined || session === undefined) {
      throw new TaskBoardError('forbidden', 'the task-board grant no longer resolves its exact session');
    }
    if (
      !isCapabilityBoundToSession({
        board,
        grant,
        binding,
        bindingCapabilityHash: this.hashCapability(binding.capability),
        credential,
        session,
      }) ||
      !isGrantWithinActiveMembershipTree(board, grant, sessions)
    ) {
      throw new TaskBoardError('forbidden', 'the task-board capability is stale or belongs to another session');
    }
    if (!grant.allowedActions.includes(action)) {
      throw new TaskBoardError('forbidden', `the task-board grant does not allow ${action}`);
    }
    if (!canWorkerPerformAssignedMutation(grant.role, action, grant.sessionId, options.assignedSessionId)) {
      throw new TaskBoardError('forbidden', 'a worker may mutate only a task assigned to its exact session');
    }
    return {
      boardId: board.id,
      grantId: grant.id,
      sessionId: grant.sessionId,
      role: grant.role,
      allowedActions: [...grant.allowedActions],
      boardEpoch: board.boardEpoch,
      coordinatorEpoch: board.coordinatorEpoch,
      runtimeGeneration: grant.runtimeGeneration,
    };
  }

  resolveTaskScope(
    state: TaskBoardRepositoryState,
    sessions: readonly TaskBoardSession[],
    sessionId: string,
    credential: TaskBoardCredential,
    action: TaskBoardAction,
    options: TaskBoardAuthorizationOptions = {},
  ): CentralTaskScope {
    const targetBinding = state.bindings.find(candidate => candidate.sessionId === sessionId);
    if (targetBinding === undefined) {
      throw new TaskBoardError('not-found', `session ${sessionId} has no central task-board scope`);
    }
    const authorization = this.authorize(state, sessions, credential, action, options);
    if (authorization.boardId !== targetBinding.boardId) {
      throw new TaskBoardError('forbidden', 'the actor does not belong to the target task board');
    }
    const board = state.boards.find(candidate => candidate.id === authorization.boardId);
    if (board === undefined) throw new TaskBoardError('unavailable', 'the authoritative task board is unavailable');
    return { kind: 'board', sessionId, board, authorization };
  }
}
