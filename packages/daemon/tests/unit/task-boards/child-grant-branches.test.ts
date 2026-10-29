import { describe, it } from 'bun:test';
import type { TaskBoardAction, TaskBoardGrantRequestView } from '@ferretry/protocol';
import should from 'should';
import { TaskBoardAuthorizationService } from '../../../src/lib/task-boards/authorization-service.ts';
import { childGrantView, TaskBoardChildGrantService } from '../../../src/lib/task-boards/child-grant-service.ts';
import { TaskBoardCreationService } from '../../../src/lib/task-boards/creation-service.ts';
import { TaskBoardError } from '../../../src/lib/task-boards/error.ts';
import {
  EMPTY_TASK_BOARD_REPOSITORY_STATE,
  type TaskBoardChildGrantIntent,
  type TaskBoardRepositoryState,
  type TaskBoardSession,
} from '../../../src/lib/task-boards/types.ts';

const at = '2026-07-30T12:00:00.000Z';
const hash = (value: string): string => `hash:${value}`;

function session(input: Partial<TaskBoardSession> & Pick<TaskBoardSession, 'id'>): TaskBoardSession {
  return {
    id: input.id,
    incarnation: `${input.id}-incarnation`,
    runtimeGeneration: 1,
    parentSessionId: input.parentSessionId ?? null,
    mode: input.mode ?? 'interactive',
    active: input.active ?? true,
    name: null,
    teammate: null,
    sessionCapabilityHash: hash(`session:${input.id}`),
  };
}

const sessions = [
  session({ id: 'root' }),
  session({ id: 'coordinator', parentSessionId: 'root', mode: 'auto' }),
  session({ id: 'child', parentSessionId: 'root', mode: 'auto' }),
  session({ id: 'sibling', parentSessionId: 'root', mode: 'auto' }),
  session({ id: 'outsider' }),
];

