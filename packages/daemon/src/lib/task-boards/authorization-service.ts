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
  TaskBoardMemberAuthorization,
  TaskBoardNonSessionPrincipal,
  TaskBoardRepositoryState,
  TaskBoardSession,
} from './types.ts';

export interface CentralTaskScope {
  readonly kind: 'board';
  readonly sessionId: string;
  readonly board: TaskBoard;
  /**
   * A MEMBER's authorization, because a task scope is only ever resolved from a board capability. The
   * completion record the task mount journals names the peer that acted, so widening this to the
   * base type would make that name nullable for an actor which can never be a non-session principal.
   */
  readonly authorization: TaskBoardMemberAuthorization;
}

export interface TaskBoardAuthorizationOptions {
  readonly assignedSessionId?: string | null;
}

export type TaskBoardCapabilityHash = (capability: string) => string;

/**
 * The grant id a non-session principal's decisions are attributed to.
 *
 * It is a NAME, not a grant: no such row exists in any board, nothing can be authorized by presenting
 * it, and it is never minted. It exists so an applied operation has a stable, readable actor field for
 * an actor that is not a member.
 */
export const TASK_BOARD_OPERATOR_GRANT_ID = 'human-admin';

/** What the audit trail calls the human operator. */
export const TASK_BOARD_OPERATOR_ACTOR_NAME = 'user';

export class TaskBoardAuthorizationService {
  constructor(private readonly hashCapability: TaskBoardCapabilityHash) {}

  /**
   * The authorization of a principal that is NOT a session, for one exact board.
   *
   * WHAT THIS DOES AND DOES NOT PROVE. It does not authenticate anybody: the board admin capability is
   * verified where it is presented, in `requireOperator`, exactly as it already is for board creation.
   * What this owns is the shape of the resulting decision — no session id, no runtime generation, no
   * borrowed grant, and no action list, because the operator's authority is its ROLE and every action
   * in `allowedActions` is a member's verb. A reducer that wants an operator must therefore check the
   * role, and one that wants a member cannot be handed this at all: the member type is narrower.
   */
  administrator(
    state: TaskBoardRepositoryState,
    boardId: string,
    principal: TaskBoardNonSessionPrincipal,
  ): TaskBoardAuthorization {
    const board = state.boards.find(candidate => candidate.id === boardId);
    if (board === undefined) throw new TaskBoardError('not-found', 'the task board was not found');
    return {
      boardId: board.id,
      grantId: TASK_BOARD_OPERATOR_GRANT_ID,
      sessionId: null,
      role: principal,
      allowedActions: [],
      boardEpoch: board.boardEpoch,
      coordinatorEpoch: board.coordinatorEpoch,
      runtimeGeneration: null,
    };
  }

  authorize(
    state: TaskBoardRepositoryState,
    sessions: readonly TaskBoardSession[],
    credential: TaskBoardCredential,
    action: TaskBoardAction,
    options: TaskBoardAuthorizationOptions = {},
  ): TaskBoardMemberAuthorization {
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
    /**
     * THE ACTOR IS AUTHORIZED FIRST, and the order is load-bearing rather than tidy. A target may now
     * be a session with no binding at all — a retired one — so a caller who asked about an arbitrary
     * id before proving its own membership would learn which sessions this daemon has retired. Proving
     * the actor first makes every answer below a statement to somebody already on the board.
     */
    const authorization = this.authorize(state, sessions, credential, action, options);
    const board = state.boards.find(candidate => candidate.id === authorization.boardId);
    if (board === undefined) throw new TaskBoardError('unavailable', 'the authoritative task board is unavailable');
    const targetBinding = state.bindings.find(candidate => candidate.sessionId === sessionId);
    if (targetBinding !== undefined) {
      /**
       * A live binding wins outright, and it wins even when the target is ALSO retired here: a session
       * that took membership somewhere else is that board's member, and a stale retirement entry on
       * this one must never reach across.
       */
      if (targetBinding.boardId !== board.id)
        throw new TaskBoardError('forbidden', 'the actor does not belong to the target task board');
      return { kind: 'board', sessionId, board, authorization };
    }
    /**
     * Retired on THIS board, so its tasks stayed where they were when its tree retired. A retired id
     * is a target and never an actor: it names no capability and holds no binding, so `authorize`
     * above refuses it outright if it ever tries to act.
     */
    if (!board.retiredSessionIds.includes(sessionId))
      throw new TaskBoardError('not-found', `session ${sessionId} has no central task-board scope`);
    return { kind: 'board', sessionId, board, authorization };
  }
}
