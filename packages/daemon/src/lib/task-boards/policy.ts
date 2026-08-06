import type { TaskBoardAction, TaskBoardRole } from '@ferretry/protocol';
import type {
  ActiveTaskBoardRole,
  TaskBoard,
  TaskBoardAuthorization,
  TaskBoardBinding,
  TaskBoardCredential,
  TaskBoardGrant,
  TaskBoardInvitation,
  TaskBoardInvitationProof,
  TaskBoardSession,
} from './types.ts';

const READ_ACTIONS = ['read'] as const satisfies readonly TaskBoardAction[];
const WORKER_ACTIONS = [
  'read',
  'status',
  'note',
  'feedback',
  'file',
  'link',
] as const satisfies readonly TaskBoardAction[];
const OPERATIONAL_ACTIONS = [
  'read',
  'create',
  'status',
  'note',
  'feedback',
  'clarify',
  'dependency',
  'file',
  'link',
  'assign',
  'order',
] as const satisfies readonly TaskBoardAction[];

export const CURRENT_COORDINATOR_ACTIONS = [
  ...OPERATIONAL_ACTIONS,
  'grant_approve',
  'invite_approve',
] as const satisfies readonly TaskBoardAction[];

export function actionsForTaskBoardRole(role: TaskBoardRole): readonly TaskBoardAction[] {
  switch (role) {
    case 'none':
      return [];
    case 'read':
      return READ_ACTIONS;
    case 'worker':
      return WORKER_ACTIONS;
    case 'coordinator':
      return OPERATIONAL_ACTIONS;
    case 'top_agent':
      return [...OPERATIONAL_ACTIONS, 'grant_request', 'invite_request', 'membership_relinquish'];
  }
}

export function sameTaskBoardActions(left: readonly TaskBoardAction[], right: readonly TaskBoardAction[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.every(action => right.includes(action))
  );
}

export function sessionById(sessions: readonly TaskBoardSession[], sessionId: string): TaskBoardSession | null {
  return sessions.find(session => session.id === sessionId) ?? null;
}

export function sessionLineage(sessions: readonly TaskBoardSession[], sessionId: string): readonly string[] | null {
  const lineage: string[] = [];
  const seen = new Set<string>();
  let current = sessionById(sessions, sessionId);
  while (current !== null) {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    lineage.push(current.id);
    current = current.parentSessionId === null ? null : sessionById(sessions, current.parentSessionId);
  }
  return lineage;
}

/** Tree scoping is explicit: ancestry is never consulted to manufacture membership. */
export function hasTreeScopedBoardAccess(board: TaskBoard, sessionId: string): boolean {
  return board.grants.some(grant => grant.active && grant.sessionId === sessionId);
}

export function isExplicitBoardMember(board: TaskBoard, sessionId: string): boolean {
  return hasTreeScopedBoardAccess(board, sessionId);
}

export function isActiveMembershipRoot(board: TaskBoard, sessionId: string): boolean {
  return board.grants.some(
    grant =>
      grant.active &&
      grant.role === 'top_agent' &&
      grant.sessionId === sessionId &&
      grant.membershipRootSessionId === sessionId,
  );
}

export function isGrantWithinActiveMembershipTree(
  board: TaskBoard,
  grant: TaskBoardGrant,
  sessions: readonly TaskBoardSession[],
): boolean {
  if (!isActiveMembershipRoot(board, grant.membershipRootSessionId)) return false;
  const session = sessionById(sessions, grant.sessionId);
  if (session === null || session.parentSessionId !== grant.parentSessionId) return false;
  if (grant.sessionId === grant.membershipRootSessionId) return grant.parentSessionId === null;
  const lineage = sessionLineage(sessions, grant.sessionId);
  return lineage?.slice(1).includes(grant.membershipRootSessionId) ?? false;
}

export function isCurrentCoordinator(board: TaskBoard, grant: TaskBoardGrant): boolean {
  return (
    grant.active &&
    grant.id === board.coordinatorGrantId &&
    grant.sessionId === board.coordinatorSessionId &&
    grant.role === 'coordinator' &&
    grant.boardEpoch === board.boardEpoch &&
    grant.coordinatorEpoch === board.coordinatorEpoch &&
    sameTaskBoardActions(grant.allowedActions, CURRENT_COORDINATOR_ACTIONS)
  );
}

export function isCapabilityBoundToSession(input: {
  readonly board: TaskBoard;
  readonly grant: TaskBoardGrant;
  readonly binding: TaskBoardBinding;
  readonly bindingCapabilityHash: string;
  readonly credential: TaskBoardCredential;
  readonly session: TaskBoardSession;
}): boolean {
  const { bindingCapabilityHash, board, binding, credential, grant, session } = input;
  return (
    grant.active &&
    session.active &&
    credential.sessionId === session.id &&
    credential.sessionId === grant.sessionId &&
    credential.runtimeGeneration === session.runtimeGeneration &&
    credential.runtimeGeneration === grant.runtimeGeneration &&
    credential.capabilityHash === grant.capabilityHash &&
    bindingCapabilityHash === grant.capabilityHash &&
    binding.sessionId === session.id &&
    binding.grantId === grant.id &&
    binding.boardId === board.id &&
    binding.sessionIncarnation === session.incarnation &&
    binding.runtimeGeneration === session.runtimeGeneration &&
    binding.role === grant.role &&
    sameTaskBoardActions(binding.allowedActions, grant.allowedActions) &&
    binding.boardEpoch === board.boardEpoch &&
    binding.coordinatorEpoch === board.coordinatorEpoch &&
    grant.sessionIncarnation === session.incarnation &&
    grant.boardEpoch === board.boardEpoch &&
    grant.coordinatorEpoch === board.coordinatorEpoch
  );
}

