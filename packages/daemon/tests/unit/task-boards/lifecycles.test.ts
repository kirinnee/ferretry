import { describe, it } from 'bun:test';
import { compareProtocolVersions } from '@ferretry/protocol';
import should from 'should';
import { TaskBoardAuthorizationService } from '../../../src/lib/task-boards/authorization-service.ts';
import { TaskBoardChildGrantService } from '../../../src/lib/task-boards/child-grant-service.ts';
import { TaskBoardCreationService } from '../../../src/lib/task-boards/creation-service.ts';
import { isTaskBoardError, TaskBoardError } from '../../../src/lib/task-boards/error.ts';
import { TaskBoardInvitationService } from '../../../src/lib/task-boards/invitation-service.ts';
import {
  CHILD_GRANT_PROMOTION_REVOKE_REASON,
  TaskBoardMembershipService,
} from '../../../src/lib/task-boards/membership-service.ts';
import {
  actionsForTaskBoardRole,
  CURRENT_COORDINATOR_ACTIONS,
  hasExplicitInvitationAuthority,
  isExplicitBoardMember,
  isGrantWithinActiveMembershipTree,
} from '../../../src/lib/task-boards/policy.ts';
import {
  EMPTY_TASK_BOARD_REPOSITORY_STATE,
  type TaskBoardAuthorization,
  type TaskBoardRepositoryState,
  type TaskBoardSession,
} from '../../../src/lib/task-boards/types.ts';

const at = '2026-07-30T12:00:00.000Z';
const hash = (value: string): string => `hash:${value}`;

function session(input: Partial<TaskBoardSession> & Pick<TaskBoardSession, 'id'>): TaskBoardSession {
  return {
    id: input.id,
    incarnation: input.incarnation ?? `${input.id}-incarnation`,
    runtimeGeneration: input.runtimeGeneration ?? 1,
    parentSessionId: input.parentSessionId ?? null,
    mode: input.mode ?? 'interactive',
    active: input.active ?? true,
    name: null,
    teammate: null,
    sessionCapabilityHash: input.sessionCapabilityHash ?? hash(`session:${input.id}`),
  };
}

const sessions = [
  session({ id: 'root' }),
  session({ id: 'coordinator', parentSessionId: 'root', mode: 'auto' }),
  session({ id: 'child', parentSessionId: 'root', mode: 'auto' }),
  session({ id: 'replacement', parentSessionId: 'root', mode: 'auto' }),
  session({ id: 'external' }),
  // The replacement root's own tree: the coordinator it succeeds with, and one more descendant.
  session({ id: 'successor', parentSessionId: 'external', mode: 'auto' }),
  session({ id: 'successor-child', parentSessionId: 'external', mode: 'auto' }),
  // Two top-level strangers: one to invite after the succession, one to hold a board of its own.
  session({ id: 'stranger' }),
  session({ id: 'other-root' }),
  session({ id: 'other-coordinator', parentSessionId: 'other-root', mode: 'auto' }),
];

function createState(inputSessions: readonly TaskBoardSession[] = sessions): TaskBoardRepositoryState {
  return new TaskBoardCreationService().create(
    EMPTY_TASK_BOARD_REPOSITORY_STATE,
    inputSessions,
    { creatorSessionId: 'root', coordinatorSessionId: 'coordinator', requestId: 'create', at },
    {
      boardId: 'board',
      creatorGrantId: 'root-grant',
      creatorCapability: { value: 'root-secret', hash: hash('root-secret') },
      coordinatorGrantId: 'coordinator-grant',
      coordinatorCapability: { value: 'coordinator-secret', hash: hash('coordinator-secret') },
    },
  ).state;
}

const rootCredential = { sessionId: 'root', runtimeGeneration: 1, capabilityHash: hash('root-secret') };
const coordinatorCredential = {
  sessionId: 'coordinator',
  runtimeGeneration: 1,
  capabilityHash: hash('coordinator-secret'),
};

const externalCredential = { sessionId: 'external', runtimeGeneration: 1, capabilityHash: hash('external-secret') };
const successorCredential = { sessionId: 'successor', runtimeGeneration: 1, capabilityHash: hash('successor-secret') };

/**
 * The human operator, built by the real producer rather than hand-written.
 *
 * It has no session id and no runtime generation because the operator has neither, and every test that
 * replaces a coordinator goes through it: there is no session-shaped back door left to take.
 */
const OPERATOR: TaskBoardAuthorization = new TaskBoardAuthorizationService(hash).administrator(
  createState(),
  'board',
  'human_admin',
);

interface Services {
  authorization: TaskBoardAuthorizationService;
  children: TaskBoardChildGrantService;
  invitations: TaskBoardInvitationService;
  membership: TaskBoardMembershipService;
}

function services(): Services {
  const authorization = new TaskBoardAuthorizationService(hash);
  return {
    authorization,
    children: new TaskBoardChildGrantService(authorization),
    invitations: new TaskBoardInvitationService(authorization, hash),
    membership: new TaskBoardMembershipService(authorization),
  };
}

/**
 * The board at the exact moment a succession is legal: a worker child under the old root, and an
 * external root that has been invited, has accepted, and has produced a durable verify receipt.
 *
 * The child matters. It is revoked by the relinquish two steps later without ever being named, and it
 * is the case a retirement list built from "whatever is still active" would silently lose.
 */
function verifiedHandover(subject: Services): TaskBoardRepositoryState {
  const childRequested = subject.children.request(createState(), sessions, {
    source: rootCredential,
    targetSessionId: 'child',
    role: 'worker',
    requestId: 'succession-child',
    at,
  });
  const childApproved = subject.children.approve(
    childRequested.state,
    sessions,
    {
      coordinator: coordinatorCredential,
      grantRequestId: 'succession-child',
      requestId: 'succession-child-approve',
      at,
    },
    () => ({ grantId: 'child-grant', capability: { value: 'child-secret', hash: hash('child-secret') } }),
  );
  const requested = subject.invitations.request(childApproved.state, sessions, {
    source: rootCredential,
    targetSessionId: 'external',
    requestId: 'succession-invite',
    at,
  });
  const approved = subject.invitations.approve(
    requested.state,
    sessions,
    {
      coordinator: coordinatorCredential,
      invitationRequestId: 'succession-invite',
      requestId: 'succession-approve',
      at,
    },
    { acceptanceCapability: { value: 'succession-proof', hash: hash('succession-proof') } },
  );
  if (!approved.result.approved) throw new Error('fixture invitation did not approve');
  const accepted = subject.invitations.accept(
    approved.state,
    sessions,
    {
      target: { sessionId: 'external', runtimeGeneration: 1, capabilityHash: hash('session:external') },
      invitationCapability: 'succession-proof',
      requestId: 'succession-accept',
      at,
    },
    () => ({ grantId: 'external-grant', capability: { value: 'external-secret', hash: hash('external-secret') } }),
  );
  return subject.invitations.verify(accepted.state, sessions, {
    member: externalCredential,
    requestId: 'succession-verify',
    at,
  }).state;
}

