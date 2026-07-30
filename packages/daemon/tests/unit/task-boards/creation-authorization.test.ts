import { describe, it } from 'bun:test';
import should from 'should';
import { TaskBoardAuthorizationService } from '../../../src/lib/task-boards/authorization-service.ts';
import { TaskBoardCreationService } from '../../../src/lib/task-boards/creation-service.ts';
import { TaskBoardError } from '../../../src/lib/task-boards/error.ts';
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
    name: input.name ?? null,
    teammate: input.teammate ?? null,
    sessionCapabilityHash: input.sessionCapabilityHash ?? hash(`session:${input.id}`),
  };
}

const sessions = [
  session({ id: 'root' }),
  session({ id: 'coordinator', parentSessionId: 'root', mode: 'auto' }),
  session({ id: 'child', parentSessionId: 'root', mode: 'auto' }),
  session({ id: 'external' }),
];

function createBoard(
  inputSessions: readonly TaskBoardSession[] = sessions,
): ReturnType<TaskBoardCreationService['create']> {
  const subject = new TaskBoardCreationService();
  return subject.create(
    EMPTY_TASK_BOARD_REPOSITORY_STATE,
    inputSessions,
    {
      creatorSessionId: 'root',
      coordinatorSessionId: 'coordinator',
      creatorMarkDone: true,
      requestId: 'create-1',
      at,
    },
    {
      boardId: 'board-1',
      creatorGrantId: 'grant-root',
      creatorCapability: { value: 'secret-root', hash: hash('secret-root') },
      coordinatorGrantId: 'grant-coordinator',
      coordinatorCapability: { value: 'secret-coordinator', hash: hash('secret-coordinator') },
    },
  );
}

describe('TaskBoardCreationService', () => {
  it('should atomically create explicit root and current-coordinator memberships', () => {
    // Arrange + Act
    const actual = createBoard();

    // Assert
    should(actual.result.created).be.true();
    should(actual.result.creator.allowedActions).containEql('mark_done');
    should(actual.result.coordinator.allowedActions).containEql('grant_approve');
    should(actual.state.boards).have.length(1);
    should(actual.state.bindings).have.length(2);
    should(actual.state.boards[0]?.audit.map(entry => entry.event)).deepEqual(['board.created']);
  });

  it('should replay a creation request without replacing its capabilities', () => {
    // Arrange
    const subject = new TaskBoardCreationService();
    const created = createBoard();

    // Act
    const actual = subject.create(
      created.state,
      sessions,
      {
        creatorSessionId: 'root',
        coordinatorSessionId: 'coordinator',
        creatorMarkDone: true,
        requestId: 'create-1',
        at,
      },
      {
        boardId: 'unused-board',
        creatorGrantId: 'unused-root-grant',
        creatorCapability: { value: 'unused-root-secret', hash: hash('unused-root-secret') },
        coordinatorGrantId: 'unused-coordinator-grant',
        coordinatorCapability: { value: 'unused-coordinator-secret', hash: hash('unused-coordinator-secret') },
      },
    );

    // Assert
    should(actual.result.created).be.false();
    should(actual.state).equal(created.state);
    should(actual.state.bindings.map(binding => binding.capability)).deepEqual(['secret-root', 'secret-coordinator']);
  });

  it('should reject a descendant creator and an unrelated coordinator', () => {
    // Arrange
    const subject = new TaskBoardCreationService();
    const descendantCreator = sessions.map(candidate =>
      candidate.id === 'root' ? { ...candidate, parentSessionId: 'external' } : candidate,
    );
    const unrelatedCoordinator = sessions.map(candidate =>
      candidate.id === 'coordinator' ? { ...candidate, parentSessionId: 'external' } : candidate,
    );

    // Act
    const createWith = (input: readonly TaskBoardSession[]): void => {
      subject.create(
        EMPTY_TASK_BOARD_REPOSITORY_STATE,
        input,
        {
          creatorSessionId: 'root',
          coordinatorSessionId: 'coordinator',
          requestId: 'create-negative',
          at,
        },
        {
          boardId: 'board-negative',
          creatorGrantId: 'grant-root-negative',
          creatorCapability: { value: 'root-negative', hash: hash('root-negative') },
          coordinatorGrantId: 'grant-coordinator-negative',
          coordinatorCapability: { value: 'coordinator-negative', hash: hash('coordinator-negative') },
        },
      );
    };

    // Assert
    should(() => createWith(descendantCreator)).throw(TaskBoardError);
    should(() => createWith(unrelatedCoordinator)).throw(TaskBoardError);
  });
});

describe('TaskBoardAuthorizationService', () => {
  it('should resolve only central board scope and refuse an unbound descendant', () => {
    // Arrange
    const state = createBoard().state;
    const subject = new TaskBoardAuthorizationService(hash);
    const credential = { sessionId: 'root', runtimeGeneration: 1, capabilityHash: hash('secret-root') };

    // Act
    const actual = subject.resolveTaskScope(state, sessions, 'root', credential, 'read');

    // Assert
    should(actual.kind).equal('board');
    should(actual.board.id).equal('board-1');
    should(() => subject.resolveTaskScope(state, sessions, 'child', credential, 'read')).throw(TaskBoardError);
  });

  it('should refuse a stopped member even when incarnation and generation still match', () => {
    // Arrange
    const state = createBoard().state;
    const stoppedSessions = sessions.map(candidate =>
      candidate.id === 'root' ? { ...candidate, active: false } : candidate,
    );
    const subject = new TaskBoardAuthorizationService(hash);

    // Act
    const authorize = (): void => {
      subject.authorize(
        state,
        stoppedSessions,
        { sessionId: 'root', runtimeGeneration: 1, capabilityHash: hash('secret-root') },
        'read',
      );
    };

    // Assert
    should(authorize).throw(TaskBoardError);
  });

  it('should refuse a stale binding after a coordinator epoch change', () => {
    // Arrange
    const created = createBoard();
    const board = created.state.boards[0];
    if (board === undefined) throw new Error('test fixture is missing its board');
    const state: TaskBoardRepositoryState = {
      ...created.state,
      boards: [{ ...board, boardEpoch: 2 }],
    };
    const subject = new TaskBoardAuthorizationService(hash);

    // Act
    const authorize = (): void => {
      subject.authorize(
        state,
        sessions,
        { sessionId: 'root', runtimeGeneration: 1, capabilityHash: hash('secret-root') },
        'read',
      );
    };

    // Assert
    should(authorize).throw(TaskBoardError);
  });
});
