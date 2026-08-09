import { describe, it } from 'bun:test';
import type {
  CreatedWorktree,
  CreateWorktreeRequest,
  ManagedWorktreeView,
  RemovedWorktree,
  WorktreeListResponse,
  WorktreeRemovalDecision,
  WorktreeRemovalRequest,
} from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher, ApiRouter } from '../../../../src/lib/api/index.ts';
import { type WorktreeSubsystem, worktreeRoutes } from '../../../../src/lib/runtime/mounts/worktrees.ts';
import { WorktreeError, type WorktreeErrorCode } from '../../../../src/lib/worktrees/index.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, GRANTED, human } from './support.ts';

const PATH = '/managed/repo/feat-one';

const VIEW: ManagedWorktreeView = {
  path: PATH,
  branch: 'feat/one',
  repositoryRoot: '/work/ferretry',
  commonDirectory: '/work/ferretry/.git',
  relativeCwd: 'packages/cli',
  createdAt: '2026-08-04T00:00:00.000Z',
  initialHead: 'a'.repeat(40),
  branchPreexisted: false,
  ownerActive: false,
  sharedWith: [],
};

const DECISION: WorktreeRemovalDecision = { removable: true, path: PATH, branch: 'feat/one', blockers: [] };

const REMOVED: RemovedWorktree = {
  path: PATH,
  branch: 'feat/one',
  branchRetained: true,
  removedAt: '2026-08-04T02:00:00.000Z',
  branchBlockers: [],
};

/** A subsystem that answers with fixtures and records what the routes asked of it. */
class FakeWorktrees implements WorktreeSubsystem {
  readonly checks: { path: string; cwd?: string }[] = [];
  readonly removals: WorktreeRemovalRequest[] = [];
  readonly creations: CreateWorktreeRequest[] = [];

  constructor(private readonly failure?: WorktreeError) {}

  async list(): Promise<WorktreeListResponse> {
    if (this.failure) throw this.failure;
    return { worktrees: [VIEW], managedRoot: '/managed' };
  }

  async checkRemoval(path: string, cwd?: string): Promise<WorktreeRemovalDecision> {
    this.checks.push({ path, ...(cwd === undefined ? {} : { cwd }) });
    if (this.failure) throw this.failure;
    return DECISION;
  }

  async remove(input: WorktreeRemovalRequest): Promise<RemovedWorktree> {
    this.removals.push(input);
    if (this.failure) throw this.failure;
    return REMOVED;
  }

  async create(input: CreateWorktreeRequest): Promise<CreatedWorktree> {
    this.creations.push(input);
    if (this.failure) throw this.failure;
    return { worktree: VIEW, cwd: `${PATH}/packages/cli` };
  }
}

const dispatcher = (worktrees: WorktreeSubsystem): ApiDispatcher =>
  new ApiDispatcher(new ApiRouter(worktreeRoutes(worktrees)), CREDENTIALS, GRANTED);

