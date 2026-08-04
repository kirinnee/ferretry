import type {
  TaskBoardAction,
  TaskBoardErrorCode,
  TaskBoardGrantRequestStatus,
  TaskBoardInvitationStatus,
  TaskBoardRole,
} from '@ferretry/protocol';

export type ActiveTaskBoardRole = Exclude<TaskBoardRole, 'none'>;
export type ChildTaskBoardRole = Exclude<ActiveTaskBoardRole, 'top_agent'>;

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

export interface TaskBoardAuthorization {
  readonly boardId: string;
  readonly grantId: string;
  readonly sessionId: string;
  readonly role: ActiveTaskBoardRole;
  readonly allowedActions: readonly TaskBoardAction[];
  readonly boardEpoch: number;
  readonly coordinatorEpoch: number;
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
