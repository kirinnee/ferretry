import { describe, it } from 'bun:test';
import should from 'should';
import { exactWorkerAssignee } from '../../../src/lib/task-boards/exact-worker-assignee.ts';
import {
  actionsForTaskBoardRole,
  CURRENT_COORDINATOR_ACTIONS,
  canWardenWidenBoardMembership,
  canWorkerPerformAssignedMutation,
  hasExplicitInvitationAuthority,
  hasTreeScopedBoardAccess,
  isAcceptedInvitationMembership,
  isCapabilityBoundToSession,
  isInvitationProofBoundToSession,
  liveMembershipRootGrant,
  sameTaskBoardActions,
  sessionLineage,
} from '../../../src/lib/task-boards/policy.ts';
import type {
  TaskBoard,
  TaskBoardAuthorization,
  TaskBoardBinding,
  TaskBoardGrant,
  TaskBoardInvitation,
  TaskBoardInvitationProof,
  TaskBoardSession,
} from '../../../src/lib/task-boards/types.ts';

const at = '2026-07-30T12:00:00.000Z';

function session(input: Partial<TaskBoardSession> & Pick<TaskBoardSession, 'id'>): TaskBoardSession {
  return {
    id: input.id,
    incarnation: input.incarnation ?? `${input.id}-incarnation`,
    runtimeGeneration: input.runtimeGeneration ?? 1,
    parentSessionId: input.parentSessionId ?? null,
    mode: input.mode ?? 'interactive',
    active: input.active ?? true,
    name: input.name ?? null,
    teammate: input.teammate ?? null,
    sessionCapabilityHash: input.sessionCapabilityHash ?? `session-hash:${input.id}`,
  };
}

function grant(input: Partial<TaskBoardGrant> & Pick<TaskBoardGrant, 'id' | 'sessionId'>): TaskBoardGrant {
  const role = input.role ?? 'top_agent';
  return {
    id: input.id,
    capabilityHash: input.capabilityHash ?? `board-hash:${input.sessionId}`,
    sessionId: input.sessionId,
    sessionIncarnation: input.sessionIncarnation ?? `${input.sessionId}-incarnation`,
    runtimeGeneration: input.runtimeGeneration ?? 1,
    role,
    allowedActions: input.allowedActions ?? actionsForTaskBoardRole(role),
    membershipRootSessionId: input.membershipRootSessionId ?? input.sessionId,
    parentSessionId: input.parentSessionId ?? null,
    boardEpoch: input.boardEpoch ?? 1,
    coordinatorEpoch: input.coordinatorEpoch ?? 1,
    active: input.active ?? true,
    grantedAt: input.grantedAt ?? at,
    grantedBySessionId: input.grantedBySessionId ?? null,
  };
}

function board(input: Partial<TaskBoard> = {}): TaskBoard {
  const rootGrant = grant({ id: 'grant-root', sessionId: 'root' });
  const coordinatorGrant = grant({
    id: 'grant-coordinator',
    sessionId: 'coordinator',
    role: 'coordinator',
    allowedActions: CURRENT_COORDINATOR_ACTIONS,
    membershipRootSessionId: 'root',
    parentSessionId: 'root',
  });
  return {
    id: input.id ?? 'board-1',
    creatorSessionId: input.creatorSessionId ?? 'root',
    canonicalSessionId: input.canonicalSessionId ?? 'root',
    coordinatorSessionId: input.coordinatorSessionId ?? 'coordinator',
    coordinatorGrantId: input.coordinatorGrantId ?? 'grant-coordinator',
    boardEpoch: input.boardEpoch ?? 1,
    coordinatorEpoch: input.coordinatorEpoch ?? 1,
    mutationGeneration: input.mutationGeneration ?? 1,
    grants: input.grants ?? [rootGrant, coordinatorGrant],
    childGrantIntents: input.childGrantIntents ?? [],
    invitations: input.invitations ?? [],
    appliedOperations: input.appliedOperations ?? [],
    audit: input.audit ?? [],
    retiredSessionIds: input.retiredSessionIds ?? [],
    createdAt: input.createdAt ?? at,
    updatedAt: input.updatedAt ?? at,
  };
}