/** The coordinator descendant has its working capability before its first launch. */
function grantedCoordinator(subject: Services, state = verifiedHandover(subject)): TaskBoardRepositoryState {
  const requested = subject.children.request(state, sessions, {
    source: externalCredential,
    targetSessionId: 'successor',
    role: 'coordinator',
    requestId: 'succession-coordinator-child',
    at,
  });
  const approved = subject.children.approve(
    requested.state,
    sessions,
    {
      coordinator: coordinatorCredential,
      grantRequestId: 'succession-coordinator-child',
      requestId: 'succession-coordinator-child-approve',
      at,
    },
    () => ({
      grantId: 'successor-coordinator-child-grant',
      capability: { value: 'successor-secret', hash: hash('successor-secret') },
    }),
  );
  if (!approved.result.approved) throw new Error('fixture coordinator child grant did not approve');
  return approved.state;
}

/** The verified handover, one step further on: `successor` holds the coordinator key. */
function succeeded(subject: Services): TaskBoardRepositoryState {
  return subject.membership.replaceCoordinator(
    grantedCoordinator(subject),
    sessions,
    {
      boardId: 'board',
      memberSessionId: 'root',
      administrator: OPERATOR,
      coordinatorSessionId: 'successor',
      replacementRootSessionId: 'external',
      requestId: 'succeed',
      at,
    },
    { grantId: 'successor-grant', capability: { value: 'successor-secret', hash: hash('successor-secret') } },
  ).state;
}

/** The whole row-48 board sequence: succeed the coordinator, then retire the old root's tree. */
function relinquished(subject: Services): TaskBoardRepositoryState {
  return subject.membership.relinquish(succeeded(subject), sessions, {
    member: rootCredential,
    requestId: 'succession-relinquish',
    at,
  }).state;
}

describe('TaskBoardChildGrantService', () => {
  it('should require an explicit request and current coordinator approval before binding a child', () => {
    // Arrange
    const subject = services();
    const requested = subject.children.request(createState(), sessions, {
      source: rootCredential,
      targetSessionId: 'child',
      role: 'worker',
      requestId: 'child-request',
      at,
    });

    // Act
    const actual = subject.children.approve(
      requested.state,
      sessions,
      { coordinator: coordinatorCredential, grantRequestId: 'child-request', requestId: 'child-approve', at },
      () => ({ grantId: 'child-grant', capability: { value: 'child-secret', hash: hash('child-secret') } }),
    );

    // Assert
    should(actual.result).deepEqual({
      approved: true,
      durableCapability: 'child-secret',
      membership: {
        sessionId: 'child',
        role: 'worker',
        allowedActions: ['read', 'status', 'note', 'feedback', 'file', 'link'],
        boardEpoch: 1,
        coordinatorEpoch: 1,
        runtimeGeneration: 1,
      },
    });
    should(actual.state.bindings.some(binding => binding.sessionId === 'child')).be.true();
  });

  it('should refuse a grant when the target tree position changed after its request', () => {
    // Arrange
    const subject = services();
    const requested = subject.children.request(createState(), sessions, {
      source: rootCredential,
      targetSessionId: 'child',
      role: 'read',
      requestId: 'changed-request',
      at,
    });
    const moved = sessions.map(candidate =>
      candidate.id === 'child' ? { ...candidate, parentSessionId: 'external' } : candidate,
    );

    // Act + Assert
    should(() =>
      subject.children.approve(
        requested.state,
        moved,
        { coordinator: coordinatorCredential, grantRequestId: 'changed-request', requestId: 'changed-approve', at },
        () => ({ grantId: 'changed-grant', capability: { value: 'changed-secret', hash: hash('changed-secret') } }),
      ),
    ).throw(TaskBoardError);
  });

  it('should persist expired and replayed approvals without reminting access', () => {
    // Arrange
    const subject = services();
    const requested = subject.children.request(createState(), sessions, {
      source: rootCredential,
      targetSessionId: 'child',
      role: 'read',
      requestId: 'replay-request',
      at,
    });
    const material = { grantId: 'replay-grant', capability: { value: 'replay-secret', hash: hash('replay-secret') } };
    const approved = subject.children.approve(
      requested.state,
      sessions,
      { coordinator: coordinatorCredential, grantRequestId: 'replay-request', requestId: 'replay-approve', at },
      () => material,
    );

    // Act
    let materialRequested = false;
    const replay = subject.children.approve(
      approved.state,
      sessions,
      { coordinator: coordinatorCredential, grantRequestId: 'replay-request', requestId: 'replay-approve', at },
      () => {
        materialRequested = true;
        return {
          grantId: 'unused-replay-grant',
          capability: { value: 'unused-replay-secret', hash: hash('unused-replay-secret') },
        };
      },
    );
    const expiredRequested = subject.children.request(createState(), sessions, {
      source: rootCredential,
      targetSessionId: 'child',
      role: 'read',
      requestId: 'expired-request',
      at,
    });
    const expired = subject.children.approve(
      expiredRequested.state,
      sessions,
      {
        coordinator: coordinatorCredential,
        grantRequestId: 'expired-request',
        requestId: 'expired-approve',
        at: '2026-08-01T12:00:00.000Z',
      },
      () => ({ grantId: 'expired-grant', capability: { value: 'expired-secret', hash: hash('expired-secret') } }),
    );

    // Assert
    should(replay.state).equal(approved.state);
    should(replay.result).deepEqual(approved.result);
    should(materialRequested).be.false();
    should(expired.result).deepEqual({
      approved: false,
      request: {
        requestId: 'expired-request',
        targetSessionId: 'child',
        requestedRole: 'read',
        createdAt: at,
        expiresAt: '2026-07-31T12:00:00.000Z',
        status: 'expired',
      },
    });
  });
});

