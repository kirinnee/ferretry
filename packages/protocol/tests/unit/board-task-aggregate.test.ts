import { describe, it } from 'bun:test';
import should from 'should';
import {
  BoardMemberSchema,
  BoardTaskListResponseSchema,
  BoardTaskRowSchema,
  BoardViewerSchema,
  TaskBoardActiveRoleSchema,
} from '../../src/lib/task-boards.ts';
import { INSTANT } from '../fixtures.ts';

/**
 * The board-scoped task aggregate, tested for the properties a union of task files cannot have.
 *
 * `work-management.test.ts` already proves every board schema round-trips and that none is left
 * uncovered. What is here instead is the handful of statements this shape exists to make true, each
 * of which is a defect somewhere else if the schema stops enforcing it: a row always knows its owner,
 * two members' identically-numbered tasks stay two rows, the operator is never dressed as a member,
 * and a permission list can only ever name real board actions.
 */

const links = { prs: [], branch: null, commits: [], docs: [] };
const live = {
  assigneeSessionId: null,
  assigneeName: null,
  assigneeStatus: null,
  assigneeHealth: null,
  assigneeDoneMarker: false,
  assigneeLastActivityAt: null,
  staleness: null,
};

/** A minimal, valid task summary. Owned by nothing until a board row names its session. */
const summary = (id: string) => ({
  v: 1,
  id,
  kind: 'feature',
  title: `Task ${id}`,
  workflow: 'quick',
  phase: 'live',
  dependsOn: [],
  status: 'live',
  statusReason: null,
  assignee: null,
  repo: null,
  files: [],
  links,
  order: null,
  createdAt: INSTANT,
  createdBy: null,
  updatedAt: INSTANT,
  live,
  blocked: false,
  blockedReason: null,
  blockedSince: null,
  blockedBy: [],
  descriptionChars: 0,
  askChars: 2,
  askSource: 'message-1',
  clarificationCount: 0,
});

const row = (id: string, sessionId: string, actions: readonly string[] = ['read']) => ({
  ...summary(id),
  sessionId,
  sessionName: null,
  actions: [...actions],
});

const response = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  v: 1,
  boardId: 'board-1',
  boardEpoch: 2,
  coordinatorEpoch: 1,
  viewer: { kind: 'human_admin' },
  members: [],
  rows: [],
  updatedAt: INSTANT,
  ...overrides,
});

