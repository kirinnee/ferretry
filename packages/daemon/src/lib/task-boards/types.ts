import type {
  TaskBoardAction,
  TaskBoardErrorCode,
  TaskBoardGrantRequestStatus,
  TaskBoardInvitationStatus,
  TaskBoardRole,
} from '@ferretry/protocol';

export type ActiveTaskBoardRole = Exclude<TaskBoardRole, 'none'>;
export type ChildTaskBoardRole = Exclude<ActiveTaskBoardRole, 'top_agent'>;

/**
 * Who a board decision can be attributed to. Two of these are not sessions.
 *
 * A ROLE ON A BOARD AND A PRINCIPAL ASKING FOR SOMETHING ARE DIFFERENT FACTS, and conflating them is
 * what left coordinator replacement unreachable: the operator holds the board admin capability, has no
 * session id, no incarnation and no runtime generation, and every attempt to express that authority as
 * a session forced a fiction into the field the audit entry is built from. `human_admin` is the human
 * at the machine; `daemon` is the daemon acting for itself. Neither can ever be minted from a board
 * capability — they are constructed only where the operator credential is verified.
 */
export type TaskBoardNonSessionPrincipal = 'human_admin' | 'daemon';
export type TaskBoardPrincipalRole = ActiveTaskBoardRole | TaskBoardNonSessionPrincipal;

export interface TaskBoardSession {
  readonly id: string;
  readonly incarnation: string;
  readonly runtimeGeneration: number;
  readonly parentSessionId: string | null;
  readonly mode: 'auto' | 'interactive';
  readonly active: boolean;
  readonly name: string | null;
  readonly teammate: string | null;
  /** Hash of the daemon-owned session credential; never the credential itself. */
  readonly sessionCapabilityHash: string;
}

export interface TaskBoardGrant {
  readonly id: string;
  readonly capabilityHash: string;
  readonly sessionId: string;
  readonly sessionIncarnation: string;
  readonly runtimeGeneration: number;
  readonly role: ActiveTaskBoardRole;
  readonly allowedActions: readonly TaskBoardAction[];
  readonly membershipRootSessionId: string;
  readonly parentSessionId: string | null;
  readonly boardEpoch: number;
  readonly coordinatorEpoch: number;
  readonly active: boolean;
  readonly grantedAt: string;
  readonly grantedBySessionId: string | null;
  readonly revokedAt?: string;
  readonly revokedBySessionId?: string | null;
  readonly revokeReason?: string;
}

/** Plaintext credentials live in the per-session binding store, never in a board. */
export interface TaskBoardBinding {
  readonly boardId: string;
  readonly grantId: string;
  readonly sessionId: string;
  readonly sessionIncarnation: string;
  readonly runtimeGeneration: number;
  readonly capability: string;
  readonly role: ActiveTaskBoardRole;
  readonly allowedActions: readonly TaskBoardAction[];
  readonly boardEpoch: number;
  readonly coordinatorEpoch: number;
  readonly updatedAt: string;
}

export interface TaskBoardChildGrantIntent {
  readonly requestId: string;
  readonly fingerprint: string;
  readonly boardEpoch: number;
  readonly sourceGrantId: string;
  readonly sourceSessionId: string;
  readonly sourceSessionIncarnation: string;
  readonly sourceRuntimeGeneration: number;
  readonly membershipRootSessionId: string;
  readonly targetSessionId: string;
  readonly targetSessionIncarnation: string;
  readonly targetRuntimeGeneration: number;
  readonly targetLineage: readonly string[];
  readonly requestedRole: ChildTaskBoardRole;
  readonly allowedActions: readonly TaskBoardAction[];
  readonly coordinatorGrantId: string;
  readonly coordinatorSessionId: string;
  readonly coordinatorSessionIncarnation: string;
  readonly coordinatorRuntimeGeneration: number;
  readonly coordinatorLineage: readonly string[];
  readonly coordinatorEpoch: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: TaskBoardGrantRequestStatus;
  readonly approvedAt?: string;
  readonly approvedBySessionId?: string;
  readonly grantId?: string;
  readonly refusalReason?: string;
}

export interface TaskBoardInvitation {
  readonly requestId: string;
  readonly fingerprint: string;
  readonly boardEpoch: number;
  readonly sourceGrantId: string;
  readonly sourceSessionId: string;
  readonly sourceSessionIncarnation: string;
  readonly sourceRuntimeGeneration: number;
  readonly targetSessionId: string;
  readonly targetSessionIncarnation: string;
  readonly targetRuntimeGeneration: number;
  readonly coordinatorGrantId: string;
  readonly coordinatorSessionId: string;
  readonly coordinatorSessionIncarnation: string;
  readonly coordinatorRuntimeGeneration: number;
  readonly coordinatorLineage: readonly string[];
  readonly coordinatorEpoch: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: TaskBoardInvitationStatus;
  readonly approvedAt?: string;
  readonly approvedBySessionId?: string;
  readonly acceptanceCapabilityHash?: string;
  readonly acceptedAt?: string;
  readonly grantId?: string;
  /**
   * An authenticated board action made by the invited root after acceptance. Acceptance only proves
   * that a grant was written; this receipt proves the replacement actually received and can use it.
   */
  readonly verifiedAt?: string;
  readonly verifiedBySessionId?: string;
  readonly refusalReason?: string;
}

/** One-time, per-session pre-membership proof. It is deleted on accept/expiry/refusal. */
export interface TaskBoardInvitationProof {
  readonly boardId: string;
  readonly invitationRequestId: string;
  readonly targetSessionId: string;
  readonly targetSessionIncarnation: string;
  readonly targetRuntimeGeneration: number;
  readonly sessionCapabilityHash: string;
  readonly invitationCapability: string;
  readonly invitationCapabilityHash: string;
  readonly expiresAt: string;
}