describe('TaskBoardInvitationService', () => {
  it('should require request, coordinator approval, and invitee proof before granting an external root', () => {
    // Arrange
    const subject = services();
    const requested = subject.invitations.request(createState(), sessions, {
      source: rootCredential,
      targetSessionId: 'external',
      requestId: 'invite',
      at,
    });
    should(requested.state.bindings.some(binding => binding.sessionId === 'external')).be.false();
    const approved = subject.invitations.approve(
      requested.state,
      sessions,
      { coordinator: coordinatorCredential, invitationRequestId: 'invite', requestId: 'approve', at },
      { acceptanceCapability: { value: 'invite-secret', hash: hash('invite-secret') } },
    );
    if (!approved.result.approved) throw new Error('fixture invitation did not approve');

    // Act
    const actual = subject.invitations.accept(
      approved.state,
      sessions,
      {
        target: { sessionId: 'external', runtimeGeneration: 1, capabilityHash: hash('session:external') },
        invitationCapability: approved.result.acceptanceCapability,
        requestId: 'accept',
        at,
      },
      () => ({ grantId: 'external-grant', capability: { value: 'external-secret', hash: hash('external-secret') } }),
    );

    // Assert
    should(actual.result).deepEqual({
      accepted: true,
      durableCapability: 'external-secret',
      grantId: 'external-grant',
      membership: {
        sessionId: 'external',
        role: 'top_agent',
        allowedActions: [
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
          'grant_request',
          'invite_request',
          'membership_relinquish',
        ],
        boardEpoch: 1,
        coordinatorEpoch: 1,
        runtimeGeneration: 1,
      },
    });
    should(actual.state.invitationProofs).have.length(0);
    should(
      subject.authorization.authorize(
        actual.state,
        sessions,
        { sessionId: 'external', runtimeGeneration: 1, capabilityHash: hash('external-secret') },
        'read',
      ).role,
    ).equal('top_agent');
  });

  it('should replay a committed acceptance before requiring a fresh approved invitation', () => {
    // Arrange
    const subject = services();
    const requested = subject.invitations.request(createState(), sessions, {
      source: rootCredential,
      targetSessionId: 'external',
      requestId: 'replay-invite',
      at,
    });
    const approved = subject.invitations.approve(
      requested.state,
      sessions,
      {
        coordinator: coordinatorCredential,
        invitationRequestId: 'replay-invite',
        requestId: 'replay-invite-approve',
        at,
      },
      { acceptanceCapability: { value: 'replay-proof', hash: hash('replay-proof') } },
    );
    if (!approved.result.approved) throw new Error('fixture invitation did not approve');
    const command = {
      target: { sessionId: 'external', runtimeGeneration: 1, capabilityHash: hash('session:external') },
      invitationCapability: approved.result.acceptanceCapability,
      requestId: 'replay-accept',
      at,
    };
    const accepted = subject.invitations.accept(approved.state, sessions, command, () => ({
      grantId: 'replay-external-grant',
      capability: { value: 'replay-external-secret', hash: hash('replay-external-secret') },
    }));

    // Act — a replay returns before asking for fresh material.
    let materialRequested = false;
    const replay = subject.invitations.accept(accepted.state, sessions, command, () => {
      materialRequested = true;
      return {
        grantId: 'unused-replay-grant',
        capability: { value: 'unused-replay-secret', hash: hash('unused-replay-secret') },
      };
    });

    // Assert
    should(replay.state).equal(accepted.state);
    should(replay.result).deepEqual(accepted.result);
    should(materialRequested).be.false();
    should(() =>
      subject.invitations.accept(
        accepted.state,
        sessions.map(candidate => (candidate.id === 'external' ? { ...candidate, runtimeGeneration: 2 } : candidate)),
        {
          ...command,
          target: { ...command.target, runtimeGeneration: 2 },
        },
        () => ({
          grantId: 'changed-generation-grant',
          capability: { value: 'changed-generation-secret', hash: hash('changed-generation-secret') },
        }),
      ),
    ).throw(/invitation acceptance request id was reused/u);
  });

  it('should reject an unaccepted invitation, a descendant invitee, and a stolen acceptance secret', () => {
    // Arrange
    const subject = services();
    const state = createState();
    const requested = subject.invitations.request(state, sessions, {
      source: rootCredential,
      targetSessionId: 'external',
      requestId: 'stolen',
      at,
    });
    const approved = subject.invitations.approve(
      requested.state,
      sessions,
      { coordinator: coordinatorCredential, invitationRequestId: 'stolen', requestId: 'stolen-approve', at },
      { acceptanceCapability: { value: 'secret', hash: hash('secret') } },
    );
    if (!approved.result.approved) throw new Error('fixture invitation did not approve');

    // Act + Assert
    should(() =>
      subject.invitations.request(state, sessions, {
        source: rootCredential,
        targetSessionId: 'child',
        requestId: 'child-invite',
        at,
      }),
    ).throw(TaskBoardError);
    should(() =>
      subject.authorization.authorize(
        requested.state,
        sessions,
        { sessionId: 'external', runtimeGeneration: 1, capabilityHash: hash('secret') },
        'read',
      ),
    ).throw(TaskBoardError);
    should(() =>
      subject.invitations.accept(
        approved.state,
        sessions,
        {
          target: { sessionId: 'external', runtimeGeneration: 1, capabilityHash: hash('session:external') },
          invitationCapability: 'stolen-secret',
          requestId: 'stolen-accept',
          at,
        },
        () => ({ grantId: 'unused', capability: { value: 'unused', hash: hash('unused') } }),
      ),
    ).throw(TaskBoardError);
  });

  it('should expire an invitation instead of approving it after its proof window', () => {
    // Arrange
    const subject = services();
    const requested = subject.invitations.request(createState(), sessions, {
      source: rootCredential,
      targetSessionId: 'external',
      requestId: 'expired-invitation',
      at,
    });

    // Act
    const actual = subject.invitations.approve(
      requested.state,
      sessions,
      {
        coordinator: coordinatorCredential,
        invitationRequestId: 'expired-invitation',
        requestId: 'expired-invitation-approve',
        at: '2026-08-01T12:00:00.000Z',
      },
      { acceptanceCapability: { value: 'unused', hash: hash('unused') } },
    );

    // Assert
    should(actual.result.approved).be.false();
    should(actual.state.boards[0]?.invitations[0]?.status).equal('expired');
  });

  it('should expire an approved invitation only after the exact invitee proves possession', () => {
    // Arrange
    const subject = services();
    const requested = subject.invitations.request(createState(), sessions, {
      source: rootCredential,
      targetSessionId: 'external',
      requestId: 'expired-accept',
      at,
    });
    const approved = subject.invitations.approve(
      requested.state,
      sessions,
      {
        coordinator: coordinatorCredential,
        invitationRequestId: 'expired-accept',
        requestId: 'expired-accept-approve',
        at,
      },
      { acceptanceCapability: { value: 'expired-proof', hash: hash('expired-proof') } },
    );
    if (!approved.result.approved) throw new Error('fixture invitation did not approve');

    // Act
    const actual = subject.invitations.accept(
      approved.state,
      sessions,
      {
        target: { sessionId: 'external', runtimeGeneration: 1, capabilityHash: hash('session:external') },
        invitationCapability: approved.result.acceptanceCapability,
        requestId: 'expired-accept-request',
        at: '2026-08-01T12:00:00.000Z',
      },
      () => ({
        grantId: 'unused-expired-grant',
        capability: { value: 'unused-expired', hash: hash('unused-expired') },
      }),
    );

    // Assert
    should(actual.result.accepted).be.false();
    should(actual.state.boards[0]?.invitations[0]?.status).equal('expired');
  });
});

