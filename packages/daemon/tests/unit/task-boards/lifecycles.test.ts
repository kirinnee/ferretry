import { describe, it } from 'bun:test';
import should from 'should';
import { compareProtocolVersions } from '@ferretry/protocol';
import { TaskBoardAuthorizationService } from '../../../src/lib/task-boards/authorization-service.ts';
import { TaskBoardChildGrantService } from '../../../src/lib/task-boards/child-grant-service.ts';
import { TaskBoardCreationService } from '../../../src/lib/task-boards/creation-service.ts';
import { isTaskBoardError, TaskBoardError } from '../../../src/lib/task-boards/error.ts';
import { TaskBoardInvitationService } from '../../../src/lib/task-boards/invitation-service.ts';
import { TaskBoardMembershipService } from '../../../src/lib/task-boards/membership-service.ts';
import {
  actionsForTaskBoardRole,
  isExplicitBoardMember,
  isGrantWithinActiveMembershipTree,
  hasExplicitInvitationAuthority,
} from '../../../src/lib/task-boards/policy.ts';
import {
  EMPTY_TASK_BOARD_REPOSITORY_STATE,
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

function services(): {
  authorization: TaskBoardAuthorizationService;
  children: TaskBoardChildGrantService;
  invitations: TaskBoardInvitationService;
  membership: TaskBoardMembershipService;
} {
  const authorization = new TaskBoardAuthorizationService(hash);
  return {
    authorization,
    children: new TaskBoardChildGrantService(authorization),
    invitations: new TaskBoardInvitationService(authorization, hash),
    membership: new TaskBoardMembershipService(
      authorization,
      (boardId, actor) => boardId === 'board' && actor === 'human-admin',
    ),
  };
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
      { grantId: 'child-grant', capability: { value: 'child-secret', hash: hash('child-secret') } },
    );

    // Assert
    should(actual.result).deepEqual({
      approved: true,
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
        { grantId: 'changed-grant', capability: { value: 'changed-secret', hash: hash('changed-secret') } },
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
      material,
    );

    // Act
    const replay = subject.children.approve(
      approved.state,
      sessions,
      { coordinator: coordinatorCredential, grantRequestId: 'replay-request', requestId: 'replay-approve', at },
      material,
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
      { grantId: 'expired-grant', capability: { value: 'expired-secret', hash: hash('expired-secret') } },
    );

    // Assert
    should(replay.state).equal(approved.state);
    should(replay.result).deepEqual(approved.result);
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
      { grantId: 'external-grant', capability: { value: 'external-secret', hash: hash('external-secret') } },
    );

    // Assert
    should(actual.result).deepEqual({
      accepted: true,
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
        { grantId: 'unused', capability: { value: 'unused', hash: hash('unused') } },
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
      { grantId: 'unused-expired-grant', capability: { value: 'unused-expired', hash: hash('unused-expired') } },
    );

    // Assert
    should(actual.result.accepted).be.false();
    should(actual.state.boards[0]?.invitations[0]?.status).equal('expired');
  });
});

describe('TaskBoardMembershipService', () => {
  it('should revoke a relinquishing root and its children only after an accepted external root exists', () => {
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
      { grantId: 'external-grant', capability: { value: 'external-secret', hash: hash('external-secret') } },
    );

    // Act
    const actual = subject.membership.relinquish(accepted.state, sessions, {
      member: rootCredential,
      requestId: 'relinquish',
      at,
    });

    // Assert
    should(actual.result).deepEqual({ relinquished: true, sessionId: 'root', sessionStopped: false });
    should(actual.state.boards[0]?.grants.find(grant => grant.id === 'root-grant')?.active).be.false();
    should(actual.state.bindings.some(binding => binding.sessionId === 'root')).be.false();
    should(() => subject.authorization.authorize(actual.state, sessions, rootCredential, 'read')).throw(TaskBoardError);
  });

  it('should require explicit administrator authority to replace a coordinator and fence the old key', () => {
    // Arrange
    const subject = services();

    // Act
    const actual = subject.membership.replaceCoordinator(
      createState(),
      sessions,
      {
        boardId: 'board',
        administratorSessionId: 'human-admin',
        replacementSessionId: 'replacement',
        requestId: 'replace',
        at,
      },
      { grantId: 'replacement-grant', capability: { value: 'replacement-secret', hash: hash('replacement-secret') } },
    );

    // Assert
    should(actual.result.membership.sessionId).equal('replacement');
    should(actual.state.boards[0]?.coordinatorSessionId).equal('replacement');
    should(() => subject.authorization.authorize(actual.state, sessions, coordinatorCredential, 'grant_approve')).throw(
      TaskBoardError,
    );
    should(
      subject.authorization.authorize(
        actual.state,
        sessions,
        { sessionId: 'replacement', runtimeGeneration: 1, capabilityHash: hash('replacement-secret') },
        'grant_approve',
      ).role,
    ).equal('coordinator');
    should(() =>
      subject.membership.replaceCoordinator(
        createState(),
        sessions,
        {
          boardId: 'board',
          administratorSessionId: 'warden',
          replacementSessionId: 'replacement',
          requestId: 'denied-replace',
          at,
        },
        { grantId: 'denied', capability: { value: 'denied', hash: hash('denied') } },
      ),
    ).throw(TaskBoardError);
  });

  it('should fence pending grants and invitations when coordinator replacement changes epochs', () => {
    // Arrange
    const subject = services();
    const childRequested = subject.children.request(createState(), sessions, {
      source: rootCredential,
      targetSessionId: 'child',
      role: 'read',
      requestId: 'fenced-child',
      at,
    });
    const invited = subject.invitations.request(childRequested.state, sessions, {
      source: rootCredential,
      targetSessionId: 'external',
      requestId: 'fenced-invitation',
      at,
    });
    const approved = subject.invitations.approve(
      invited.state,
      sessions,
      { coordinator: coordinatorCredential, invitationRequestId: 'fenced-invitation', requestId: 'fenced-approve', at },
      { acceptanceCapability: { value: 'fenced-proof', hash: hash('fenced-proof') } },
    );

    // Act
    const actual = subject.membership.replaceCoordinator(
      approved.state,
      sessions,
      {
        boardId: 'board',
        administratorSessionId: 'human-admin',
        replacementSessionId: 'replacement',
        requestId: 'fenced-replacement',
        at,
      },
      { grantId: 'fenced-coordinator', capability: { value: 'fenced-secret', hash: hash('fenced-secret') } },
    );

    // Assert
    should(actual.state.boards[0]?.childGrantIntents[0]?.status).equal('refused');
    should(actual.state.boards[0]?.invitations[0]?.status).equal('refused');
    should(actual.state.invitationProofs).have.length(0);
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
