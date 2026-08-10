import { describe, it } from 'bun:test';
import should from 'should';
import type { ProjectInfo } from '../../src/lib/catalog.ts';
import {
  CreateWorktreeRequestSchema,
  CreatedWorktreeSchema,
  ManagedWorktreeViewSchema,
  isProtocolAbsolutePath,
  projectForWorktree,
  RemovedWorktreeSchema,
  unclearedRemovalBlockers,
  WorktreeBaseSchema,
  type WorktreeRemovalBlocker,
  WorktreeListResponseSchema,
  WorktreeRemovalDecisionSchema,
  WorktreeRemovalRequestSchema,
} from '../../src/lib/worktrees.ts';

const VIEW = {
  path: '/managed/repo-abc/feat-1-sess',
  branch: 'feat/one',
  repositoryRoot: '/work/ferretry',
  commonDirectory: '/work/ferretry/.git',
  relativeCwd: 'packages/cli',
  createdAt: '2026-08-04T00:00:00.000Z',
  initialHead: 'a'.repeat(40),
  branchPreexisted: false,
  ownerActive: false,
};

const project = (overrides: Partial<ProjectInfo> = {}): ProjectInfo => ({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'ferretry',
  path: '/work/ferretry',
  source: 'existing-folder',
  createdAt: '2026-08-04T00:00:00.000Z',
  git: { commonDirectory: '/work/ferretry/.git' },
  ...overrides,
});

const blocker = (overrides: Partial<WorktreeRemovalBlocker> = {}): WorktreeRemovalBlocker => ({
  code: 'unstaged_changes',
  message: 'the checkout has unstaged changes',
  override: 'discard_worktree_changes',
  ...overrides,
});

describe('the managed-worktree wire contract', () => {
  it('should accept a record that carries only its durable facts', () => {
    // Act
    const actual = ManagedWorktreeViewSchema.parse(VIEW);

    // Assert — `sharedWith` defaults rather than arriving undefined, so a renderer never branches on it
    should(actual.sharedWith).eql([]);
    should(actual.live).be.undefined();
    should(actual.removal).be.undefined();
  });

  it('should carry live Git evidence and the removal verdict beside the record', () => {
    // Act
    const actual = WorktreeListResponseSchema.parse({
      managedRoot: '/managed',
      worktrees: [
        {
          ...VIEW,
          projectId: project().id,
          live: {
            head: 'b'.repeat(40),
            branch: 'feat/one',
            detached: false,
            status: {
              staged: true,
              unstaged: false,
              untracked: false,
              ignored: false,
              conflicted: false,
              dirtySubmodule: false,
              truncated: false,
            },
            upstream: 'origin/feat/one',
            ahead: 3,
            behind: 1,
            locked: '',
            prunable: 'gitdir file points to non-existent location',
            integrated: false,
            undetermined: [],
          },
          removal: { removable: false, path: VIEW.path, branch: VIEW.branch, blockers: [blocker()] },
        },
      ],
    });

    // Assert
    should(actual.worktrees[0]?.live).match({ ahead: 3, behind: 1, locked: '' });
    should(actual.worktrees[0]?.removal?.blockers).have.length(1);
  });

  it('should refuse a blocker code the daemon does not define', () => {
    // Arrange — the client used to accept any non-empty string here, so a rename rendered rather
    // than failing.
    const payload = {
      removable: false,
      path: '/managed/x',
      branch: 'feat/one',
      blockers: [{ code: 'because_i_said_so', message: 'no' }],
    };

    // Act + Assert
    should(WorktreeRemovalDecisionSchema.safeParse(payload).success).be.false();
  });

  it('should refuse an override or confirmation outside its closed set', () => {
    // Act + Assert
    should(
      WorktreeRemovalRequestSchema.safeParse({
        path: '/managed/x',
        overrides: ['force_everything'],
        deleteBranch: false,
        confirmations: [],
      }).success,
    ).be.false();
    should(
      WorktreeRemovalRequestSchema.safeParse({
        path: '/managed/x',
        overrides: ['delete_unmerged_branch'],
        deleteBranch: true,
        confirmations: ['delete_unmerged_branch'],
      }).success,
    ).be.false();
    should(
      WorktreeRemovalRequestSchema.safeParse({
        path: '/managed/x',
        overrides: [],
        deleteBranch: true,
        confirmations: ['just_do_it'],
      }).success,
    ).be.false();
  });

  it('should refuse a removal request carrying a field nothing declared', () => {
    // Act + Assert — a strict object, so a client inventing `force: true` fails here rather than
    // being silently dropped on the way to a destructive route.
    should(
      WorktreeRemovalRequestSchema.safeParse({
        path: '/managed/x',
        overrides: [],
        deleteBranch: false,
        confirmations: [],
        force: true,
      }).success,
    ).be.false();
  });

  it('should let a removal carry the caller directory and default the branch blockers', () => {
    // Act
    const request = WorktreeRemovalRequestSchema.parse({
      path: '/managed/x',
      overrides: ['accept_unpushed_commits'],
      deleteBranch: true,
      confirmations: ['delete_unmerged_branch'],
      currentWorkingDirectory: '/work/ferretry',
    });
    const answer = RemovedWorktreeSchema.parse({
      path: '/managed/x',
      branch: 'feat/one',
      branchRetained: true,
      removedAt: '2026-08-04T01:00:00.000Z',
    });

    // Assert
    should(request.currentWorkingDirectory).equal('/work/ferretry');
    should(answer.branchBlockers).eql([]);
  });

  it('should default a fork to the automatic base and accept each explicit one', () => {
    // Act
    const automatic = CreateWorktreeRequestSchema.parse({ sourcePath: '/work/ferretry', branch: 'feat/one' });

    // Assert
    should(automatic.base).eql({ kind: 'auto' });
    for (const base of [{ kind: 'head' }, { kind: 'default-branch' }, { kind: 'commit', reference: 'v1.2.3' }]) {
      should(WorktreeBaseSchema.safeParse(base).success).be.true();
    }
    should(WorktreeBaseSchema.safeParse({ kind: 'commit' }).success).be.false();
    should(WorktreeBaseSchema.safeParse({ kind: 'yesterday' }).success).be.false();
  });

  it('should require a protocol-absolute fork source before any daemon can resolve it', () => {
    // Act + Assert
    for (const absolute of ['/work/ferretry', 'C:\\work\\ferretry', '\\\\server\\share\\repo']) {
      should(isProtocolAbsolutePath(absolute)).be.true();
      should(CreateWorktreeRequestSchema.safeParse({ sourcePath: absolute, branch: 'feat/one' }).success).be.true();
    }
    for (const relative of ['work/ferretry', './repo', '../repo', 'C:repo']) {
      should(isProtocolAbsolutePath(relative)).be.false();
      should(CreateWorktreeRequestSchema.safeParse({ sourcePath: relative, branch: 'feat/one' }).success).be.false();
    }
  });

  it('should let a row say it is an unfinished creation rather than pretending to be a checkout', () => {
    // Act
    const actual = ManagedWorktreeViewSchema.parse({
      ...VIEW,
      unresolved: 'declared at 2026-08-04T00:00:00.000Z and never finished',
    });

    // Assert — kept and said, because dropping the row is what strands a directory
    should(actual.unresolved).containEql('never finished');
    should(actual.live).be.undefined();
  });

  it('should answer a fork with the record and the directory to start work in', () => {
    // Act
    const actual = CreatedWorktreeSchema.parse({ worktree: VIEW, cwd: `${VIEW.path}/packages/cli` });

    // Assert
    should(actual.cwd).equal('/managed/repo-abc/feat-1-sess/packages/cli');
  });
});