describe('TaskBoardMembershipService', () => {
  it('should preserve the old root until the replacement proves it can act and receives the coordinator', () => {
    // Arrange
    const subject = services();
    const requested = subject.invitations.request(createState(), sessions, {
      source: rootCredential,
      targetSessionId: 'external',
      requestId: 'relinquish-invite',
      at,
    });
    const approved = subject.invitations.approve(
      requested.state,
      sessions,
      {
        coordinator: coordinatorCredential,
        invitationRequestId: 'relinquish-invite',
        requestId: 'relinquish-approve',
        at,
      },
      { acceptanceCapability: { value: 'relinquish-proof', hash: hash('relinquish-proof') } },
    );
    if (!approved.result.approved) throw new Error('fixture invitation did not approve');
    const accepted = subject.invitations.accept(
      approved.state,
      sessions,
      {
        target: { sessionId: 'external', runtimeGeneration: 1, capabilityHash: hash('session:external') },
        invitationCapability: 'relinquish-proof',
        requestId: 'relinquish-accept',
        at,
      },
      () => ({ grantId: 'external-grant', capability: { value: 'external-secret', hash: hash('external-secret') } }),
    );

    // Acceptance writes a grant but does not prove the replacement received its capability. This is
    // the failure mode a cross-harness handover must survive: the old root remains intact.
    should(() =>
      subject.membership.relinquish(accepted.state, sessions, {
        member: rootCredential,
        requestId: 'relinquish-before-verify',
        at,
      }),
    ).throw(TaskBoardError);
    should(accepted.state.boards[0]?.grants.find(grant => grant.id === 'root-grant')?.active).be.true();

    const verified = subject.invitations.verify(accepted.state, sessions, {
      member: { sessionId: 'external', runtimeGeneration: 1, capabilityHash: hash('external-secret') },
      requestId: 'relinquish-verify',
      at,
    });

    // Verification alone leaves the coordinator under the retiring root. Because the new root would
    // survive, relinquish must still refuse until the operator moves the key into that tree.
    should(() =>
      subject.membership.relinquish(verified.state, sessions, {
        member: rootCredential,
        requestId: 'relinquish-before-coordinator-move',
        at,
      }),
    ).throw(/move the coordinator into a surviving membership tree first/u);
    const coordinatorGranted = grantedCoordinator(subject, verified.state);
    const succeeded = subject.membership.replaceCoordinator(
      coordinatorGranted,
      sessions,
      {
        boardId: 'board',
        memberSessionId: 'root',
        administrator: OPERATOR,
        coordinatorSessionId: 'successor',
        replacementRootSessionId: 'external',
        requestId: 'relinquish-coordinator-move',
        at,
      },
      { grantId: 'successor-grant', capability: { value: 'successor-secret', hash: hash('successor-secret') } },
    );

    // Act
    const actual = subject.membership.relinquish(succeeded.state, sessions, {
      member: rootCredential,
      requestId: 'relinquish',
      at,
    });

    // Assert
    should(actual.result).deepEqual({ relinquished: true, sessionId: 'root', sessionStopped: false });
    should(actual.state.boards[0]?.grants.find(grant => grant.id === 'root-grant')?.active).be.false();
    should(actual.state.bindings.some(binding => binding.sessionId === 'root')).be.false();
    should(() => subject.authorization.authorize(actual.state, sessions, rootCredential, 'read')).throw(TaskBoardError);
    should(
      subject.authorization.authorize(
        actual.state,
        sessions,
        { sessionId: 'external', runtimeGeneration: 1, capabilityHash: hash('external-secret') },
        'read',
      ),
    ).have.property('sessionId', 'external');
  });

  it('should replay an exact relinquish after its source binding is gone', () => {
    // Arrange
    const subject = services();
    const command = { member: rootCredential, requestId: 'relinquish-crash-retry', at } as const;
    const applied = subject.membership.relinquish(succeeded(subject), sessions, command);
    const corruptedFingerprint = {
      ...applied.state,
      boards: applied.state.boards.map(board => ({
        ...board,
        appliedOperations: board.appliedOperations.map(operation =>
          operation.requestId === command.requestId ? { ...operation, fingerprint: 'damaged' } : operation,
        ),
      })),
    };

    // Act
    const replayed = subject.membership.relinquish(applied.state, sessions, command);

    // Assert — replay returns the original receipt without a second mutation even though live
    // authorization is now impossible. Its durable fingerprint and capability-derived subject are
    // both mandatory; neither a damaged ledger nor a different bearer can enter this exception.
    should(applied.state.bindings.some(binding => binding.sessionId === 'root')).be.false();
    should(replayed.state).exactly(applied.state);
    should(replayed.result).deepEqual({ relinquished: true, sessionId: 'root', sessionStopped: false });
    should(() => subject.membership.relinquish(corruptedFingerprint, sessions, command)).throw(
      /membership relinquish request id was reused/u,
    );
    should(() =>
      subject.membership.relinquish(applied.state, sessions, {
        ...command,
        member: { ...rootCredential, capabilityHash: hash('different-secret') },
      }),
    ).throw(TaskBoardError);
  });

  it('should move the coordinator key into the verified replacement root’s own tree', () => {
    // Arrange
    const subject = services();
    const before = grantedCoordinator(subject);

    // Act
    const actual = subject.membership.replaceCoordinator(
      before,
      sessions,
      {
        boardId: 'board',
        memberSessionId: 'root',
        administrator: OPERATOR,
        coordinatorSessionId: 'successor',
        replacementRootSessionId: 'external',
        requestId: 'succeed',
        at,
      },
      { grantId: 'successor-grant', capability: { value: 'successor-secret', hash: hash('successor-secret') } },
    );
    const board = actual.state.boards[0];

    // Assert — the new key is rooted in the SUCCEEDING tree, which is what survives the relinquish.
    should(actual.result.membership.sessionId).equal('successor');
    should(board?.coordinatorSessionId).equal('successor');
    should(board?.grants.find(grant => grant.id === 'successor-grant')?.membershipRootSessionId).equal('external');
    should(board?.grants.find(grant => grant.id === 'successor-coordinator-child-grant')).match({
      active: false,
      capabilityHash: hash('successor-secret'),
      revokeReason: CHILD_GRANT_PROMOTION_REVOKE_REASON,
    });
    should(board?.grants.find(grant => grant.id === 'successor-grant')?.capabilityHash).equal(hash('successor-secret'));
    should(actual.state.bindings.find(binding => binding.sessionId === 'successor')).match({
      grantId: 'successor-grant',
      capability: 'successor-secret',
    });
    should(subject.authorization.authorize(actual.state, sessions, successorCredential, 'grant_approve').role).equal(
      'coordinator',
    );
    should(() => subject.authorization.authorize(actual.state, sessions, coordinatorCredential, 'grant_approve')).throw(
      TaskBoardError,
    );
    // The old coordinator retires in the same write that revokes it: no interval with no address.
    should(board?.retiredSessionIds).deepEqual(['coordinator']);
    // Attribution is the operator's, truthfully: no session id, no runtime generation, and a NAME
    // rather than a borrowed member's id. The root appears only as where the key was re-homed.
    should(board?.appliedOperations.find(operation => operation.kind === 'coordinator.replace')).match({
      actorSessionId: null,
      actorGrantId: 'human-admin',
      actorRuntimeGeneration: null,
      resultGrantId: 'successor-grant',
      resultSessionId: 'successor',
    });
    should(board?.audit.filter(entry => entry.event === 'coordinator.replaced')).match([
      {
        actorSessionId: null,
        actorName: 'user',
        outcome: 'applied',
        detail: { membershipRootSessionId: 'external' },
      },
    ]);
    // The board itself never moved.
    should(board).match({ id: 'board', creatorSessionId: 'root', canonicalSessionId: 'root', createdAt: at });
  });

  it('should refuse coordinator replacement to every caller that is not the operator principal', () => {
    // Arrange
    const subject = services();
    const verified = verifiedHandover(subject);
    const material = {
      grantId: 'refused-grant',
      capability: { value: 'refused-secret', hash: hash('refused-secret') },
    };
    const replace = (
      state: TaskBoardRepositoryState,
      command: Partial<{
        boardId: string;
        memberSessionId: string;
        administrator: TaskBoardAuthorization;
        coordinatorSessionId: string;
        replacementRootSessionId: string;
      }>,
      requestId: string,
    ): void => {
      subject.membership.replaceCoordinator(
        state,
        sessions,
        {
          boardId: command.boardId ?? 'board',
          memberSessionId: command.memberSessionId ?? 'root',
          administrator: command.administrator ?? OPERATOR,
          coordinatorSessionId: command.coordinatorSessionId ?? 'successor',
          replacementRootSessionId: command.replacementRootSessionId ?? 'external',
          requestId,
          at,
        },
        material,
      );
    };

    // Act + Assert — no MEMBER may re-appoint the coordinator that checks it, root included. This is
    // the case that matters: a real, currently valid root authorization is still refused here.
    should(() =>
      replace(
        verified,
        { administrator: subject.authorization.authorize(verified, sessions, rootCredential, 'read') },
        'by-a-root',
      ),
    ).throw(TaskBoardError);
    should(() =>
      replace(
        verified,
        { administrator: subject.authorization.authorize(verified, sessions, coordinatorCredential, 'read') },
        'by-the-coordinator',
      ),
    ).throw(TaskBoardError);
    // A principal wearing the right role but carrying session terms is a forged one.
    should(() => replace(verified, { administrator: { ...OPERATOR, sessionId: 'root' } }, 'named-session')).throw(
      TaskBoardError,
    );
    should(() => replace(verified, { administrator: { ...OPERATOR, runtimeGeneration: 1 } }, 'named-generation')).throw(
      TaskBoardError,
    );
    // An operator authorization for a DIFFERENT board does not carry to this one.
    should(() => replace(verified, { administrator: { ...OPERATOR, boardId: 'other-board' } }, 'other-board')).throw(
      TaskBoardError,
    );
    should(() => replace(verified, { boardId: 'absent-board' }, 'on-another-board')).throw(TaskBoardError);
    // A stopped root cannot receive the coordinator key, however live its grant still looks.
    should(() =>
      subject.membership.replaceCoordinator(
        verified,
        sessions.map(candidate => (candidate.id === 'external' ? { ...candidate, active: false } : candidate)),
        {
          boardId: 'board',
          memberSessionId: 'root',
          administrator: OPERATOR,
          coordinatorSessionId: 'successor',
          replacementRootSessionId: 'external',
          requestId: 'stopped-root',
          at,
        },
        material,
      ),
    ).throw(TaskBoardError);
    // A revived root is a different incarnation than the one its grant was written for.
    should(() =>
      subject.membership.replaceCoordinator(
        verified,
        sessions.map(candidate => (candidate.id === 'external' ? { ...candidate, runtimeGeneration: 2 } : candidate)),
        {
          boardId: 'board',
          memberSessionId: 'root',
          administrator: OPERATOR,
          coordinatorSessionId: 'successor',
          replacementRootSessionId: 'external',
          requestId: 'revived-root',
          at,
        },
        material,
      ),
    ).throw(TaskBoardError);
    // The new coordinator is a DESCENDANT of a root, never a root and never an unbound stranger.
    should(() => replace(verified, { coordinatorSessionId: 'external' }, 'the-root-itself')).throw(TaskBoardError);
    should(() => replace(verified, { coordinatorSessionId: 'stranger' }, 'no-root-above-it')).throw(TaskBoardError);
    should(() => replace(verified, { coordinatorSessionId: 'coordinator' }, 'already-bound')).throw(TaskBoardError);
  });

  it('should refuse rather than silently elevate an ordinary bound member', () => {
    // Arrange — this worker belongs to the expected replacement tree and presents its real capability.
    const subject = services();
    const requested = subject.children.request(verifiedHandover(subject), sessions, {
      source: externalCredential,
      targetSessionId: 'successor',
      role: 'worker',
      requestId: 'ordinary-member-request',
      at,
    });
    const approved = subject.children.approve(
      requested.state,
      sessions,
      {
        coordinator: coordinatorCredential,
        grantRequestId: 'ordinary-member-request',
        requestId: 'ordinary-member-approve',
        at,
      },
      () => ({
        grantId: 'ordinary-member-grant',
        capability: { value: 'worker-secret', hash: hash('worker-secret') },
      }),
    );
    if (!approved.result.approved) throw new Error('fixture worker child grant did not approve');
    const workerCredential = {
      sessionId: 'successor',
      runtimeGeneration: 1,
      capabilityHash: hash('worker-secret'),
    };

    // Act + Assert — matching material is insufficient: only the exact coordinator child grant promotes.
    should(() =>
      subject.membership.replaceCoordinator(
        approved.state,
        sessions,
        {
          boardId: 'board',
          memberSessionId: 'root',
          administrator: OPERATOR,
          coordinatorSessionId: 'successor',
          replacementRootSessionId: 'external',
          requestId: 'ordinary-member-replacement',
          at,
        },
        { grantId: 'ordinary-member-promotion', capability: { value: 'worker-secret', hash: hash('worker-secret') } },
      ),
    ).throw(TaskBoardError);
    should(subject.authorization.authorize(approved.state, sessions, workerCredential, 'read')).match({
      grantId: 'ordinary-member-grant',
      role: 'worker',
    });
    should(() => subject.authorization.authorize(approved.state, sessions, workerCredential, 'grant_approve')).throw(
      TaskBoardError,
    );
  });

  it('should refuse a replacement whose live binding belongs to another board', () => {
    // Arrange — every promotion term is valid except the binding's board id. Keep the matching child
    // grant on this board so removing that one boundary would silently make the replacement succeed.
    const subject = services();
    const withOther = new TaskBoardCreationService().create(
      grantedCoordinator(subject),
      sessions,
      { creatorSessionId: 'other-root', coordinatorSessionId: 'other-coordinator', requestId: 'other-create', at },
      {
        boardId: 'other-board',
        creatorGrantId: 'other-root-grant',
        creatorCapability: { value: 'other-root-secret', hash: hash('other-root-secret') },
        coordinatorGrantId: 'other-coordinator-grant',
        coordinatorCapability: { value: 'other-coordinator-secret', hash: hash('other-coordinator-secret') },
      },
    ).state;
    const crossBound: TaskBoardRepositoryState = {
      ...withOther,
      bindings: withOther.bindings.map(binding =>
        binding.sessionId === 'successor' ? { ...binding, boardId: 'other-board' } : binding,
      ),
    };

    // Act + Assert — ancestry cannot carry authority across the board boundary.
    should(() =>
      subject.membership.replaceCoordinator(
        crossBound,
        sessions,
        {
          boardId: 'board',
          memberSessionId: 'root',
          administrator: OPERATOR,
          coordinatorSessionId: 'successor',
          replacementRootSessionId: 'external',
          requestId: 'cross-board-replacement',
          at,
        },
        {
          grantId: 'cross-board-promotion',
          capability: { value: 'successor-secret', hash: hash('successor-secret') },
        },
      ),
    ).throw(TaskBoardError);
    should(crossBound.bindings.find(binding => binding.sessionId === 'successor')?.boardId).equal('other-board');
    should(crossBound.boards.find(candidate => candidate.id === 'board')?.coordinatorGrantId).equal(
      'coordinator-grant',
    );
  });

  it('should replay one succession and conflict on every changed payload identity under the same request id', () => {
    // Arrange
    const subject = services();
    const state = succeeded(subject);
    const material = {
      grantId: 'successor-grant-2',
      capability: { value: 'successor-secret', hash: hash('successor-secret') },
    };

    // Act
    const replay = subject.membership.replaceCoordinator(
      state,
      sessions,
      {
        boardId: 'board',
        memberSessionId: 'root',
        administrator: OPERATOR,
        coordinatorSessionId: 'successor',
        replacementRootSessionId: 'external',
        requestId: 'succeed',
        at,
      },
      material,
    );

    // Assert — a retried succession mints nothing; a DIFFERENT one under the same id is a conflict.
    should(replay.state).equal(state);
    should(replay.result).deepEqual({
      replaced: true,
      membership: {
        sessionId: 'successor',
        role: 'coordinator',
        allowedActions: [...CURRENT_COORDINATOR_ACTIONS],
        boardEpoch: 2,
        coordinatorEpoch: 2,
        runtimeGeneration: 1,
      },
    });
    should(() =>
      subject.membership.replaceCoordinator(
        state,
        sessions,
        {
          boardId: 'board',
          memberSessionId: 'root',
          administrator: OPERATOR,
          coordinatorSessionId: 'successor',
          replacementRootSessionId: 'external',
          requestId: 'succeed',
          at,
        },
        {
          grantId: 'unused-on-replay',
          capability: { value: 'lost-seed-secret', hash: hash('lost-seed-secret') },
        },
      ),
    ).throw(/recorded coordinator capability can no longer be recovered/u);
    should(() =>
      subject.membership.replaceCoordinator(
        state,
        sessions,
        {
          boardId: 'board',
          memberSessionId: 'root',
          administrator: OPERATOR,
          coordinatorSessionId: 'successor-child',
          replacementRootSessionId: 'external',
          requestId: 'succeed',
          at,
        },
        material,
      ),
    ).throw(/coordinator replacement request id was reused/u);
    should(() =>
      subject.membership.replaceCoordinator(
        state,
        sessions,
        {
          boardId: 'board',
          memberSessionId: 'root',
          administrator: OPERATOR,
          coordinatorSessionId: 'successor',
          replacementRootSessionId: 'root',
          requestId: 'succeed',
          at,
        },
        material,
      ),
    ).throw(/coordinator replacement request id was reused/u);
    should(() =>
      subject.membership.replaceCoordinator(
        state,
        sessions,
        {
          boardId: 'board',
          memberSessionId: 'external',
          administrator: OPERATOR,
          coordinatorSessionId: 'successor',
          replacementRootSessionId: 'external',
          requestId: 'succeed',
          at,
        },
        material,
      ),
    ).throw(/coordinator replacement request id was reused/u);
    for (const changedSessions of [
      sessions.map(candidate =>
        candidate.id === 'successor' ? { ...candidate, incarnation: 'successor-reincarnated' } : candidate,
      ),
      sessions.map(candidate => (candidate.id === 'successor' ? { ...candidate, runtimeGeneration: 2 } : candidate)),
    ]) {
      should(() =>
        subject.membership.replaceCoordinator(
          state,
          changedSessions,
          {
            boardId: 'board',
            memberSessionId: 'root',
            administrator: OPERATOR,
            coordinatorSessionId: 'successor',
            replacementRootSessionId: 'external',
            requestId: 'succeed',
            at,
          },
          material,
        ),
      ).throw(/coordinator replacement request id was reused/u);
    }
  });

  it('should require zero, one, or multiple live ancestry roots to resolve to exactly one', () => {
    // Arrange
    const subject = services();
    const verified = verifiedHandover(subject);
    const material = {
      grantId: 'ancestry-grant',
      capability: { value: 'ancestry-secret', hash: hash('ancestry-secret') },
    };
    const replace = (
      directory: readonly TaskBoardSession[],
      target: string,
      requestId: string,
      replacementRootSessionId = 'external',
    ) =>
      subject.membership.replaceCoordinator(
        verified,
        directory,
        {
          boardId: 'board',
          memberSessionId: 'root',
          administrator: OPERATOR,
          coordinatorSessionId: target,
          replacementRootSessionId,
          requestId,
          at,
        },
        material,
      );
    const withoutRoot = sessions.map(candidate =>
      candidate.id === 'successor' ? { ...candidate, parentSessionId: 'stranger' } : candidate,
    );
    const withNestedRoots = sessions.map(candidate =>
      candidate.id === 'external' ? { ...candidate, parentSessionId: 'root' } : candidate,
    );

    // Act
    const one = replace(sessions, 'successor', 'one-root');

    // Assert
    should(one.state.boards[0]?.grants.find(grant => grant.id === 'ancestry-grant')?.membershipRootSessionId).equal(
      'external',
    );
    should(() => replace(withoutRoot, 'successor', 'zero-roots')).throw(/exactly one expected live membership root/u);
    should(() => replace(withNestedRoots, 'successor', 'multiple-roots')).throw(
      /exactly one expected live membership root/u,
    );
    should(() => replace(sessions, 'successor', 'wrong-root', 'root')).throw(/expected live membership root/u);
  });

  it('should allow distinct operation ids to move the coordinator A to B to A to B', () => {
    // Arrange
    const subject = services();
    const replace = (
      state: TaskBoardRepositoryState,
      target: 'coordinator' | 'replacement',
      requestId: string,
      suffix: string,
    ) =>
      subject.membership.replaceCoordinator(
        state,
        sessions,
        {
          boardId: 'board',
          memberSessionId: 'root',
          administrator: OPERATOR,
          coordinatorSessionId: target,
          replacementRootSessionId: 'root',
          requestId,
          at,
        },
        {
          grantId: `${target}-grant-${suffix}`,
          capability: { value: `${target}-secret-${suffix}`, hash: hash(`${target}-secret-${suffix}`) },
        },
      );

    // Act — A is the creation-time coordinator.
    const movedToB = replace(createState(), 'replacement', 'move-1', '1');
    const movedBackToA = replace(movedToB.state, 'coordinator', 'move-2', '2');
    const movedAgainToB = replace(movedBackToA.state, 'replacement', 'move-3', '3');

    // Assert
    should(movedAgainToB.result.membership.sessionId).equal('replacement');
    should(movedAgainToB.state.boards[0]?.coordinatorSessionId).equal('replacement');
    should(
      movedAgainToB.state.boards[0]?.appliedOperations
        .filter(operation => operation.kind === 'coordinator.replace')
        .map(operation => operation.requestId),
    ).deepEqual(['move-1', 'move-2', 'move-3']);
  });

  it('should refuse relinquish when it would revoke the coordinator but a live tree survives', () => {
    // Arrange — the operator deliberately put the key back under the root that is about to retire.
    const subject = services();
    const misplaced = subject.membership.replaceCoordinator(
      verifiedHandover(subject),
      sessions,
      {
        boardId: 'board',
        memberSessionId: 'root',
        administrator: OPERATOR,
        coordinatorSessionId: 'replacement',
        replacementRootSessionId: 'root',
        requestId: 'misplaced-coordinator',
        at,
      },
      { grantId: 'misplaced-grant', capability: { value: 'misplaced-secret', hash: hash('misplaced-secret') } },
    );

    // Act + Assert — `external` is still a live surviving membership root, so the operator must move
    // the coordinator into that tree before the old root can leave.
    should(() =>
      subject.membership.relinquish(misplaced.state, sessions, {
        member: rootCredential,
        requestId: 'unsafe-relinquish',
        at,
      }),
    ).throw(/move the coordinator into a surviving membership tree first/u);
  });

  it('should preserve last-live-root wind-down when no live membership tree would survive', () => {
    // Arrange — the accepted replacement root stopped after verification. Its grant is recorded, but
    // it is not a live tree, so no continuing board is left coordinator-less by this wind-down.
    const subject = services();
    const misplaced = subject.membership.replaceCoordinator(
      verifiedHandover(subject),
      sessions,
      {
        boardId: 'board',
        memberSessionId: 'root',
        administrator: OPERATOR,
        coordinatorSessionId: 'replacement',
        replacementRootSessionId: 'root',
        requestId: 'wind-down-coordinator',
        at,
      },
      { grantId: 'wind-down-grant', capability: { value: 'wind-down-secret', hash: hash('wind-down-secret') } },
    );
    const noSurvivingTree = sessions.map(candidate =>
      candidate.id === 'external' ? { ...candidate, active: false } : candidate,
    );

    // Act
    const actual = subject.membership.relinquish(misplaced.state, noSurvivingTree, {
      member: rootCredential,
      requestId: 'last-root-wind-down',
      at,
    });

    // Assert
    should(actual.result).match({ relinquished: true, sessionId: 'root' });
    should(actual.state.boards[0]?.grants.find(grant => grant.id === 'wind-down-grant')?.active).be.false();
  });

  it('should fence pending grants and invitations when coordinator replacement changes epochs', () => {
    // Arrange
    const subject = services();
    const fenced = subject.children.request(verifiedHandover(subject), sessions, {
      source: rootCredential,
      targetSessionId: 'replacement',
      role: 'read',
      requestId: 'fenced-child',
      at,
    });

    // Act
    const actual = subject.membership.replaceCoordinator(
      fenced.state,
      sessions,
      {
        boardId: 'board',
        memberSessionId: 'root',
        administrator: OPERATOR,
        coordinatorSessionId: 'successor',
        replacementRootSessionId: 'external',
        requestId: 'fenced-replacement',
        at,
      },
      { grantId: 'fenced-coordinator', capability: { value: 'fenced-secret', hash: hash('fenced-secret') } },
    );
    const board = actual.state.boards[0];

    // Assert — nothing approved under the old key survives into the new epoch unapproved.
    should(board?.childGrantIntents.find(intent => intent.requestId === 'fenced-child')?.status).equal('refused');
    should(board?.boardEpoch).equal(2);
    should(board?.coordinatorEpoch).equal(2);
    // The accepted invitation is NOT refused: it is the receipt this succession rests on.
    should(board?.invitations.map(invitation => invitation.status)).deepEqual(['accepted']);
  });

  it('should fence only its own board’s invitations, leaving another board’s outstanding proof alone', () => {
    // Arrange — a second board with a live, approved invitation of its own. Invitation proofs are
    // held per REPOSITORY, not per board, so a succession here reaches a document it does not own.
    const subject = services();
    const withOther = new TaskBoardCreationService().create(
      verifiedHandover(subject),
      sessions,
      { creatorSessionId: 'other-root', coordinatorSessionId: 'other-coordinator', requestId: 'other-create', at },
      {
        boardId: 'other-board',
        creatorGrantId: 'other-root-grant',
        creatorCapability: { value: 'other-root-secret', hash: hash('other-root-secret') },
        coordinatorGrantId: 'other-coordinator-grant',
        coordinatorCapability: { value: 'other-coordinator-secret', hash: hash('other-coordinator-secret') },
      },
    ).state;
    const invited = subject.invitations.request(withOther, sessions, {
      source: { sessionId: 'other-root', runtimeGeneration: 1, capabilityHash: hash('other-root-secret') },
      targetSessionId: 'stranger',
      requestId: 'other-invite',
      at,
    });
    const approved = subject.invitations.approve(
      invited.state,
      sessions,
      {
        coordinator: {
          sessionId: 'other-coordinator',
          runtimeGeneration: 1,
          capabilityHash: hash('other-coordinator-secret'),
        },
        invitationRequestId: 'other-invite',
        requestId: 'other-approve',
        at,
      },
      { acceptanceCapability: { value: 'other-proof', hash: hash('other-proof') } },
    );
    should(approved.state.invitationProofs).have.length(1);

    // Act
    const actual = subject.membership.replaceCoordinator(
      approved.state,
      sessions,
      {
        boardId: 'board',
        memberSessionId: 'root',
        administrator: OPERATOR,
        coordinatorSessionId: 'successor',
        replacementRootSessionId: 'external',
        requestId: 'succeed-beside-another-board',
        at,
      },
      { grantId: 'successor-grant', capability: { value: 'successor-secret', hash: hash('successor-secret') } },
    );

    // Assert — the other board's invitee can still accept; nothing was fenced across the boundary.
    should(actual.state.invitationProofs.map(proof => proof.invitationRequestId)).deepEqual(['other-invite']);
    should(
      actual.state.boards.find(candidate => candidate.id === 'other-board')?.invitations.map(entry => entry.status),
    ).deepEqual(['approved']);
  });

  it('should leave the succeeded coordinator working, and the retired tree addressable, after the relinquish', () => {
    // Arrange
    const subject = services();

    // Act
    const state = relinquished(subject);
    const board = state.boards[0];

    // Assert — the new tree survives the old tree's exit.
    should(board?.grants.find(grant => grant.id === 'successor-grant')?.active).be.true();
    should(board?.grants.find(grant => grant.id === 'external-grant')?.active).be.true();
    should(subject.authorization.authorize(state, sessions, successorCredential, 'grant_approve').role).equal(
      'coordinator',
    );
    should(subject.authorization.authorize(state, sessions, externalCredential, 'invite_request').role).equal(
      'top_agent',
    );
    // Every binding of the retired tree is gone, and every one of its sessions is a retired target —
    // the old root, the coordinator revoked one phase earlier, and the child nobody named.
    should(['root', 'coordinator', 'child'].map(id => state.bindings.some(binding => binding.sessionId === id))).match([
      false,
      false,
      false,
    ]);
    should([...(board?.retiredSessionIds ?? [])].sort()).deepEqual(['child', 'coordinator', 'root']);
    // The board document is the same document it always was.
    should(board).match({ id: 'board', creatorSessionId: 'root', canonicalSessionId: 'root', createdAt: at });
    should(board?.audit.map(entry => entry.event)).deepEqual([
      'board.created',
      'grant.requested',
      'grant.approved',
      'invitation.requested',
      'invitation.approved',
      'invitation.accepted',
      'invitation.verified',
      'grant.requested',
      'grant.approved',
      'coordinator.replaced',
      'membership.relinquished',
    ]);
  });

  it('should address a retired session’s tasks from the new tree, and let nobody else touch them', () => {
    // Arrange
    const subject = services();
    const state = relinquished(subject);
    const otherBoard = new TaskBoardCreationService().create(
      state,
      sessions,
      { creatorSessionId: 'other-root', coordinatorSessionId: 'other-coordinator', requestId: 'other-create', at },
      {
        boardId: 'other-board',
        creatorGrantId: 'other-root-grant',
        creatorCapability: { value: 'other-root-secret', hash: hash('other-root-secret') },
        coordinatorGrantId: 'other-coordinator-grant',
        coordinatorCapability: { value: 'other-coordinator-secret', hash: hash('other-coordinator-secret') },
      },
    ).state;
    const otherRootCredential = {
      sessionId: 'other-root',
      runtimeGeneration: 1,
      capabilityHash: hash('other-root-secret'),
    };

    // Act — the new root reads the retired predecessor's scope on the SAME board.
    const actual = subject.authorization.resolveTaskScope(state, sessions, 'root', externalCredential, 'read');

    // Assert
    should(actual).match({ kind: 'board', sessionId: 'root', board: { id: 'board' } });
    should(subject.authorization.resolveTaskScope(state, sessions, 'child', externalCredential, 'read').board.id).equal(
      'board',
    );
    // A retired credential is a target and never an actor.
    should(() => subject.authorization.resolveTaskScope(state, sessions, 'root', rootCredential, 'read')).throw(
      TaskBoardError,
    );
    // Another board's member reaches neither the retired session nor the live one.
    should(() =>
      subject.authorization.resolveTaskScope(otherBoard, sessions, 'root', otherRootCredential, 'read'),
    ).throw(TaskBoardError);
    should(() =>
      subject.authorization.resolveTaskScope(otherBoard, sessions, 'external', otherRootCredential, 'read'),
    ).throw(TaskBoardError);
    // A session this daemon has never bound anywhere is still not found.
    should(() => subject.authorization.resolveTaskScope(state, sessions, 'ghost', externalCredential, 'read')).throw(
      TaskBoardError,
    );
  });

  it('should keep serving after the full invite, verify, replace, relinquish succession ladder', () => {
    // Arrange
    const subject = services();
    const state = relinquished(subject);

    // Act — the new root invites a stranger and the new coordinator approves it.
    const invited = subject.invitations.request(state, sessions, {
      source: externalCredential,
      targetSessionId: 'stranger',
      requestId: 'post-succession-invite',
      at,
    });
    const approved = subject.invitations.approve(
      invited.state,
      sessions,
      {
        coordinator: successorCredential,
        invitationRequestId: 'post-succession-invite',
        requestId: 'post-succession-approve',
        at,
      },
      { acceptanceCapability: { value: 'stranger-proof', hash: hash('stranger-proof') } },
    );
    if (!approved.result.approved) throw new Error('the post-succession invitation did not approve');
    const childRequested = subject.children.request(approved.state, sessions, {
      source: externalCredential,
      targetSessionId: 'successor-child',
      role: 'worker',
      requestId: 'post-succession-child',
      at,
    });
    const childApproved = subject.children.approve(
      childRequested.state,
      sessions,
      {
        coordinator: successorCredential,
        grantRequestId: 'post-succession-child',
        requestId: 'post-succession-child-approve',
        at,
      },
      () => ({
        grantId: 'successor-child-grant',
        capability: { value: 'successor-child', hash: hash('successor-child') },
      }),
    );

    // Assert
    should(approved.result.invitation.status).equal('approved');
    should(childApproved.result).match({ approved: true, membership: { sessionId: 'successor-child' } });
  });
});