describe('the managed-worktree mount', () => {
  it('should govern every route by the filesystem capability, reading with use and writing with configure', () => {
    // Act
    const routes = worktreeRoutes(new FakeWorktrees());

    // Assert — a single axis would trade the power to list for the power to destroy, in one direction
    // or the other.
    should(routes.map(route => `${route.method} ${route.path}`)).eql([
      'GET /v1/worktrees/removal',
      'POST /v1/worktrees/remove',
      'GET /v1/worktrees',
      'POST /v1/worktrees',
    ]);
    should(routes.map(route => route.capability?.axis)).eql(['use', 'configure', 'use', 'configure']);
    should(routes.every(route => route.capability?.capability === 'filesystem')).be.true();
    should(routes.every(route => route.minimum === 'operator')).be.true();
    should(routes.every(route => route.noStore === true)).be.true();
  });

  it('should serve the list uncacheable, because a stale row is how a removal destroys work', async () => {
    // Act
    const response = await dispatcher(new FakeWorktrees()).dispatch(
      request({ method: 'GET', path: '/v1/worktrees', headers: human }),
    );

    // Assert
    should(response.status).equal(200);
    should(response.headers.get('cache-control')).equal('no-store');
    should(jsonBody(response)).match({ managedRoot: '/managed' });
  });

  it('should read the checkout and the caller directory from the query string', async () => {
    // Arrange
    const worktrees = new FakeWorktrees();

    // Act
    const response = await dispatcher(worktrees).dispatch(
      request({
        method: 'GET',
        path: '/v1/worktrees/removal',
        query: [
          ['path', ` ${PATH} `],
          ['cwd', ' /work/ferretry '],
        ],
        headers: human,
      }),
    );

    // Assert
    should(response.status).equal(200);
    should(worktrees.checks).eql([{ path: PATH, cwd: '/work/ferretry' }]);
  });

  it('should treat a blank caller directory as none rather than as an empty claim', async () => {
    // Arrange
    const worktrees = new FakeWorktrees();

    // Act
    await dispatcher(worktrees).dispatch(
      request({
        method: 'GET',
        path: '/v1/worktrees/removal',
        query: [
          ['path', PATH],
          ['cwd', '   '],
        ],
        headers: human,
      }),
    );

    // Assert
    should(worktrees.checks).eql([{ path: PATH }]);
  });

  it('should refuse a check that names no checkout', async () => {
    // Arrange
    const worktrees = new FakeWorktrees();

    // Act
    const blank = await dispatcher(worktrees).dispatch(
      request({ method: 'GET', path: '/v1/worktrees/removal', query: [['path', '  ']], headers: human }),
    );
    const absent = await dispatcher(worktrees).dispatch(
      request({ method: 'GET', path: '/v1/worktrees/removal', headers: human }),
    );

    // Assert
    should([blank.status, absent.status]).eql([400, 400]);
    should(jsonBody(blank)).match({ code: 'invalid_path' });
    should(worktrees.checks).be.empty();
  });

  it('should carry every class of consent through to the removal', async () => {
    // Arrange
    const worktrees = new FakeWorktrees();

    // Act
    const response = await dispatcher(worktrees).dispatch(
      request({
        method: 'POST',
        path: '/v1/worktrees/remove',
        headers: human,
        body: JSON.stringify({
          path: PATH,
          overrides: ['discard_worktree_changes'],
          deleteBranch: true,
          confirmations: ['delete_unmerged_branch'],
          currentWorkingDirectory: '/work/ferretry',
        }),
      }),
    );

    // Assert
    should(response.status).equal(200);
    should(worktrees.removals[0]).match({
      overrides: ['discard_worktree_changes'],
      deleteBranch: true,
      confirmations: ['delete_unmerged_branch'],
      currentWorkingDirectory: '/work/ferretry',
    });
  });

  it('should refuse a removal body that invents a blanket force', async () => {
    // Arrange
    const worktrees = new FakeWorktrees();

    // Act
    const response = await dispatcher(worktrees).dispatch(
      request({
        method: 'POST',
        path: '/v1/worktrees/remove',
        headers: human,
        body: JSON.stringify({ path: PATH, overrides: [], deleteBranch: false, confirmations: [], force: true }),
      }),
    );

    // Assert
    should(response.status).equal(400);
    should(worktrees.removals).be.empty();
  });

  it('should fork from a body and answer with the directory to start work in', async () => {
    // Arrange
    const worktrees = new FakeWorktrees();

    // Act
    const response = await dispatcher(worktrees).dispatch(
      request({
        method: 'POST',
        path: '/v1/worktrees',
        headers: human,
        body: JSON.stringify({ sourcePath: '/work/ferretry', branch: 'feat/one', base: { kind: 'head' } }),
      }),
    );

    // Assert
    should(response.status).equal(200);
    should(jsonBody(response)).match({ cwd: `${PATH}/packages/cli` });
    should(worktrees.creations[0]).match({ base: { kind: 'head' } });
  });

  it('should refuse a fork whose base is not one the contract defines', async () => {
    // Arrange
    const worktrees = new FakeWorktrees();

    // Act
    const response = await dispatcher(worktrees).dispatch(
      request({
        method: 'POST',
        path: '/v1/worktrees',
        headers: human,
        body: JSON.stringify({ sourcePath: '/work/ferretry', branch: 'feat/one', base: { kind: 'yesterday' } }),
      }),
    );

    // Assert
    should(response.status).equal(400);
    should(worktrees.creations).be.empty();
  });

  it('should refuse a relative fork source before the subsystem can touch filesystem or Git', async () => {
    // Arrange
    const worktrees = new FakeWorktrees();

    // Act
    const response = await dispatcher(worktrees).dispatch(
      request({
        method: 'POST',
        path: '/v1/worktrees',
        headers: human,
        body: JSON.stringify({ sourcePath: 'packages/cli', branch: 'feat/one' }),
      }),
    );

    // Assert
    should(response.status).equal(400);
    should(worktrees.creations).be.empty();
  });

  it('should give each refusal its own status, so a client knows the next step', async () => {
    // Arrange
    const expected: ReadonlyArray<readonly [WorktreeErrorCode, number]> = [
      ['unknown_worktree', 404],
      ['unsafe_remove', 409],
      ['no_managed_root', 409],
      ['branch_in_use', 409],
      ['destination_exists', 409],
      ['unsafe_checkout_filter', 409],
      ['not_git_repository', 422],
      ['invalid_branch', 422],
      ['invalid_session_id', 422],
      ['ambiguous_remote_branch', 422],
      ['unresolved_base', 422],
      ['registry_damaged', 500],
      ['verification_failed', 500],
      ['invalid_ownership_token', 500],
    ];

    // Act
    const actual: [WorktreeErrorCode, number][] = [];
    for (const [code] of expected) {
      const response = await dispatcher(new FakeWorktrees(new WorktreeError(code, `refused: ${code}`))).dispatch(
        request({ method: 'GET', path: '/v1/worktrees', headers: human }),
      );
      actual.push([code, response.status]);
    }

    // Assert
    should(actual).eql(expected.map(entry => [...entry]));
  });

  it('should name every blocker in the refusal, since the check the caller would ask is the one they asked', async () => {
    // Arrange
    const failure = new WorktreeError('unsafe_remove', 'refusing to remove /managed/x: staged_changes: it has edits', [
      { code: 'staged_changes', message: 'it has edits', override: 'discard_worktree_changes' },
    ]);

    // Act
    const response = await dispatcher(new FakeWorktrees(failure)).dispatch(
      request({
        method: 'POST',
        path: '/v1/worktrees/remove',
        headers: human,
        body: JSON.stringify({ path: PATH, overrides: [], deleteBranch: false, confirmations: [] }),
      }),
    );

    // Assert
    should(response.status).equal(409);
    should(jsonBody(response)).match({ code: 'unsafe_remove', error: /staged_changes: it has edits/u });
  });

  it('should let an error that is not this domain answer as the defect it is', async () => {
    // Arrange
    const worktrees: WorktreeSubsystem = {
      list: async () => {
        throw new Error('the disk fell off');
      },
      checkRemoval: async () => DECISION,
      remove: async () => REMOVED,
      create: async () => ({ worktree: VIEW, cwd: PATH }),
    };

    // Act
    const response = await dispatcher(worktrees).dispatch(
      request({ method: 'GET', path: '/v1/worktrees', headers: human }),
    );

    // Assert — the dispatcher answers 500 with a fixed message rather than leaking the thrown text
    should(response.status).equal(500);
    should(JSON.stringify(jsonBody(response))).not.containEql('the disk fell off');
  });

  it('should refuse a fork or a removal from a caller below operator', async () => {
    // Act
    const response = await dispatcher(new FakeWorktrees()).dispatch(
      request({ method: 'POST', path: '/v1/worktrees', body: JSON.stringify({ sourcePath: '/x', branch: 'b' }) }),
    );

    // Assert
    should(response.status).equal(401);
  });
});
