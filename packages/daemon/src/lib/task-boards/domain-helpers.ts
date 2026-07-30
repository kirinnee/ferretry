import type { TaskBoardMembership } from '@ferretry/protocol';
import { TaskBoardError } from './error.ts';
import type {
  TaskBoard,
  TaskBoardAuditEntry,
  TaskBoardAuditEvent,
  TaskBoardBinding,
  TaskBoardGrant,
  TaskBoardSession,
} from './types.ts';

export function requireTaskBoardRequestId(value: string): string {
  const requestId = value.trim();
  if (requestId.length === 0) throw new TaskBoardError('invalid', 'task-board request id must not be empty');
  return requestId;
}

export function taskBoardFingerprint(parts: readonly (string | number | boolean | null)[]): string {
  return JSON.stringify(parts);
}

export function requireTaskBoardSession(sessions: readonly TaskBoardSession[], sessionId: string): TaskBoardSession {
  const session = sessions.find(candidate => candidate.id === sessionId);
  if (session === undefined) throw new TaskBoardError('not-found', `session ${sessionId} was not found`);
  return session;
}

export function membershipForGrant(grant: TaskBoardGrant): TaskBoardMembership {
  return {
    sessionId: grant.sessionId,
    role: grant.role,
    allowedActions: [...grant.allowedActions],
    boardEpoch: grant.boardEpoch,
    coordinatorEpoch: grant.coordinatorEpoch,
    runtimeGeneration: grant.runtimeGeneration,
  };
}

export function bindingForGrant(
  board: TaskBoard,
  grant: TaskBoardGrant,
  capability: string,
  at: string,
): TaskBoardBinding {
  return {
    boardId: board.id,
    grantId: grant.id,
    sessionId: grant.sessionId,
    sessionIncarnation: grant.sessionIncarnation,
    runtimeGeneration: grant.runtimeGeneration,
    capability,
    role: grant.role,
    allowedActions: [...grant.allowedActions],
    boardEpoch: board.boardEpoch,
    coordinatorEpoch: board.coordinatorEpoch,
    updatedAt: at,
  };
}

export function appendTaskBoardAudit(
  board: TaskBoard,
  input: {
    readonly at: string;
    readonly event: TaskBoardAuditEvent;
    readonly requestId: string;
    readonly actorSessionId: string | null;
    readonly outcome: TaskBoardAuditEntry['outcome'];
    readonly detail?: TaskBoardAuditEntry['detail'];
  },
): TaskBoard {
  const audit: TaskBoardAuditEntry = {
    sequence: board.audit.length + 1,
    at: input.at,
    event: input.event,
    requestId: input.requestId,
    actorSessionId: input.actorSessionId,
    outcome: input.outcome,
    detail: input.detail ?? {},
  };
  return { ...board, audit: [...board.audit, audit], updatedAt: input.at };
}
