import { describe, it } from 'bun:test';
import should from 'should';
import { TaskBoardCreationService } from '../../../src/lib/task-boards/creation-service.ts';
import { TaskBoardInvitationService } from '../../../src/lib/task-boards/invitation-service.ts';
import { TaskBoardAuthorizationService } from '../../../src/lib/task-boards/authorization-service.ts';
import {
  emptyTaskBoardState,
  parseTaskBoardSnapshot,
  serializeTaskBoardSnapshot,
  TASK_BOARD_SNAPSHOT_VERSION,
} from '../../../src/lib/task-boards/snapshot.ts';
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
  session({ id: 'external' }),
];

/** A board with grants, bindings, an audit trail and a creation record — every collection populated. */
function createdState(): TaskBoardRepositoryState {
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

/** The created board plus a pending invitation, so the invitation collection is populated too. */
function invitedState(): TaskBoardRepositoryState {
  const authorization = new TaskBoardAuthorizationService(hash);
  return new TaskBoardInvitationService(authorization, hash).request(createdState(), sessions, {
    source: { sessionId: 'root', runtimeGeneration: 1, capabilityHash: hash('root-secret') },
    targetSessionId: 'external',
    requestId: 'invite',
    at,
  }).state;
}

describe('task board snapshot codec', () => {
  it('should round-trip a populated repository through its durable form', () => {
    // Arrange
    const state = invitedState();

    // Act
    const read = parseTaskBoardSnapshot(serializeTaskBoardSnapshot(state));

    // Assert
    should(read.ok).be.true();
    if (!read.ok) return;
    should(read.state).eql(state);
  });

  it('should read a board written before retirement existed as one that has retired nobody', () => {
    // Arrange — a document from a daemon that had never heard of `retiredSessionIds`.
    const state = createdState();
    const board = state.boards[0];
    should(board).be.ok();
    const { retiredSessionIds: _absent, ...legacyBoard } = board ?? ({} as NonNullable<typeof board>);
    const legacy = JSON.stringify({
      version: TASK_BOARD_SNAPSHOT_VERSION,
      ...state,
      boards: [legacyBoard],
    });

    // Act
    const read = parseTaskBoardSnapshot(legacy);

    // Assert — it parses, and it parses as EMPTY rather than as absent.
    should(read.ok).be.true();
    if (!read.ok) return;
    should(read.state.boards[0]?.retiredSessionIds).deepEqual([]);
  });

  it('should round-trip the sessions a board has retired', () => {
    // Arrange
    const state = createdState();
    const board = state.boards[0];
    should(board).be.ok();
    if (board === undefined) return;
    const retired: TaskBoardRepositoryState = {
      ...state,
      boards: [{ ...board, retiredSessionIds: ['root', 'coordinator'] }],
    };

    // Act
    const read = parseTaskBoardSnapshot(serializeTaskBoardSnapshot(retired));

    // Assert
    should(read.ok).be.true();
    if (!read.ok) return;
    should(read.state).eql(retired);
  });

  it('should carry the document version beside the state so a shape change is a migration', () => {
    // Act
    const document: unknown = JSON.parse(serializeTaskBoardSnapshot(createdState()));

    // Assert
    should(document).have.property('version', TASK_BOARD_SNAPSHOT_VERSION);
  });

  it('should serialize the empty repository as a readable document', () => {
    // Act
    const read = parseTaskBoardSnapshot(serializeTaskBoardSnapshot(emptyTaskBoardState()));

    // Assert
    should(read.ok).be.true();
    if (!read.ok) return;
    should(read.state).eql(EMPTY_TASK_BOARD_REPOSITORY_STATE);
  });

  it('should refuse a document that is not JSON rather than reading it as empty', () => {
    // Act
    const read = parseTaskBoardSnapshot('{ not json');

    // Assert
    should(read.ok).be.false();
    if (read.ok) return;
    should(read.failure.detail).equal('the board document is not valid JSON');
  });

  it('should name the offending field when a grant is structurally wrong', () => {
    // Arrange — a grant whose role is not a role the domain knows.
    const state = createdState();
    const board = state.boards[0];
    should(board).be.ok();
    const damaged = JSON.stringify({
      version: TASK_BOARD_SNAPSHOT_VERSION,
      ...state,
      boards: [{ ...board, grants: [{ ...board?.grants[0], role: 'superuser' }] }],
    });

    // Act
    const read = parseTaskBoardSnapshot(damaged);

    // Assert
    should(read.ok).be.false();
    if (read.ok) return;
    should(read.failure.detail).match(/boards\.0\.grants\.0\.role/u);
  });

  it('should refuse a document from a future version rather than parsing it as this one', () => {
    // Arrange
    const damaged = JSON.stringify({ ...JSON.parse(serializeTaskBoardSnapshot(createdState())), version: 2 });

    // Act
    const read = parseTaskBoardSnapshot(damaged);

    // Assert
    should(read.ok).be.false();
    if (read.ok) return;
    should(read.failure.detail).match(/version/u);
  });

  it('should refuse a document carrying a field the schema does not declare', () => {
    // Arrange — an unknown top-level key is a document this daemon does not understand, and a board
    // it half-understands is a board it must not authorize against.
    const damaged = JSON.stringify({
      ...JSON.parse(serializeTaskBoardSnapshot(createdState())),
      operatorOverride: true,
    });

    // Act
    const read = parseTaskBoardSnapshot(damaged);

    // Assert
    should(read.ok).be.false();
    if (read.ok) return;
    should(read.failure.detail).match(/operatorOverride/u);
  });

  it('should name the whole document when the top level is not an object', () => {
    // Act
    const read = parseTaskBoardSnapshot('[]');

    // Assert
    should(read.ok).be.false();
    if (read.ok) return;
    should(read.failure.detail).match(/^document: /u);
  });
});