describe('task-board coverage invariants', () => {
  it('should cover the denied role, exact parent binding, and task-board error classifier', () => {
    // Arrange
    const state = createState();
    const board = state.boards[0];
    const coordinator = board?.grants.find(grant => grant.id === 'coordinator-grant');
    if (board === undefined || coordinator === undefined) throw new Error('fixture board is incomplete');
    const moved = sessions.map(candidate =>
      candidate.id === 'coordinator' ? { ...candidate, parentSessionId: 'child' } : candidate,
    );

    // Act
    const actual = {
      noneActions: actionsForTaskBoardRole('none'),
      explicitRoot: isExplicitBoardMember(board, 'root'),
      movedCoordinator: isGrantWithinActiveMembershipTree(board, coordinator, moved),
      classified: isTaskBoardError(new TaskBoardError('forbidden', 'denied')),
      unrelated: isTaskBoardError(new Error('not a board error')),
      matchingPrerelease: compareProtocolVersions('1.0.0-alpha.1', '1.0.0-alpha.1'),
      mismatchedAuthorization: hasExplicitInvitationAuthority(
        board,
        {
          boardId: board.id,
          grantId: 'missing',
          sessionId: 'root',
          role: 'top_agent',
          allowedActions: actionsForTaskBoardRole('top_agent'),
          boardEpoch: board.boardEpoch,
          coordinatorEpoch: board.coordinatorEpoch,
          runtimeGeneration: 1,
        },
        'request',
      ),
    };

    // Assert
    should(actual).deepEqual({
      noneActions: [],
      explicitRoot: true,
      movedCoordinator: false,
      classified: true,
      unrelated: false,
      matchingPrerelease: 0,
      mismatchedAuthorization: false,
    });
  });

  it('should reject duplicate board allocation and divergent creation replay payloads', () => {
    // Arrange
    const subject = new TaskBoardCreationService();
    const state = createState();
    const material = {
      boardId: 'board-2',
      creatorGrantId: 'root-grant-2',
      creatorCapability: { value: 'root-secret-2', hash: hash('root-secret-2') },
      coordinatorGrantId: 'coordinator-grant-2',
      coordinatorCapability: { value: 'coordinator-secret-2', hash: hash('coordinator-secret-2') },
    };

    // Act + Assert
    should(() =>
      subject.create(
        state,
        sessions,
        { creatorSessionId: 'root', coordinatorSessionId: 'coordinator', requestId: 'new-create', at },
        material,
      ),
    ).throw(TaskBoardError);
    should(() =>
      subject.create(
        state,
        sessions,
        {
          creatorSessionId: 'root',
          coordinatorSessionId: 'coordinator',
          creatorMarkDone: true,
          requestId: 'create',
          at,
        },
        material,
      ),
    ).throw(TaskBoardError);
    should(() =>
      subject.create(
        { ...state, boards: [] },
        sessions,
        { creatorSessionId: 'root', coordinatorSessionId: 'coordinator', requestId: 'create', at },
        material,
      ),
    ).throw(TaskBoardError);
  });
});
