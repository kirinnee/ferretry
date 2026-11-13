import { describe, it } from 'bun:test';
import { ApiError, type ApiResponse } from '@ferretry/kernel/contract';
import type {
  CreatedWorktree,
  CreateWorktreeRequest,
  ManagedWorktreeView,
  RemovedWorktree,
  WorktreeListResponse,
  WorktreeRemovalDecision,
  WorktreeRemovalRequest,
} from '../../../../../contract/index.ts';
import should from 'should';
import {
  WORKTREE_ROUTE_KEYS,
  type WorktreeRouteKey,
  type WorktreeSubsystem,
  worktreeRoutes,
} from '../../../../../daemon/lib/runtime/mounts/worktrees.ts';
import { WorktreeError, type WorktreeErrorCode } from '../../../../../daemon/lib/worktrees/index.ts';
import { type RequestOf, jsonOf, requestOf } from '../../support/requests.ts';
import { refusalOf } from '../../support/calls.ts';

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

/** Calls one handler directly; the route spine (operator, capability, no-store) is the kernel's. */
const call = async (
  worktrees: WorktreeSubsystem,
  key: WorktreeRouteKey,
  spec: Omit<RequestOf, 'method' | 'path'> = {},
): Promise<ApiResponse> => {
  const [method = 'GET', path = '/'] = key.split(' ');
  return await worktreeRoutes(worktrees)[key](requestOf({ method, path, ...spec }));
};

/** The ApiError a handler threw, with its message. */
const thrownBy = async (work: Promise<unknown>): Promise<unknown> =>
  await work.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('the managed-worktree mount', () => {
  it('should key the four handlers exactly as the manifest declares them', () => {
    // Act
    const routes = worktreeRoutes(new FakeWorktrees());

    // Assert
    should(Object.keys(routes)).eql([...WORKTREE_ROUTE_KEYS]);
    should(Object.keys(routes)).eql([
      'GET /v1/worktrees/removal',
      'POST /v1/worktrees/remove',
      'GET /v1/worktrees',
      'POST /v1/worktrees',
    ]);
  });

  it('should serve the list', async () => {
    // Act
    const response = await call(new FakeWorktrees(), 'GET /v1/worktrees');

    // Assert
    should(response.status).equal(200);
    should(jsonOf(response)).match({ managedRoot: '/managed' });
  });

  it('should read the checkout and the caller directory from the query string', async () => {
    // Arrange
    const worktrees = new FakeWorktrees();

    // Act
    const response = await call(worktrees, 'GET /v1/worktrees/removal', {
      query: { path: ` ${PATH} `, cwd: ' /work/ferretry ' },
    });

    // Assert
    should(response.status).equal(200);
    should(worktrees.checks).eql([{ path: PATH, cwd: '/work/ferretry' }]);
  });

  it('should treat a blank caller directory as none rather than as an empty claim', async () => {
    // Arrange
    const worktrees = new FakeWorktrees();

    // Act
    await call(worktrees, 'GET /v1/worktrees/removal', { query: { path: PATH, cwd: '   ' } });

    // Assert
    should(worktrees.checks).eql([{ path: PATH }]);
  });

  it('should refuse a check that names no checkout', async () => {
    // Arrange
    const worktrees = new FakeWorktrees();

    // Act
    const blank = await refusalOf(call(worktrees, 'GET /v1/worktrees/removal', { query: { path: '  ' } }));
    const absent = await refusalOf(call(worktrees, 'GET /v1/worktrees/removal'));

    // Assert
    should([blank?.status, absent?.status]).eql([400, 400]);
    should(blank).match({ code: 'invalid_path' });
    should(worktrees.checks).be.empty();
  });

  it('should carry every class of consent through to the removal', async () => {
    // Arrange
    const worktrees = new FakeWorktrees();

    // Act
    const response = await call(worktrees, 'POST /v1/worktrees/remove', {
      body: {
        path: PATH,
        overrides: ['discard_worktree_changes'],
        deleteBranch: true,
        confirmations: ['delete_unmerged_branch'],
        currentWorkingDirectory: '/work/ferretry',
      },
    });

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
    const refusal = await refusalOf(
      call(worktrees, 'POST /v1/worktrees/remove', {
        body: { path: PATH, overrides: [], deleteBranch: false, confirmations: [], force: true },
      }),
    );

    // Assert
    should(refusal?.status).equal(400);
    should(worktrees.removals).be.empty();
  });

  it('should fork from a body and answer with the directory to start work in', async () => {
    // Arrange
    const worktrees = new FakeWorktrees();

    // Act
    const response = await call(worktrees, 'POST /v1/worktrees', {
      body: { sourcePath: '/work/ferretry', branch: 'feat/one', base: { kind: 'head' } },
    });

    // Assert
    should(response.status).equal(200);
    should(jsonOf(response)).match({ cwd: `${PATH}/packages/cli` });
    should(worktrees.creations[0]).match({ base: { kind: 'head' } });
  });

  it('should refuse a fork whose base is not one the contract defines', async () => {
    // Arrange
    const worktrees = new FakeWorktrees();

    // Act
    const refusal = await refusalOf(
      call(worktrees, 'POST /v1/worktrees', {
        body: { sourcePath: '/work/ferretry', branch: 'feat/one', base: { kind: 'yesterday' } },
      }),
    );

    // Assert
    should(refusal?.status).equal(400);
    should(worktrees.creations).be.empty();
  });

  it('should refuse a relative fork source before the subsystem can touch filesystem or Git', async () => {
    // Arrange
    const worktrees = new FakeWorktrees();

    // Act
    const refusal = await refusalOf(
      call(worktrees, 'POST /v1/worktrees', { body: { sourcePath: 'packages/cli', branch: 'feat/one' } }),
    );

    // Assert
    should(refusal?.status).equal(400);
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
    const actual: [WorktreeErrorCode, number | undefined][] = [];
    for (const [code] of expected) {
      const refusal = await refusalOf(
        call(new FakeWorktrees(new WorktreeError(code, `refused: ${code}`)), 'GET /v1/worktrees'),
      );
      actual.push([code, refusal?.status]);
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
    const thrown = await thrownBy(
      call(new FakeWorktrees(failure), 'POST /v1/worktrees/remove', {
        body: { path: PATH, overrides: [], deleteBranch: false, confirmations: [] },
      }),
    );

    // Assert
    should(thrown).be.instanceOf(ApiError);
    should(thrown).match({ status: 409, code: 'unsafe_remove', message: /staged_changes: it has edits/u });
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
    const thrown = await thrownBy(call(worktrees, 'GET /v1/worktrees'));

    // Assert — not restated as a domain refusal; the kernel answers 500 with a fixed message
    should(thrown).be.instanceOf(Error);
    should(thrown).not.be.instanceOf(ApiError);
  });
});