describe('the consent decision both programs make', () => {
  it('should clear exactly the blockers the caller consented to by name', () => {
    // Arrange
    const blockers = [blocker(), blocker({ code: 'unpushed_commits', override: 'accept_unpushed_commits' })];

    // Act + Assert
    should(unclearedRemovalBlockers(blockers, [])).have.length(2);
    should(unclearedRemovalBlockers(blockers, ['discard_worktree_changes']).map(item => item.code)).eql([
      'unpushed_commits',
    ]);
    should(unclearedRemovalBlockers(blockers, ['discard_worktree_changes', 'accept_unpushed_commits'])).be.empty();
  });

  it('should never clear a blocker that names no override, whatever is granted', () => {
    // Arrange — somebody else is working in the checkout; no flag makes that safe
    const blockers = [blocker({ code: 'shared_checkout', override: undefined })];

    // Act + Assert
    should(unclearedRemovalBlockers(blockers, ['discard_worktree_changes', 'accept_unpushed_commits'])).have.length(1);
  });

  it('should let an unforceable blocker win over a contradictory removable boolean', () => {
    // Arrange — the boolean is presentation; the closed blocker set is the evidence authorization
    // must honor, so a malformed or skewed payload cannot turn an unforceable refusal into consent.
    const blockers = [blocker({ code: 'shared_checkout', override: undefined })];

    // Act + Assert
    should(unclearedRemovalBlockers(blockers, [])).have.length(1);
    should(unclearedRemovalBlockers(blockers, ['discard_worktree_changes', 'accept_unpushed_commits'])).have.length(1);
  });
});

describe('joining a checkout to its Project', () => {
  it('should match on the repository identity rather than on where the two sit on disk', () => {
    // Arrange — a managed checkout lives under the daemon's root, nowhere near its Project
    const projects = [
      project({ id: 'other', path: '/work/elsewhere', git: { commonDirectory: '/work/other/.git' } }),
      project(),
    ];

    // Act
    const actual = projectForWorktree(projects, '/work/ferretry/.git');

    // Assert
    should(actual?.id).equal(project().id);
  });

  it('should leave a non-Git Project outside this surface entirely', () => {
    // Arrange
    const projects = [project({ git: undefined })];

    // Act + Assert
    should(projectForWorktree(projects, '/work/ferretry/.git')).be.undefined();
    should(projectForWorktree([project()], '')).be.undefined();
    should(projectForWorktree([], '/work/ferretry/.git')).be.undefined();
  });
});