describe('the board task aggregate', () => {
  describe('row ownership', () => {
    it('should refuse a row that does not name the session owning it', () => {
      // A nullable owner is what makes a fleet read need its consumer to re-assert a scope it already
      // knew. Here the owner is part of the row or there is no row.
      // Arrange
      const { sessionId: _dropped, ...ownerless } = row('F1', 'session-1');

      // Act & Assert
      should(BoardTaskRowSchema.safeParse(ownerless).success).be.false();
      should(BoardTaskRowSchema.safeParse({ ...row('F1', 'session-1'), sessionId: null }).success).be.false();
      should(BoardTaskRowSchema.safeParse({ ...row('F1', 'session-1'), sessionId: '' }).success).be.false();
      should(BoardTaskRowSchema.safeParse({ ...row('F1', 'session-1'), sessionId: 42 }).success).be.false();
    });

    it('should keep two members holding the same task id as two distinct rows', () => {
      // THE reason this response type exists. Task ids are allocated per session and start at 1, so
      // an `F1` on two boards is two unrelated pieces of work. A shape that could not tell them apart
      // would let a surface merge them, and a completion would land on whichever one it found first.
      // Arrange
      const parsed = BoardTaskListResponseSchema.parse(
        response({ rows: [row('F1', 'session-1'), row('F1', 'session-2')] }),
      );

      // Act
      const identities = parsed.rows.map(entry => `${entry.sessionId}/${entry.id}`);

      // Assert
      should(parsed.rows).have.length(2);
      should(identities).eql(['session-1/F1', 'session-2/F1']);
      should(new Set(identities).size).equal(2);
      should(new Set(parsed.rows.map(entry => entry.id)).size).equal(1);
    });
  });

  describe('row actions', () => {
    it('should accept only actions the board vocabulary names', () => {
      // Arrange & Act & Assert
      should(BoardTaskRowSchema.safeParse(row('F1', 'session-1', ['read', 'mark_done'])).success).be.true();
      should(BoardTaskRowSchema.safeParse(row('F1', 'session-1', ['delete'])).success).be.false();
      should(BoardTaskRowSchema.safeParse(row('F1', 'session-1', ['MARK_DONE'])).success).be.false();
      should(BoardTaskRowSchema.safeParse({ ...row('F1', 'session-1'), actions: 'read' }).success).be.false();
    });

    it('should refuse a repeated action, because the field is a permission set', () => {
      // The same rule `TaskBoardMembershipSchema` applies to `allowedActions`: a repeat is a server
      // defect, and a wire that accepts it lets one ship unnoticed.
      // Act & Assert
      should(BoardTaskRowSchema.safeParse(row('F1', 'session-1', ['read', 'read'])).success).be.false();
    });

    it('should accept an empty action list, which is how a row a caller may not touch is expressed', () => {
      // Act & Assert
      should(BoardTaskRowSchema.safeParse(row('F1', 'session-1', [])).success).be.true();
    });
  });

  describe('the viewer', () => {
    it('should let the operator carry no membership, grant, role or epoch of its own', () => {
      // The operator holds no grant, so there is nothing truthful to put here. The arm carries its
      // discriminator and stops.
      // Act
      const parsed = BoardViewerSchema.parse({ kind: 'human_admin' });

      // Assert
      should(parsed).eql({ kind: 'human_admin' });
      should(Object.keys(parsed)).eql(['kind']);
    });

    it('should refuse an operator viewer that smuggles membership fields in beside the discriminator', () => {
      // A synthesised grant for the operator would be invented authority evidence — the exact shape of
      // the folded `mayMarkDone` predicate the board domain removed.
      // Arrange
      const membership = {
        sessionId: 'session-1',
        role: 'top_agent',
        allowedActions: ['read'],
        boardEpoch: 1,
        coordinatorEpoch: 1,
        runtimeGeneration: 1,
      };

      // Act & Assert
      should(BoardViewerSchema.safeParse({ kind: 'human_admin', membership }).success).be.false();
      should(BoardViewerSchema.safeParse({ kind: 'human_admin', role: 'top_agent' }).success).be.false();
      should(BoardViewerSchema.safeParse({ kind: 'human_admin', allowedActions: ['read'] }).success).be.false();
    });

    it('should require a member viewer to carry a coherent membership', () => {
      // Arrange — `allowedActions: ['assign']` is outside the `read` role, which the membership schema
      // already refuses. The union must not become a way around that refinement.
      const coherent = {
        sessionId: 'session-1',
        role: 'read',
        allowedActions: ['read'],
        boardEpoch: 1,
        coordinatorEpoch: 1,
        runtimeGeneration: 1,
      };

      // Act & Assert
      should(BoardViewerSchema.safeParse({ kind: 'member', membership: coherent }).success).be.true();
      should(BoardViewerSchema.safeParse({ kind: 'member' }).success).be.false();
      should(BoardViewerSchema.safeParse({ kind: 'member', membership: coherent, grantId: 'g1' }).success).be.false();
      should(
        BoardViewerSchema.safeParse({ kind: 'member', membership: { ...coherent, allowedActions: ['assign'] } })
          .success,
      ).be.false();
    });

    it('should refuse a viewer kind outside the two the board can answer for', () => {
      // Act & Assert
      should(BoardViewerSchema.safeParse({ kind: 'warden' }).success).be.false();
      should(BoardViewerSchema.safeParse({ kind: 'daemon' }).success).be.false();
      should(BoardViewerSchema.safeParse({}).success).be.false();
    });
  });

  describe('members', () => {
    it('should refuse the non-role, because a member entry exists only for an active grant', () => {
      // Arrange
      const member = { sessionId: 'session-1', name: null, role: 'none', active: true };

      // Act & Assert
      should(BoardMemberSchema.safeParse(member).success).be.false();
      should(BoardMemberSchema.safeParse({ ...member, role: 'read' }).success).be.true();
      should(TaskBoardActiveRoleSchema.safeParse('none').success).be.false();
      should(TaskBoardActiveRoleSchema.options).eql(['read', 'worker', 'coordinator', 'top_agent']);
    });

    it('should refuse an unknown key rather than carry a field nothing agreed on', () => {
      // Act & Assert
      should(
        BoardMemberSchema.safeParse({ sessionId: 'session-1', name: null, role: 'read', active: true, grantId: 'g1' })
          .success,
      ).be.false();
    });
  });

  describe('the envelope', () => {
    it('should reject a payload version this protocol does not serve', () => {
      // Act & Assert
      should(BoardTaskListResponseSchema.safeParse(response({ v: 0 })).success).be.false();
      should(BoardTaskListResponseSchema.safeParse(response({ v: 2 })).success).be.false();
    });

    it('should refuse an unknown key', () => {
      // Act & Assert
      should(BoardTaskListResponseSchema.safeParse(response({ boardCapability: 'secret' })).success).be.false();
      should(BoardTaskListResponseSchema.safeParse(response({ sessionId: null })).success).be.false();
    });

    it('should require the board to name itself, so the answer can never be scope-less', () => {
      // `FleetTaskListResponse` answers `sessionId: null` — its identity is "no scope". This one is
      // always some board's, and says which.
      // Arrange
      const { boardId: _dropped, ...anonymous } = response();

      // Act & Assert
      should(BoardTaskListResponseSchema.safeParse(anonymous).success).be.false();
      should(BoardTaskListResponseSchema.safeParse(response({ boardId: '' })).success).be.false();
    });

    it('should carry the board epochs for both viewer arms', () => {
      // The epochs are facts about the BOARD, not about the caller, so a reader with no grant still
      // learns that the board moved underneath the list it is holding.
      // Arrange
      const membership = {
        sessionId: 'session-1',
        role: 'read',
        allowedActions: ['read'],
        boardEpoch: 1,
        coordinatorEpoch: 1,
        runtimeGeneration: 1,
      };

      // Act
      const operator = BoardTaskListResponseSchema.parse(response());
      const member = BoardTaskListResponseSchema.parse(response({ viewer: { kind: 'member', membership } }));

      // Assert
      should(operator.boardEpoch).equal(2);
      should(member.boardEpoch).equal(2);
      should(operator.viewer.kind).equal('human_admin');
      should(member.viewer.kind).equal('member');
    });

    it('should accept an empty board — no members and no rows is a real answer, not a missing one', () => {
      // Act & Assert
      should(BoardTaskListResponseSchema.safeParse(response()).success).be.true();
    });
  });

  describe('read-boundary claims', () => {
    it('should remove capability, grant, and provenance claims from a task-summary-derived row', () => {
      // Task summaries intentionally preserve their established non-strict convention. The aggregate
      // adds no second summary definition, but these fields must still never survive into its public
      // row type: authority belongs to the daemon's write path, not to a read response.
      // Arrange
      const parsed = BoardTaskRowSchema.parse({
        ...row('F1', 'session-1'),
        boardCapability: 'secret',
        grantId: 'grant-1',
        authorization: { requestId: 'request-1' },
      });

      // Act & Assert
      for (const key of ['boardCapability', 'grantId', 'authorization']) {
        should(Object.prototype.hasOwnProperty.call(parsed, key)).be.false();
      }
    });
  });
});