describe('task-board role policy', () => {
  it('should keep propagated coordinator authority separate from the current coordinator key', () => {
    // Arrange
    const propagated = actionsForTaskBoardRole('coordinator');

    // Act
    const actual = {
      propagatedCanApproveGrant: propagated.includes('grant_approve'),
      propagatedCanApproveInvitation: propagated.includes('invite_approve'),
      currentCanApproveGrant: CURRENT_COORDINATOR_ACTIONS.includes('grant_approve'),
      currentCanApproveInvitation: CURRENT_COORDINATOR_ACTIONS.includes('invite_approve'),
    };

    // Assert
    should(actual).deepEqual({
      propagatedCanApproveGrant: false,
      propagatedCanApproveInvitation: false,
      currentCanApproveGrant: true,
      currentCanApproveInvitation: true,
    });
  });

  it('should reject duplicate action arrays as unequal policy sets', () => {
    // Act
    const actual = sameTaskBoardActions(['read', 'read'], ['read', 'status']);

    // Assert
    should(actual).be.false();
  });
});

describe('tree-scoped membership predicates', () => {
  it('should refuse an uninvited descendant instead of inheriting root access', () => {
    // Arrange
    const subject = board();

    // Act
    const actual = hasTreeScopedBoardAccess(subject, 'uninvited-child');

    // Assert
    should(actual).be.false();
  });

  it('should refuse an approved but unaccepted invitation', () => {
    // Arrange
    const invitation: TaskBoardInvitation = {
      requestId: 'invite-1',
      fingerprint: 'invite-fingerprint',
      boardEpoch: 1,
      sourceGrantId: 'grant-root',
      sourceSessionId: 'root',
      sourceSessionIncarnation: 'root-incarnation',
      sourceRuntimeGeneration: 1,
      targetSessionId: 'external',
      targetSessionIncarnation: 'external-incarnation',
      targetRuntimeGeneration: 1,
      coordinatorGrantId: 'grant-coordinator',
      coordinatorSessionId: 'coordinator',
      coordinatorSessionIncarnation: 'coordinator-incarnation',
      coordinatorRuntimeGeneration: 1,
      coordinatorLineage: ['coordinator', 'root'],
      coordinatorEpoch: 1,
      createdAt: at,
      expiresAt: '2026-07-31T12:00:00.000Z',
      status: 'approved',
      approvedAt: at,
      approvedBySessionId: 'coordinator',
      acceptanceCapabilityHash: 'invitation-hash',
    };
    const subject = board({ invitations: [invitation] });

    // Act
    const actual = isAcceptedInvitationMembership(subject, 'external');

    // Assert
    should(actual).be.false();
  });

  it('should recognize only an accepted invitation backed by an active exact grant', () => {
    // Arrange
    const invitation: TaskBoardInvitation = {
      requestId: 'invite-1',
      fingerprint: 'invite-fingerprint',
      boardEpoch: 1,
      sourceGrantId: 'grant-root',
      sourceSessionId: 'root',
      sourceSessionIncarnation: 'root-incarnation',
      sourceRuntimeGeneration: 1,
      targetSessionId: 'external',
      targetSessionIncarnation: 'external-incarnation',
      targetRuntimeGeneration: 1,
      coordinatorGrantId: 'grant-coordinator',
      coordinatorSessionId: 'coordinator',
      coordinatorSessionIncarnation: 'coordinator-incarnation',
      coordinatorRuntimeGeneration: 1,
      coordinatorLineage: ['coordinator', 'root'],
      coordinatorEpoch: 1,
      createdAt: at,
      expiresAt: '2026-07-31T12:00:00.000Z',
      status: 'accepted',
      approvedAt: at,
      approvedBySessionId: 'coordinator',
      acceptanceCapabilityHash: 'invitation-hash',
      acceptedAt: at,
      grantId: 'grant-external',
    };
    const subject = board({
      invitations: [invitation],
      grants: [
        ...board().grants,
        grant({ id: 'grant-external', sessionId: 'external', membershipRootSessionId: 'external' }),
      ],
    });

    // Act
    const actual = isAcceptedInvitationMembership(subject, 'external');

    // Assert
    should(actual).be.true();
  });

  it('should return no lineage for a parent cycle', () => {
    // Arrange
    const input = [session({ id: 'a', parentSessionId: 'b' }), session({ id: 'b', parentSessionId: 'a' })];

    // Act
    const actual = sessionLineage(input, 'a');

    // Assert
    should(actual).be.null();
  });
});

