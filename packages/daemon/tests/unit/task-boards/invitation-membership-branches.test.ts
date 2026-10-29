import { describe, it } from 'bun:test';
import should from 'should';
import { TaskBoardAuthorizationService } from '../../../src/lib/task-boards/authorization-service.ts';
import { TaskBoardChildGrantService } from '../../../src/lib/task-boards/child-grant-service.ts';
import { TaskBoardCreationService } from '../../../src/lib/task-boards/creation-service.ts';
import { isTaskBoardError } from '../../../src/lib/task-boards/error.ts';
import { invitationView, TaskBoardInvitationService } from '../../../src/lib/task-boards/invitation-service.ts';
import { TaskBoardMembershipService } from '../../../src/lib/task-boards/membership-service.ts';
import {
  EMPTY_TASK_BOARD_REPOSITORY_STATE,
  type TaskBoardAuthorization,
  type TaskBoardCredential,
  type TaskBoardInvitation,
  type TaskBoardMemberAuthorization,
  type TaskBoardRepositoryState,
  type TaskBoardSession,
} from '../../../src/lib/task-boards/types.ts';

const at = '2026-07-30T12:00:00.000Z';
const afterExpiry = '2026-07-31T12:00:00.000Z';
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
  session({ id: 'replacement', parentSessionId: 'root', mode: 'auto' }),
  session({ id: 'external' }),
  session({ id: 'stranger' }),
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

const authorization = new TaskBoardAuthorizationService(hash);
const invitations = new TaskBoardInvitationService(authorization, hash);
const membership = new TaskBoardMembershipService(authorization);
const children = new TaskBoardChildGrantService(authorization);
const OPERATOR: TaskBoardAuthorization = authorization.administrator(createState(), 'board', 'human_admin');

function requested(
  state: TaskBoardRepositoryState = createState(),
  requestId = 'invite',
  targetSessionId = 'external',
  inputSessions: readonly TaskBoardSession[] = sessions,
): TaskBoardRepositoryState {
  return invitations.request(state, inputSessions, { source: rootCredential, targetSessionId, requestId, at }).state;
}

function approve(state: TaskBoardRepositoryState, invitationRequestId = 'invite', requestId = 'approve', now = at) {
  return invitations.approve(
    state,
    sessions,
    { coordinator: coordinatorCredential, invitationRequestId, requestId, at: now },
    { acceptanceCapability: { value: 'invite-secret', hash: hash('invite-secret') } },
  );
}

function approved(): TaskBoardRepositoryState {
  return approve(requested()).state;
}

const acceptCommand = {
  target: { sessionId: 'external', runtimeGeneration: 1, capabilityHash: hash('session:external') },
  invitationCapability: 'invite-secret',
  requestId: 'accept',
  at,
};

function accepted(): TaskBoardRepositoryState {
  return invitations.accept(approved(), sessions, acceptCommand, () => ({
    grantId: 'external-grant',
    capability: { value: 'external-secret', hash: hash('external-secret') },
  })).state;
}

function unusedMaterial(): never {
  throw new Error('a refused acceptance must not mint membership material');
}