export type TaskBoardAuditEvent =
  | 'board.created'
  | 'grant.requested'
  | 'grant.approved'
  | 'grant.refused'
  | 'grant.expired'
  | 'invitation.requested'
  | 'invitation.approved'
  | 'invitation.accepted'
  | 'invitation.verified'
  | 'invitation.refused'
  | 'invitation.expired'
  | 'membership.relinquished'
  | 'coordinator.replaced'
  | 'grant.revoked'
  | 'mark-done.changed';

export interface TaskBoardAuditEntry {
  readonly sequence: number;
  readonly at: string;
  readonly event: TaskBoardAuditEvent;
  readonly requestId: string;
  readonly actorSessionId: string | null;
  /** What to call an actor with no session id — `user` for the operator. Absent for a member. */
  readonly actorName?: string;
  readonly outcome: 'applied' | 'replayed' | 'denied';
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

export type TaskBoardOperationKind =
  | 'child-grant.approve'
  | 'invitation.approve'
  | 'invitation.accept'
  | 'invitation.verify'
  | 'membership.relinquish'
  | 'coordinator.replace'
  | 'grant.revoke'
  | 'mark-done.set';

export interface TaskBoardAppliedOperation {
  readonly requestId: string;
  readonly kind: TaskBoardOperationKind;
  readonly fingerprint: string;
  readonly actorSessionId: string | null;
  readonly actorGrantId: string | null;
  readonly actorRuntimeGeneration: number | null;
  readonly resultGrantId?: string;
  readonly resultSessionId?: string;
  readonly appliedAt: string;
}

export interface TaskBoard {
  readonly id: string;
  readonly creatorSessionId: string;
  readonly canonicalSessionId: string;
  readonly coordinatorSessionId: string;
  readonly coordinatorGrantId: string;
  readonly boardEpoch: number;
  readonly coordinatorEpoch: number;
  readonly mutationGeneration: number;
  readonly grants: readonly TaskBoardGrant[];
  readonly childGrantIntents: readonly TaskBoardChildGrantIntent[];
  readonly invitations: readonly TaskBoardInvitation[];
  readonly appliedOperations: readonly TaskBoardAppliedOperation[];
  readonly audit: readonly TaskBoardAuditEntry[];
  /**
   * Sessions that once held membership here and no longer do, appended when a grant is retired and
   * never removed.
   *
   * WHY THE BOARD OWNS THIS AND NOT THE BINDINGS. A session's tasks are addressed through the board
   * it belongs to, and a binding is deleted the instant its grant stops being active. Without this
   * list, retiring a membership root would take every task its tree ever owned out of the board's
   * reach — the tasks would have MOVED, in the only sense that matters to a caller, without a single
   * file being touched. A retired id is a TARGET only: it names no capability, so nothing here can
   * make a retired session act.
   */
  readonly retiredSessionIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskBoardCreationRecord {
  readonly requestId: string;
  readonly fingerprint: string;
  readonly boardId: string;
}

export interface TaskBoardRepositoryState {
  readonly revision: number;
  readonly boards: readonly TaskBoard[];
  readonly bindings: readonly TaskBoardBinding[];
  readonly invitationProofs: readonly TaskBoardInvitationProof[];
  readonly creations: readonly TaskBoardCreationRecord[];
}

export interface TaskBoardMutation<T> {
  readonly state: TaskBoardRepositoryState;
  readonly result: T;
}

export interface TaskBoardCredential {
  readonly sessionId: string;
  readonly runtimeGeneration: number;
  readonly capabilityHash: string;
}

/**
 * An authorized decision, whoever made it.
 *
 * `sessionId` and `runtimeGeneration` are nullable because the non-session principals genuinely have
 * neither. Writing a placeholder id there would put a session's name on a human's decision in the
 * audit trail, which is the one thing an audit trail must not do.
 */
export interface TaskBoardAuthorization {
  readonly boardId: string;
  readonly grantId: string;
  readonly sessionId: string | null;
  readonly role: TaskBoardPrincipalRole;
  readonly allowedActions: readonly TaskBoardAction[];
  readonly boardEpoch: number;
  readonly coordinatorEpoch: number;
  readonly runtimeGeneration: number | null;
}

/**
 * A MEMBER's authorization: proved by a board capability, so the session terms are always present.
 *
 * Every reducer that acts on behalf of a session takes this narrower type, which is why widening the
 * base type above cost those reducers nothing — a non-session principal cannot be passed where a
 * member is required, and the compiler is what says so.
 */
export interface TaskBoardMemberAuthorization extends TaskBoardAuthorization {
  readonly sessionId: string;
  readonly role: ActiveTaskBoardRole;
  readonly runtimeGeneration: number;
}

export interface TaskBoardSecret {
  readonly value: string;
  readonly hash: string;
}

export interface TaskBoardErrorShape {
  readonly code: TaskBoardErrorCode;
  readonly message: string;
}

export interface TaskBoardRepository {
  transaction<T>(operation: (state: TaskBoardRepositoryState) => Promise<TaskBoardMutation<T>>): Promise<T>;
  snapshot(): Promise<TaskBoardRepositoryState>;
}

export interface TaskBoardSessionDirectory {
  snapshot(): Promise<readonly TaskBoardSession[]>;
}

export interface TaskBoardClock {
  now(): string;
}

export interface TaskBoardCredentialIssuer {
  id(kind: 'board' | 'grant'): string;
  capability(): TaskBoardSecret;
  hash(value: string): string;
}

export const EMPTY_TASK_BOARD_REPOSITORY_STATE: TaskBoardRepositoryState = {
  revision: 0,
  boards: [],
  bindings: [],
  invitationProofs: [],
  creations: [],
};