describe('capability predicates', () => {
  it('should refuse a transferable capability presented for another session', () => {
    // Arrange
    const subject = board();
    const member = subject.grants.find(candidate => candidate.id === 'grant-root');
    should(member).not.be.undefined();
    if (member === undefined) throw new Error('test fixture is missing the root grant');
    const identity = session({ id: 'root' });
    const binding: TaskBoardBinding = {
      boardId: subject.id,
      grantId: member.id,
      sessionId: 'root',
      sessionIncarnation: identity.incarnation,
      runtimeGeneration: 1,
      capability: 'board-secret',
      role: 'top_agent',
      allowedActions: member.allowedActions,
      boardEpoch: 1,
      coordinatorEpoch: 1,
      updatedAt: at,
    };

    // Act
    const actual = isCapabilityBoundToSession({
      board: subject,
      grant: member,
      binding,
      bindingCapabilityHash: member.capabilityHash,
      credential: { sessionId: 'attacker', runtimeGeneration: 1, capabilityHash: member.capabilityHash },
      session: identity,
    });

    // Assert
    should(actual).be.false();
  });

  it('should refuse a copied binding whose stored secret does not match the central grant', () => {
    // Arrange
    const subject = board();
    const member = subject.grants.find(candidate => candidate.id === 'grant-root');
    should(member).not.be.undefined();
    if (member === undefined) throw new Error('test fixture is missing the root grant');
    const identity = session({ id: 'root' });
    const binding: TaskBoardBinding = {
      boardId: subject.id,
      grantId: member.id,
      sessionId: identity.id,
      sessionIncarnation: identity.incarnation,
      runtimeGeneration: identity.runtimeGeneration,
      capability: 'copied-secret',
      role: member.role,
      allowedActions: member.allowedActions,
      boardEpoch: subject.boardEpoch,
      coordinatorEpoch: subject.coordinatorEpoch,
      updatedAt: at,
    };

    // Act
    const actual = isCapabilityBoundToSession({
      board: subject,
      grant: member,
      binding,
      bindingCapabilityHash: 'copied-secret-hash',
      credential: {
        sessionId: identity.id,
        runtimeGeneration: identity.runtimeGeneration,
        capabilityHash: member.capabilityHash,
      },
      session: identity,
    });

    // Assert
    should(actual).be.false();
  });

  it('should refuse an invitation proof without the invitee session proof', () => {
    // Arrange
    const identity = session({ id: 'external' });
    const invitation: TaskBoardInvitation = {
      requestId: 'invite-1',
      fingerprint: 'invite-fingerprint',
      boardEpoch: 1,
      sourceGrantId: 'grant-root',
      sourceSessionId: 'root',
      sourceSessionIncarnation: 'root-incarnation',
      sourceRuntimeGeneration: 1,
      targetSessionId: 'external',
      targetSessionIncarnation: identity.incarnation,
      targetRuntimeGeneration: 1,
      coordinatorGrantId: 'grant-coordinator',
      coordinatorSessionId: 'coordinator',
      coordinatorSessionIncarnation: 'coordinator-incarnation',
      coordinatorRuntimeGeneration: 1,
      coordinatorLineage: ['coordinator', 'root'],
      coordinatorEpoch: 1,
      createdAt: at,
      expiresAt: '2026-07-31T12:00:00.000Z',
      status: 'approved',
      approvedAt: at,
      approvedBySessionId: 'coordinator',
      acceptanceCapabilityHash: 'invitation-hash',
    };
    const proof: TaskBoardInvitationProof = {
      boardId: 'board-1',
      invitationRequestId: 'invite-1',
      targetSessionId: 'external',
      targetSessionIncarnation: identity.incarnation,
      targetRuntimeGeneration: 1,
      sessionCapabilityHash: identity.sessionCapabilityHash,
      invitationCapability: 'invitation-secret',
      invitationCapabilityHash: 'invitation-hash',
      expiresAt: invitation.expiresAt,
    };

    // Act
    const actual = isInvitationProofBoundToSession({
      proof,
      invitation,
      session: identity,
      sessionCapabilityHash: 'wrong-session-hash',
      invitationCapabilityHash: 'invitation-hash',
    });

    // Assert
    should(actual).be.false();
  });

  it('should bind an invitation proof to both exact invitee proofs', () => {
    // Arrange
    const identity = session({ id: 'external' });
    const invitation: TaskBoardInvitation = {
      requestId: 'invite-1',
      fingerprint: 'invite-fingerprint',
      boardEpoch: 1,
      sourceGrantId: 'grant-root',
      sourceSessionId: 'root',
      sourceSessionIncarnation: 'root-incarnation',
      sourceRuntimeGeneration: 1,
      targetSessionId: 'external',
      targetSessionIncarnation: identity.incarnation,
      targetRuntimeGeneration: 1,
      coordinatorGrantId: 'grant-coordinator',
      coordinatorSessionId: 'coordinator',
      coordinatorSessionIncarnation: 'coordinator-incarnation',
      coordinatorRuntimeGeneration: 1,
      coordinatorLineage: ['coordinator', 'root'],
      coordinatorEpoch: 1,
      createdAt: at,
      expiresAt: '2026-07-31T12:00:00.000Z',
      status: 'approved',
      approvedAt: at,
      approvedBySessionId: 'coordinator',
      acceptanceCapabilityHash: 'invitation-hash',
    };
    const proof: TaskBoardInvitationProof = {
      boardId: 'board-1',
      invitationRequestId: 'invite-1',
      targetSessionId: 'external',
      targetSessionIncarnation: identity.incarnation,
      targetRuntimeGeneration: 1,
      sessionCapabilityHash: identity.sessionCapabilityHash,
      invitationCapability: 'invitation-secret',
      invitationCapabilityHash: 'invitation-hash',
      expiresAt: invitation.expiresAt,
    };

    // Act
    const actual = isInvitationProofBoundToSession({
      proof,
      invitation,
      session: identity,
      sessionCapabilityHash: identity.sessionCapabilityHash,
      invitationCapabilityHash: 'invitation-hash',
    });

    // Assert
    should(actual).be.true();
  });
});