function thrown(work: () => unknown): { readonly kind: string; readonly message: string } {
  try {
    work();
  } catch (error) {
    if (isTaskBoardError(error)) return { kind: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected the call to be refused');
}

describe('invitationView', () => {
  const base = {
    requestId: 'invite',
    fingerprint: 'print',
    boardEpoch: 1,
    sourceGrantId: 'root-grant',
    sourceSessionId: 'root',
    sourceSessionIncarnation: 'root-incarnation',
    sourceRuntimeGeneration: 1,
    targetSessionId: 'external',
    targetSessionIncarnation: 'external-incarnation',
    targetRuntimeGeneration: 1,
    coordinatorGrantId: 'coordinator-grant',
    coordinatorSessionId: 'coordinator',
    coordinatorSessionIncarnation: 'coordinator-incarnation',
    coordinatorRuntimeGeneration: 1,
    coordinatorLineage: ['coordinator', 'root'],
    coordinatorEpoch: 1,
    createdAt: at,
    expiresAt: afterExpiry,
  } as const;

  it('should report the recorded reason of a refused invitation', () => {
    const invitation: TaskBoardInvitation = { ...base, status: 'refused', refusalReason: 'coordinator replaced' };

    should(invitationView(invitation).status).equal('refused');
    should(invitationView(invitation)).have.property('refusalReason', 'coordinator replaced');
  });

  it('should fall back to a generic reason when a refused invitation recorded none', () => {
    const invitation: TaskBoardInvitation = { ...base, status: 'refused' };

    should(invitationView(invitation)).have.property('refusalReason', 'refused');
  });
});

describe('TaskBoardInvitationService request refusals', () => {
  it('should refuse an invitation while the coordinator session is no longer live', () => {
    const stopped = sessions.map(candidate =>
      candidate.id === 'coordinator' ? session({ ...candidate, active: false }) : candidate,
    );

    const actual = thrown(() => requested(createState(), 'invite', 'external', stopped));

    should(actual).deepEqual({
      kind: 'unavailable',
      message: 'the board has no exact live current coordinator',
    });
  });

  it('should refuse a second invitation while one is outstanding', () => {
    const actual = thrown(() => requested(requested(), 'second', 'stranger'));

    should(actual).deepEqual({
      kind: 'conflict',
      message: 'the board already has an outstanding external invitation',
    });
  });

  it('should replay a settled invitation request and refuse reusing its id for another target', () => {
    const expired = approve(requested(), 'invite', 'late-approve', afterExpiry).state;
    should(expired.boards[0]?.invitations[0]?.status).equal('expired');

    const replay = invitations.request(expired, sessions, {
      source: rootCredential,
      targetSessionId: 'external',
      requestId: 'invite',
      at,
    });
    const reused = thrown(() => requested(expired, 'invite', 'stranger'));

    should(replay.state).equal(expired);
    should(replay.result.status).equal('expired');
    should(replay.result.requestId).equal('invite');
    should(reused.kind).equal('conflict');
    should(reused.message).equal('the invitation request id was reused with another payload');
  });
});

describe('TaskBoardInvitationService approve', () => {
  it('should replay an exact approval with the same acceptance capability and change nothing', () => {
    const first = approve(requested());

    const replay = approve(first.state);

    should(replay.state).equal(first.state);
    should(replay.result).deepEqual(first.result);
    should(replay.result).have.property('acceptanceCapability', 'invite-secret');
  });

  it('should refuse reusing an approval request id already spent on another operation', () => {
    const childRequested = children.request(createState(), sessions, {
      source: rootCredential,
      targetSessionId: 'replacement',
      role: 'read',
      requestId: 'child',
      at,
    });
    const childApproved = children.approve(
      childRequested.state,
      sessions,
      { coordinator: coordinatorCredential, grantRequestId: 'child', requestId: 'child-approve', at },
      () => ({ grantId: 'child-grant', capability: { value: 'child-secret', hash: hash('child-secret') } }),
    );
    const state = requested(childApproved.state);

    const actual = thrown(() => approve(state, 'invite', 'child-approve'));

    should(actual).deepEqual({ kind: 'conflict', message: 'the invitation approval request id was reused' });
  });

  it('should refuse replaying an approval whose invitation is no longer approved', () => {
    const state = accepted();

    const actual = thrown(() => approve(state));

    should(actual).deepEqual({ kind: 'conflict', message: 'the invitation approval request id was reused' });
  });

  it('should report an approved invitation whose acceptance proof is gone as unavailable', () => {
    const state = { ...approve(requested()).state, invitationProofs: [] };

    const actual = thrown(() => approve(state));

    should(actual).deepEqual({ kind: 'unavailable', message: 'the approved invitation has no acceptance proof' });
  });

  it('should refuse to approve once the invitee is no longer a live session', () => {
    const state = requested();
    const stopped = sessions.map(candidate =>
      candidate.id === 'external' ? session({ ...candidate, active: false }) : candidate,
    );

    const actual = thrown(() =>
      invitations.approve(
        state,
        stopped,
        { coordinator: coordinatorCredential, invitationRequestId: 'invite', requestId: 'approve', at },
        { acceptanceCapability: { value: 'invite-secret', hash: hash('invite-secret') } },
      ),
    );

    should(actual).deepEqual({
      kind: 'forbidden',
      message: 'the invitation authority or target identity changed before approval',
    });
  });
});

describe('TaskBoardInvitationService authority and acceptance preconditions', () => {
  it('should refuse approval by a member that is not the exact current coordinator', () => {
    const state = requested();
    const readOnly = {
      authorize: (
        inputState: TaskBoardRepositoryState,
        inputSessions: readonly TaskBoardSession[],
        credential: TaskBoardCredential,
      ) => authorization.authorize(inputState, inputSessions, credential, 'read'),
    } as unknown as TaskBoardAuthorizationService;

    const actual = thrown(() =>
      new TaskBoardInvitationService(readOnly, hash).approve(
        state,
        sessions,
        { coordinator: rootCredential, invitationRequestId: 'invite', requestId: 'approve', at },
        { acceptanceCapability: { value: 'invite-secret', hash: hash('invite-secret') } },
      ),
    );

    should(actual).deepEqual({
      kind: 'forbidden',
      message: 'only the exact current coordinator may approve an external invitation',
    });
  });

  it('should refuse acceptance before any invitation has been approved', () => {
    const actual = thrown(() => invitations.accept(requested(), sessions, acceptCommand, () => unusedMaterial()));

    should(actual).deepEqual({ kind: 'forbidden', message: 'the session has no approved external invitation' });
  });

  it('should report a replayed acceptance whose durable binding is gone as unavailable', () => {
    const state = accepted();

    const actual = thrown(() =>
      invitations.accept({ ...state, bindings: [] }, sessions, acceptCommand, () => unusedMaterial()),
    );

    should(actual).deepEqual({
      kind: 'unavailable',
      message: 'the accepted invitation has no durable membership binding',
    });
  });
});

describe('TaskBoardInvitationService accept', () => {
  it('should refuse membership material that collides with an existing grant', () => {
    const actual = thrown(() =>
      invitations.accept(approved(), sessions, acceptCommand, () => ({
        grantId: 'root-grant',
        capability: { value: 'external-secret', hash: hash('external-secret') },
      })),
    );

    should(actual).deepEqual({
      kind: 'conflict',
      message: 'the invitation membership material is already in use',
    });
  });

  it('should refuse membership material that reuses an existing capability hash', () => {
    const actual = thrown(() =>
      invitations.accept(approved(), sessions, acceptCommand, () => ({
        grantId: 'external-grant',
        capability: { value: 'root-secret', hash: hash('root-secret') },
      })),
    );

    should(actual.kind).equal('conflict');
  });
});

describe('TaskBoardInvitationService verify', () => {
  const verifyCommand = { member: externalCredential, requestId: 'verify', at };

  it('should record the receipt once and replay it without changing state', () => {
    const state = accepted();

    const first = invitations.verify(state, sessions, verifyCommand);
    const replay = invitations.verify(first.state, sessions, verifyCommand);

    should(first.state.boards[0]?.invitations[0]?.verifiedAt).equal(at);
    should(first.state.boards[0]?.invitations[0]?.verifiedBySessionId).equal('external');
    should(replay.state).equal(first.state);
    should(replay.result).deepEqual(first.result);
  });

  it('should treat a fresh request id after verification as already verified', () => {
    const first = invitations.verify(accepted(), sessions, verifyCommand);

    const again = invitations.verify(first.state, sessions, { ...verifyCommand, requestId: 'verify-again' });

    should(again.state).equal(first.state);
    should(again.result.verified).be.true();
    should(again.result.membership.sessionId).equal('external');
  });

  it('should refuse reusing another operation’s request id as a verification', () => {
    const actual = thrown(() => invitations.verify(accepted(), sessions, { ...verifyCommand, requestId: 'accept' }));

    should(actual).deepEqual({
      kind: 'conflict',
      message: 'the invitation verification request id was reused',
    });
  });

  it('should refuse verification from a member that was not an accepted invitee', () => {
    const actual = thrown(() =>
      invitations.verify(accepted(), sessions, { member: rootCredential, requestId: 'verify', at }),
    );

    should(actual).deepEqual({
      kind: 'forbidden',
      message: 'only an accepted external invitation may verify replacement authority',
    });
  });

  it('should report an accepted invitation whose membership grant has vanished as unavailable', () => {
    const state = accepted();
    const board = state.boards[0];
    if (board === undefined) throw new Error('fixture board missing');
    const dropped: TaskBoardRepositoryState = {
      ...state,
      boards: [{ ...board, grants: board.grants.filter(grant => grant.id !== 'external-grant') }],
    };
    const memberAuthorization: TaskBoardMemberAuthorization = {
      boardId: 'board',
      grantId: 'external-grant',
      sessionId: 'external',
      role: 'top_agent',
      allowedActions: ['read'],
      boardEpoch: board.boardEpoch,
      coordinatorEpoch: board.coordinatorEpoch,
      runtimeGeneration: 1,
    };
    const stubbed = new TaskBoardInvitationService(
      { authorize: () => memberAuthorization } as unknown as TaskBoardAuthorizationService,
      hash,
    );

    const actual = thrown(() => stubbed.verify(dropped, sessions, verifyCommand));

    should(actual).deepEqual({
      kind: 'unavailable',
      message: 'the accepted invitation has no exact membership grant',
    });
  });
});

describe('TaskBoardMembershipService coordinator replacement', () => {
  const replace = (
    state: TaskBoardRepositoryState,
    inputSessions: readonly TaskBoardSession[] = sessions,
    material = { grantId: 'next-grant', capability: { value: 'next-secret', hash: hash('next-secret') } },
    requestId = 'replace',
  ) =>
    membership.replaceCoordinator(
      state,
      inputSessions,
      {
        boardId: 'board',
        memberSessionId: 'root',
        administrator: OPERATOR,
        coordinatorSessionId: 'replacement',
        replacementRootSessionId: 'root',
        requestId,
        at,
      },
      material,
    );

  it('should refuse a replayed replacement whose capability can no longer be recovered', () => {
    const first = replace(createState());

    const actual = thrown(() =>
      replace(first.state, sessions, {
        grantId: 'next-grant',
        capability: { value: 'different', hash: hash('different') },
      }),
    );

    should(actual).deepEqual({
      kind: 'unavailable',
      message: 'the recorded coordinator capability can no longer be recovered',
    });
  });

  it('should refuse a replayed replacement whose coordinator grant is no longer active', () => {
    const first = replace(createState());
    const board = first.state.boards[0];
    if (board === undefined) throw new Error('fixture board missing');
    const revoked = {
      ...first.state,
      boards: [
        {
          ...board,
          grants: board.grants.map(grant => (grant.id === 'next-grant' ? { ...grant, active: false } : grant)),
        },
      ],
    };

    const actual = thrown(() => replace(revoked));

    should(actual).deepEqual({
      kind: 'unavailable',
      message: 'the coordinator replacement has no active grant',
    });
  });

  it('should refuse a replacement whose session ancestry is a cycle', () => {
    const cyclic = [
      ...sessions.filter(candidate => candidate.id !== 'replacement' && candidate.id !== 'stranger'),
      session({ id: 'replacement', parentSessionId: 'stranger', mode: 'auto' }),
      session({ id: 'stranger', parentSessionId: 'replacement', mode: 'auto' }),
    ];

    const actual = thrown(() => replace(createState(), cyclic));

    should(actual.kind).equal('forbidden');
    should(actual.message).startWith('the replacement coordinator must belong to exactly one expected live');
  });

  it('should refuse when the board has no current coordinator left to replace', () => {
    const state = createState();
    const board = state.boards[0];
    if (board === undefined) throw new Error('fixture board missing');
    const orphaned = { ...state, boards: [{ ...board, coordinatorGrantId: 'missing-grant' }] };

    const actual = thrown(() => replace(orphaned));

    should(actual).deepEqual({
      kind: 'unavailable',
      message: 'the board has no current coordinator to replace',
    });
  });

  it('should refuse replacement material that collides with an existing grant', () => {
    const actual = thrown(() =>
      replace(createState(), sessions, {
        grantId: 'root-grant',
        capability: { value: 'next-secret', hash: hash('next-secret') },
      }),
    );

    should(actual).deepEqual({
      kind: 'conflict',
      message: 'the replacement coordinator material is already in use',
    });
  });

  it('should refuse outstanding invitations and drop their proofs when the coordinator is replaced', () => {
    const state = approve(requested()).state;
    should(state.invitationProofs).have.length(1);

    const actual = replace(state);

    const statuses = actual.state.boards[0]?.invitations.map(invitation => invitation.status);
    const [invitation] = actual.state.boards[0]?.invitations ?? [];
    should(statuses).deepEqual(['refused']);
    should(invitation && invitationView(invitation)).have.property(
      'refusalReason',
      'coordinator replaced before approval',
    );
    should(actual.state.invitationProofs).have.length(0);
  });
});