function createState(): TaskBoardRepositoryState {
  return new TaskBoardCreationService().create(
    EMPTY_TASK_BOARD_REPOSITORY_STATE,
    sessions,
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
const childCredential = { sessionId: 'child', runtimeGeneration: 1, capabilityHash: hash('child-secret') };

const material = (id: string): (() => { grantId: string; capability: { value: string; hash: string } }) => {
  return () => ({ grantId: `${id}-grant`, capability: { value: `${id}-secret`, hash: hash(`${id}-secret`) } });
};

function refusal(work: () => unknown): TaskBoardError {
  try {
    work();
  } catch (error) {
    if (error instanceof TaskBoardError) return error;
    throw error;
  }
  throw new Error('expected a TaskBoardError');
}

function requested(
  children: TaskBoardChildGrantService,
  state: TaskBoardRepositoryState,
  input: { targetSessionId?: string; role?: 'read' | 'worker' | 'coordinator'; requestId?: string } = {},
): TaskBoardRepositoryState {
  return children.request(state, sessions, {
    source: rootCredential,
    targetSessionId: input.targetSessionId ?? 'child',
    role: input.role ?? 'worker',
    requestId: input.requestId ?? 'req',
    at,
  }).state;
}

describe('childGrantView', () => {
  it('should fall back to a generic reason when a refused intent recorded none', () => {
    // Arrange
    const children = new TaskBoardChildGrantService(new TaskBoardAuthorizationService(hash));
    const state = requested(children, createState());
    const intent: TaskBoardChildGrantIntent = {
      ...(state.boards[0]?.childGrantIntents[0] as TaskBoardChildGrantIntent),
      status: 'refused',
    };

    // Act
    const actual: TaskBoardGrantRequestView = childGrantView(intent);

    // Assert
    should(actual.status).equal('refused');
    should(actual).have.property('refusalReason', 'refused');
  });
});

describe('TaskBoardChildGrantService refusals', () => {
  const authorization = new TaskBoardAuthorizationService(hash);
  const children = new TaskBoardChildGrantService(authorization);

  it('should refuse a request when the board has no live current coordinator', () => {
    // Arrange
    const dead = sessions.map(candidate =>
      candidate.id === 'coordinator' ? { ...candidate, active: false } : candidate,
    );

    // Act
    const actual = refusal(() =>
      children.request(createState(), dead, {
        source: rootCredential,
        targetSessionId: 'child',
        role: 'worker',
        requestId: 'req',
        at,
      }),
    );

    // Assert
    should(actual.code).equal('unavailable');
    should(actual.message).containEql('no exact live current coordinator');
  });

  it('should refuse a request from a source that is not an interactive membership root', () => {
    // Arrange
    const automated = sessions.map(candidate =>
      candidate.id === 'root' ? { ...candidate, mode: 'auto' as const } : candidate,
    );

    // Act
    const actual = refusal(() =>
      children.request(createState(), automated, {
        source: rootCredential,
        targetSessionId: 'child',
        role: 'worker',
        requestId: 'req',
        at,
      }),
    );

    // Assert
    should(actual.code).equal('forbidden');
    should(actual.message).containEql('interactive membership root');
  });

  it('should refuse a target that is not a descendant of the membership root', () => {
    // Act
    const actual = refusal(() => requested(children, createState(), { targetSessionId: 'outsider' }));

    // Assert
    should(actual.code).equal('forbidden');
    should(actual.message).containEql('not a live descendant');
  });

  it('should refuse a target that already holds task-board membership', () => {
    // Arrange
    const first = requested(children, createState());
    const bound = children.approve(
      first,
      sessions,
      { coordinator: coordinatorCredential, grantRequestId: 'req', requestId: 'approve', at },
      material('child'),
    ).state;

    // Act
    const actual = refusal(() => requested(children, bound, { requestId: 'again' }));

    // Assert
    should(actual.code).equal('conflict');
    should(actual.message).containEql('already has task-board membership');
  });

  it('should refuse a replayed request id carrying another payload', () => {
    // Arrange
    const first = requested(children, createState(), { role: 'worker' });

    // Act
    const actual = refusal(() => requested(children, first, { role: 'read' }));

    // Assert
    should(actual.code).equal('conflict');
    should(actual.message).containEql('reused with another payload');
  });

  it('should refuse an approval by a member that is not the exact current coordinator', () => {
    // Arrange
    const withChild = children.approve(
      requested(children, createState(), { requestId: 'child-req', role: 'coordinator' }),
      sessions,
      { coordinator: coordinatorCredential, grantRequestId: 'child-req', requestId: 'child-approve', at },
      material('child'),
    ).state;
    const pending = requested(children, withChild, { targetSessionId: 'sibling', requestId: 'sibling-req' });
    // A second holder of the approval action cannot be minted through the services, so it is forged here:
    // the grant and its binding must agree or the capability is refused before the coordinator check.
    const withApproval = (actions: readonly TaskBoardAction[]): readonly TaskBoardAction[] => [
      ...actions,
      'grant_approve',
    ];
    const stale: TaskBoardRepositoryState = {
      ...pending,
      boards: pending.boards.map(board => ({
        ...board,
        grants: board.grants.map(grant =>
          grant.sessionId === 'child' ? { ...grant, allowedActions: withApproval(grant.allowedActions) } : grant,
        ),
      })),
      bindings: pending.bindings.map(binding =>
        binding.sessionId === 'child' ? { ...binding, allowedActions: withApproval(binding.allowedActions) } : binding,
      ),
    };

    // Act
    const actual = refusal(() =>
      children.approve(
        stale,
        sessions,
        { coordinator: childCredential, grantRequestId: 'sibling-req', requestId: 'sibling-approve', at },
        material('sibling'),
      ),
    );

    // Assert
    should(actual.code).equal('forbidden');
    should(actual.message).containEql('only the exact current coordinator');
  });

  it('should refuse an approval whose minted material collides with an existing grant', () => {
    // Arrange
    const pending = requested(children, createState());

    // Act
    const actual = refusal(() =>
      children.approve(
        pending,
        sessions,
        { coordinator: coordinatorCredential, grantRequestId: 'req', requestId: 'approve', at },
        () => ({ grantId: 'root-grant', capability: { value: 'fresh', hash: hash('fresh') } }),
      ),
    );

    // Assert
    should(actual.code).equal('conflict');
    should(actual.message).containEql('already in use');
  });

  it('should refuse to replay an approval request id that was spent on another grant request', () => {
    // Arrange
    const both = requested(children, requested(children, createState(), { requestId: 'first' }), {
      targetSessionId: 'sibling',
      requestId: 'second',
    });
    const approved = children.approve(
      both,
      sessions,
      { coordinator: coordinatorCredential, grantRequestId: 'first', requestId: 'shared-approve', at },
      material('child'),
    ).state;

    // Act
    const actual = refusal(() =>
      children.approve(
        approved,
        sessions,
        { coordinator: coordinatorCredential, grantRequestId: 'second', requestId: 'shared-approve', at },
        material('sibling'),
      ),
    );

    // Assert
    should(actual.code).equal('conflict');
    should(actual.message).containEql('approval request id was reused');
  });
});

describe('TaskBoardAuthorizationService.authorize refusals', () => {
  const authorization = new TaskBoardAuthorizationService(hash);

  it('should report a binding whose board is gone as unavailable', () => {
    // Arrange
    const state = { ...createState(), boards: [] };

    // Act
    const actual = refusal(() => authorization.authorize(state, sessions, rootCredential, 'read'));

    // Assert
    should(actual.code).equal('unavailable');
    should(actual.message).containEql('no authoritative board');
  });

  it('should refuse a member whose exact session no longer resolves', () => {
    // Act
    const actual = refusal(() =>
      authorization.authorize(
        createState(),
        sessions.filter(candidate => candidate.id !== 'root'),
        rootCredential,
        'read',
      ),
    );

    // Assert
    should(actual.code).equal('forbidden');
    should(actual.message).containEql('no longer resolves its exact session');
  });

  it('should let a worker mutate only a task assigned to its exact session', () => {
    // Arrange
    const children = new TaskBoardChildGrantService(authorization);
    const bound = children.approve(
      requested(children, createState()),
      sessions,
      { coordinator: coordinatorCredential, grantRequestId: 'req', requestId: 'approve', at },
      material('child'),
    ).state;

    // Act
    const unassigned = refusal(() => authorization.authorize(bound, sessions, childCredential, 'status'));
    const assigned = authorization.authorize(bound, sessions, childCredential, 'status', {
      assignedSessionId: 'child',
    });

    // Assert
    should(unassigned.code).equal('forbidden');
    should(unassigned.message).containEql('only a task assigned to its exact session');
    should(assigned.role).equal('worker');
  });
});