describe('membership-widening policy', () => {
  it('should require the top membership root to request and current coordinator to approve', () => {
    // Arrange
    const subject = board();
    const rootAuthorization: TaskBoardAuthorization = {
      boardId: subject.id,
      grantId: 'grant-root',
      sessionId: 'root',
      role: 'top_agent',
      allowedActions: actionsForTaskBoardRole('top_agent'),
      boardEpoch: 1,
      coordinatorEpoch: 1,
      runtimeGeneration: 1,
    };
    const coordinatorAuthorization: TaskBoardAuthorization = {
      boardId: subject.id,
      grantId: 'grant-coordinator',
      sessionId: 'coordinator',
      role: 'coordinator',
      allowedActions: CURRENT_COORDINATOR_ACTIONS,
      boardEpoch: 1,
      coordinatorEpoch: 1,
      runtimeGeneration: 1,
    };

    // Act
    const actual = {
      rootMayRequest: hasExplicitInvitationAuthority(subject, rootAuthorization, 'request'),
      rootMayApprove: hasExplicitInvitationAuthority(subject, rootAuthorization, 'approve'),
      coordinatorMayRequest: hasExplicitInvitationAuthority(subject, coordinatorAuthorization, 'request'),
      coordinatorMayApprove: hasExplicitInvitationAuthority(subject, coordinatorAuthorization, 'approve'),
      wardenMayWiden: canWardenWidenBoardMembership(),
    };

    // Assert
    should(actual).deepEqual({
      rootMayRequest: true,
      rootMayApprove: false,
      coordinatorMayRequest: false,
      coordinatorMayApprove: true,
      wardenMayWiden: false,
    });
  });
});

/**
 * A live membership root: the tree a coordinator may be re-homed into.
 *
 * A grant row outlives the pane it was written for — nothing revokes it when a session dies — so every
 * case here is a way "an active root grant" and "a root that is actually there" come apart. Handing the
 * board's only approval key to a descendant of a stopped tree would leave nobody able to approve
 * anything, which is the outage this walk exists to prevent.
 */