export function isAcceptedInvitationMembership(board: TaskBoard, sessionId: string): boolean {
  return board.invitations.some(
    invitation =>
      invitation.status === 'accepted' &&
      invitation.targetSessionId === sessionId &&
      board.grants.some(grant => grant.active && grant.id === invitation.grantId && grant.sessionId === sessionId),
  );
}

export function hasExplicitInvitationAuthority(
  board: TaskBoard,
  authorization: TaskBoardAuthorization,
  step: 'request' | 'approve',
): boolean {
  const grant = board.grants.find(candidate => candidate.id === authorization.grantId);
  if (
    grant === undefined ||
    !grant.active ||
    grant.sessionId !== authorization.sessionId ||
    authorization.boardId !== board.id ||
    authorization.boardEpoch !== board.boardEpoch ||
    authorization.coordinatorEpoch !== board.coordinatorEpoch ||
    authorization.runtimeGeneration !== grant.runtimeGeneration ||
    !sameTaskBoardActions(authorization.allowedActions, grant.allowedActions)
  ) {
    return false;
  }
  if (step === 'request') {
    return (
      grant.role === 'top_agent' &&
      grant.membershipRootSessionId === grant.sessionId &&
      grant.allowedActions.includes('invite_request')
    );
  }
  return isCurrentCoordinator(board, grant) && grant.allowedActions.includes('invite_approve');
}

/**
 * The membership root grant of a session that is STILL THERE — active on the board and active in the
 * session directory, at the exact incarnation and runtime generation the grant was written for.
 *
 * A board row outlives the session it describes: nothing revokes a grant when a pane dies, which is why
 * `isCapabilityBoundToSession` re-checks liveness on every authenticated call. Coordinator replacement
 * presents no member capability at all — the operator's authority is not a session's — so the tree it
 * re-homes the coordinator into has to be proved live HERE, or a succession would hand the board's only
 * approval key to a descendant of a root that stopped hours ago.
 */
export function liveMembershipRootGrant(input: {
  readonly board: TaskBoard;
  readonly bindings: readonly TaskBoardBinding[];
  readonly sessions: readonly TaskBoardSession[];
  readonly sessionId: string;
}): TaskBoardGrant | null {
  const { board, bindings, sessions, sessionId } = input;
  const session = sessionById(sessions, sessionId);
  if (session === null || !session.active) return null;
  const grant =
    board.grants.find(
      candidate =>
        candidate.active &&
        candidate.role === 'top_agent' &&
        candidate.sessionId === sessionId &&
        candidate.membershipRootSessionId === sessionId &&
        candidate.sessionIncarnation === session.incarnation &&
        candidate.runtimeGeneration === session.runtimeGeneration,
    ) ?? null;
  if (grant === null) return null;
  /**
   * A grant with no CURRENT binding is a root that cannot act: the binding is where its capability
   * lives, and `refreshBindings` drops one the moment its grant or its epochs go stale. Requiring it
   * here is what makes "an active root" mean "a root that could make this call itself".
   */
  const bound = bindings.some(
    binding =>
      binding.boardId === board.id &&
      binding.grantId === grant.id &&
      binding.sessionId === sessionId &&
      binding.sessionIncarnation === session.incarnation &&
      binding.runtimeGeneration === session.runtimeGeneration &&
      binding.boardEpoch === board.boardEpoch &&
      binding.coordinatorEpoch === board.coordinatorEpoch,
  );
  return bound ? grant : null;
}

/** Wardens may observe/recover runtime state, but can never widen membership. */
export function canWardenWidenBoardMembership(): false {
  return false;
}

export function isInvitationProofBoundToSession(input: {
  readonly proof: TaskBoardInvitationProof;
  readonly invitation: TaskBoardInvitation;
  readonly session: TaskBoardSession;
  readonly sessionCapabilityHash: string;
  readonly invitationCapabilityHash: string;
}): boolean {
  const { proof, invitation, session, sessionCapabilityHash, invitationCapabilityHash } = input;
  return (
    invitation.status === 'approved' &&
    invitation.targetSessionId === session.id &&
    invitation.targetSessionIncarnation === session.incarnation &&
    invitation.targetRuntimeGeneration === session.runtimeGeneration &&
    invitation.acceptanceCapabilityHash === invitationCapabilityHash &&
    proof.invitationRequestId === invitation.requestId &&
    proof.targetSessionId === session.id &&
    proof.targetSessionIncarnation === session.incarnation &&
    proof.targetRuntimeGeneration === session.runtimeGeneration &&
    proof.sessionCapabilityHash === session.sessionCapabilityHash &&
    proof.sessionCapabilityHash === sessionCapabilityHash &&
    proof.invitationCapabilityHash === invitationCapabilityHash
  );
}

export function isInvitationProofUnexpired(proof: TaskBoardInvitationProof, now: string): boolean {
  return Date.parse(now) < Date.parse(proof.expiresAt);
}

export function canWorkerPerformAssignedMutation(
  role: ActiveTaskBoardRole,
  action: TaskBoardAction,
  actorSessionId: string,
  assignedSessionId: string | null | undefined,
): boolean {
  if (role !== 'worker' || action === 'read') return true;
  return assignedSessionId !== undefined && assignedSessionId !== null && assignedSessionId === actorSessionId;
}