describe('the live membership root grant', () => {
  const ROOT_SESSION = session({ id: 'root' });

  function bindingFor(subject: TaskBoard, grantId: string, identity: TaskBoardSession): TaskBoardBinding {
    const held = subject.grants.find(candidate => candidate.id === grantId);
    if (held === undefined) throw new Error(`test fixture is missing ${grantId}`);
    return {
      boardId: subject.id,
      grantId: held.id,
      sessionId: identity.id,
      sessionIncarnation: identity.incarnation,
      runtimeGeneration: identity.runtimeGeneration,
      capability: `secret:${grantId}`,
      role: held.role,
      allowedActions: held.allowedActions,
      boardEpoch: subject.boardEpoch,
      coordinatorEpoch: subject.coordinatorEpoch,
      updatedAt: at,
    };
  }

  function resolve(
    overrides: {
      readonly grants?: readonly TaskBoardGrant[];
      readonly session?: TaskBoardSession | null;
      readonly bindings?: (subject: TaskBoard) => readonly TaskBoardBinding[];
    } = {},
  ): string | null {
    const subject = board(overrides.grants === undefined ? {} : { grants: overrides.grants });
    const identity = overrides.session === undefined ? ROOT_SESSION : overrides.session;
    return (
      liveMembershipRootGrant({
        board: subject,
        bindings: (overrides.bindings ?? (candidate => [bindingFor(candidate, 'grant-root', ROOT_SESSION)]))(subject),
        sessions: identity === null ? [] : [identity],
        sessionId: 'root',
      })?.id ?? null
    );
  }

  it('should resolve a root only while its session, its grant and its binding all still agree', () => {
    // Arrange + Act
    const actual = {
      liveBoundRoot: resolve(),
      unknownSession: resolve({ session: null }),
      stoppedSession: resolve({ session: { ...ROOT_SESSION, active: false } }),
      revivedSession: resolve({ session: { ...ROOT_SESSION, runtimeGeneration: 2 } }),
      reincarnatedSession: resolve({ session: { ...ROOT_SESSION, incarnation: 'root-later' } }),
      revokedGrant: resolve({
        grants: board().grants.map(candidate =>
          candidate.id === 'grant-root' ? { ...candidate, active: false } : candidate,
        ),
      }),
      notItsOwnRoot: resolve({
        grants: board().grants.map(candidate =>
          candidate.id === 'grant-root' ? { ...candidate, membershipRootSessionId: 'elsewhere' } : candidate,
        ),
      }),
      notATopAgent: resolve({
        grants: board().grants.map(candidate =>
          candidate.id === 'grant-root' ? { ...candidate, role: 'coordinator' as const } : candidate,
        ),
      }),
      unbound: resolve({ bindings: () => [] }),
      staleBindingEpoch: resolve({
        bindings: subject => [{ ...bindingFor(subject, 'grant-root', ROOT_SESSION), boardEpoch: 2 }],
      }),
      bindingOfAnotherBoard: resolve({
        bindings: subject => [{ ...bindingFor(subject, 'grant-root', ROOT_SESSION), boardId: 'board-2' }],
      }),
    };

    // Assert — one resolution, and every disagreement is a refusal rather than a best effort.
    should(actual).deepEqual({
      liveBoundRoot: 'grant-root',
      unknownSession: null,
      stoppedSession: null,
      revivedSession: null,
      reincarnatedSession: null,
      revokedGrant: null,
      notItsOwnRoot: null,
      notATopAgent: null,
      unbound: null,
      staleBindingEpoch: null,
      bindingOfAnotherBoard: null,
    });
  });
});

describe('worker confinement and assignee resolution', () => {
  it('should fail closed when a worker mutation omits an assignee', () => {
    // Act
    const actual = canWorkerPerformAssignedMutation('worker', 'status', 'worker-1', undefined);

    // Assert
    should(actual).be.false();
  });

  it('should resolve exact ids and unique names but refuse ambiguous names', () => {
    // Arrange
    const sessions = [
      session({ id: 'worker-1', teammate: 'sam' }),
      session({ id: 'worker-2', teammate: 'sam' }),
      session({ id: 'worker-3', name: 'unique' }),
    ];

    // Act
    const actual = {
      exact: exactWorkerAssignee({ assignee: 'worker-1' }, sessions),
      unique: exactWorkerAssignee({ assignee: 'unique' }, sessions),
      ambiguous: exactWorkerAssignee({ assignee: 'sam' }, sessions),
      blank: exactWorkerAssignee({ assignee: '  ' }, sessions),
    };

    // Assert
    should(actual).deepEqual({ exact: 'worker-1', unique: 'worker-3', ambiguous: null, blank: null });
  });
});
