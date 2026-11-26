import { describe, it } from 'bun:test';
import should from 'should';
import { type ManagedWorktreeSummary, REPO_WORKTREE_LIMIT } from '../../../../contract/index.ts';
import {
  ferretsByRow,
  REPO_LIST_BUDGET_MS,
  RepoWorktreeLister,
  type RepoWorktreeEvidence,
} from '../../../../daemon/lib/worktrees/repo-list.ts';
import {
  type CheckManagedWorktreeRemovalInput,
  type ManagedWorktreeInspection,
  type WorktreeListEntry,
  type WorktreeSessionFact,
  WorktreeError,
} from '../../../../daemon/lib/worktrees/index.ts';

const COMMON = '/work/repo/.git';
const MAIN = '/work/repo';
const FEATURE = '/managed/repo-aaaa/feature-bbbb';
const HAND_MADE = '/tmp/hand-made';

const entry = (path: string, overrides: Partial<WorktreeListEntry> = {}): WorktreeListEntry => ({
  path,
  head: 'a'.repeat(40),
  branch: path.split('/').pop(),
  detached: false,
  bare: false,
  ...overrides,
});

const record = (path: string, overrides: Partial<ManagedWorktreeSummary> = {}): ManagedWorktreeSummary => ({
  path,
  branch: 'feature',
  repositoryRoot: MAIN,
  commonDirectory: COMMON,
  relativeCwd: '',
  createdAt: '2026-11-01T00:00:00.000Z',
  initialHead: 'a'.repeat(40),
  branchPreexisted: false,
  ...overrides,
});

const inspection = (path: string): ManagedWorktreeInspection => ({
  live: {
    head: 'b'.repeat(40),
    branch: path.split('/').pop(),
    detached: false,
    status: {
      staged: false,
      unstaged: true,
      untracked: false,
      ignored: false,
      conflicted: false,
      dirtySubmodule: false,
      truncated: false,
    },
    undetermined: [],
  },
  decision: { removable: false, path, branch: 'x', blockers: [] },
});

const session = (id: string, cwd: string, status: WorktreeSessionFact['status'] = 'running'): WorktreeSessionFact => ({
  id,
  cwd,
  status,
  ...(status === 'stopped' ? { finishedAt: '2026-11-02T00:00:00.000Z' } : {}),
});

interface Setup {
  rows?: readonly WorktreeListEntry[];
  records?: readonly ManagedWorktreeSummary[] | Error;
  sessions?: readonly WorktreeSessionFact[] | undefined | Error;
  examine?: (input: CheckManagedWorktreeRemovalInput) => Promise<ManagedWorktreeInspection>;
  nowMs?: () => number;
}

function listerOf(setup: Setup = {}) {
  const asked: string[] = [];
  const examined: CheckManagedWorktreeRemovalInput[] = [];
  const evidence: RepoWorktreeEvidence = {
    rows: async dir => {
      asked.push(dir);
      return setup.rows ?? [entry(MAIN), entry(FEATURE), entry(HAND_MADE)];
    },
    examine: async input => {
      examined.push(input);
      return await (setup.examine ?? (async next => inspection(next.managed.path)))(input);
    },
    records: async () => {
      if (setup.records instanceof Error) throw setup.records;
      return setup.records ?? [record(FEATURE)];
    },
    sessions: async () => {
      if (setup.sessions instanceof Error) throw setup.sessions;
      return 'sessions' in setup ? setup.sessions : [];
    },
    managedRoot: '/managed',
    clock: {
      nowMs: setup.nowMs ?? (() => 0),
      sleep: async (ms, signal) =>
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, ms === 15_000 ? 1 : ms);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    },
  };
  return { lister: new RepoWorktreeLister(evidence), asked, examined };
}

describe('RepoWorktreeLister', () => {
  it('should join a registry label by repository as well as path', async () => {
    const { lister } = listerOf({ records: [record(FEATURE, { commonDirectory: '/other/repository/.git' })] });
    const result = await lister.list(COMMON);
    should(result.worktrees[1]?.tracked).equal('none');
  });

  it('should preserve Git detached evidence when inspection cannot establish a checkout', async () => {
    const { lister } = listerOf({
      rows: [entry(MAIN, { branch: undefined, detached: true })],
      examine: async input => ({
        live: { detached: false, undetermined: ['checkout could not be inspected'] },
        decision: { removable: false, path: input.managed.path, branch: '', blockers: [] },
      }),
    });
    should((await lister.list(COMMON)).worktrees[0]?.live.detached).equal(true);
  });

  it('should merge the registry into Git rows: recorded is managed, everything else Git lists is none', async () => {
    // Arrange
    const { lister } = listerOf();

    // Act
    const actual = await lister.list(COMMON);

    // Assert
    should(actual.worktrees.map(row => [row.path, row.main, row.tracked])).eql([
      [MAIN, true, 'none'],
      [FEATURE, false, 'managed'],
      [HAND_MADE, false, 'none'],
    ]);
    should(actual).match({ commonDirectory: COMMON, total: 3, truncated: false });
  });

  it('should give every row the live state its inspection read', async () => {
    // Arrange
    const { lister, examined } = listerOf();

    // Act
    const actual = await lister.list(COMMON);

    // Assert
    should(actual.worktrees[1]?.live).match({ head: 'b'.repeat(40), status: { unstaged: true } });
    should(examined.map(input => input.managed.path)).eql([MAIN, FEATURE, HAND_MADE]);
  });

  it('should not call a record managed once it is removed or never finished', async () => {
    // Arrange
    const { lister } = listerOf({
      records: [
        record(FEATURE, { removedAt: '2026-11-03T00:00:00.000Z' }),
        record(HAND_MADE, { unresolved: 'declared and never finished' }),
      ],
    });

    // Act
    const actual = await lister.list(COMMON);

    // Assert
    should(actual.worktrees.map(row => row.tracked)).eql(['none', 'none', 'none']);
  });

  it('should keep Git facts and say why when one row cannot be inspected, and still inspect the rest', async () => {
    // Arrange
    const { lister } = listerOf({
      rows: [entry(MAIN), entry(HAND_MADE, { locked: 'review in progress' }), entry(FEATURE)],
      examine: async input => {
        if (input.managed.path === HAND_MADE) throw new Error('this daemon may not reach /tmp/hand-made');
        return inspection(input.managed.path);
      },
    });

    // Act
    const actual = await lister.list(COMMON);

    // Assert
    const unreadable = actual.worktrees[1]?.live;
    should(unreadable).match({ branch: 'hand-made', locked: 'review in progress', detached: false });
    should(unreadable?.status).be.undefined();
    should(unreadable?.undetermined.join(' ')).match(/could not be inspected: this daemon may not reach/u);
    should(actual.worktrees[2]?.live.status).not.be.undefined();
  });

  it('should answer undetermined for a row whose inspection never answers, instead of hanging', async () => {
    // Arrange
    const { lister } = listerOf({
      examine: async input =>
        input.managed.path === FEATURE ? await new Promise<never>(() => undefined) : inspection(input.managed.path),
    });

    // Act
    const actual = await lister.list(COMMON);

    // Assert
    should(actual.worktrees[1]?.live.undetermined.join(' ')).match(/did not answer within/u);
    should(actual.worktrees[2]?.live.status).not.be.undefined();
  });

  it('should stop starting inspections once the listing budget is spent and say so on the rest', async () => {
    // Arrange
    let calls = 0;
    const { lister, examined } = listerOf({
      nowMs: () => (calls++ === 0 ? 0 : REPO_LIST_BUDGET_MS + 1),
    });

    // Act
    const actual = await lister.list(COMMON);

    // Assert
    should(examined).have.length(0);
    should(actual.worktrees).have.length(3);
    should(actual.worktrees[0]?.live.undetermined.join(' ')).match(/time allowed for this list ran out/u);
  });

  it('should keep Git facts for a prunable row whose folder is gone', async () => {
    // Arrange
    const { lister } = listerOf({
      rows: [entry(MAIN), entry(HAND_MADE, { prunable: 'gitdir file points to non-existent location' })],
      examine: async input => ({
        live: { detached: false, undetermined: ['the checkout could not be inspected'] },
        decision: { removable: false, path: input.managed.path, branch: '', blockers: [] },
      }),
    });

    // Act
    const actual = await lister.list(COMMON);

    // Assert
    should(actual.worktrees[1]?.live).match({
      prunable: 'gitdir file points to non-existent location',
      head: 'a'.repeat(40),
      undetermined: ['the checkout could not be inspected'],
    });
  });

  it('should not inspect a bare repository, which has no files to read', async () => {
    // Arrange
    const { lister, examined } = listerOf({ rows: [entry('/srv/repo.git', { bare: true, head: undefined })] });

    // Act
    const actual = await lister.list('/srv/repo.git');

    // Assert
    should(examined).have.length(0);
    should(actual.worktrees[0]).match({ main: true, bare: true, tracked: 'none' });
  });

  it('should cap the rows at the limit and report how many Git listed', async () => {
    // Arrange
    const many = Array.from({ length: REPO_WORKTREE_LIMIT + 7 }, (_, index) => entry(`/w/${index}`));
    const { lister, examined } = listerOf({ rows: many, records: [] });

    // Act
    const actual = await lister.list(COMMON);

    // Assert
    should(actual.worktrees).have.length(REPO_WORKTREE_LIMIT);
    should(actual).match({ total: REPO_WORKTREE_LIMIT + 7, truncated: true });
    should(examined).have.length(REPO_WORKTREE_LIMIT);
  });

  it('should refuse a common directory that is not absolute before asking Git anything', async () => {
    // Arrange
    const { lister, asked } = listerOf();

    // Act
    const refusals = await Promise.all(
      ['', 'repo/.git', '.git', '/work/repo/.git\n', '/work/\u0000/.git'].map(
        async value => await lister.list(value).catch((error: unknown) => error),
      ),
    );

    // Assert
    for (const refusal of refusals)
      should(refusal).be.instanceOf(WorktreeError).and.match({ code: 'invalid_common_directory' });
    should(asked).be.empty();
  });

  it('should let the refusal Git gives for a non-repository through', async () => {
    // Arrange
    const evidence: RepoWorktreeEvidence = {
      rows: async () => {
        throw new WorktreeError('invalid_common_directory', 'not a common directory');
      },
      examine: async input => inspection(input.managed.path),
      records: async () => [],
      sessions: async () => [],
      managedRoot: '/managed',
      clock: {
        nowMs: () => 0,
        sleep: async (_ms, signal) =>
          await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true })),
      },
    };

    // Act
    const refusal = await new RepoWorktreeLister(evidence).list('/not/a/repo').catch((error: unknown) => error);

    // Assert
    should(refusal).match({ code: 'invalid_common_directory' });
  });

  it('should list the ferrets in a worktree, finished ones marked, and each ferret in the deepest row only', async () => {
    // Arrange
    const nested = `${MAIN}/.worktrees/inner`;
    const { lister } = listerOf({
      rows: [entry(MAIN), entry(nested)],
      records: [],
      sessions: [
        session('outer', MAIN),
        session('inner', `${nested}/src`),
        session('done', nested, 'stopped'),
        session('elsewhere', '/home/other'),
      ],
    });

    // Act
    const actual = await lister.list(COMMON);

    // Assert
    should(actual.worktrees[0]?.ferrets).eql([{ id: 'outer', active: true }]);
    should(actual.worktrees[1]?.ferrets).eql([
      { id: 'inner', active: true },
      { id: 'done', active: false },
    ]);
  });

  it('should leave the ferrets undetermined, not empty, when the fleet could not be read', async () => {
    // Arrange
    const { lister } = listerOf({ sessions: new Error('registry unreadable') });

    // Act
    const actual = await lister.list(COMMON);

    // Assert
    for (const row of actual.worktrees) should(row.ferrets).be.undefined();
  });

  it('should say the registry could not be read instead of calling everything untracked in silence', async () => {
    // Arrange
    const { lister } = listerOf({ records: new Error('registry damaged') });

    // Act
    const actual = await lister.list(COMMON);

    // Assert
    for (const row of actual.worktrees) {
      should(row.tracked).equal('none');
      should(row.live.undetermined.join(' ')).match(/registry could not be read/u);
    }
  });
});

describe('ferretsByRow', () => {
  it('should skip a bare row and a ferret standing in no row', () => {
    // Act
    const actual = ferretsByRow([entry('/srv/r.git', { bare: true })], [session('a', '/srv/r.git')]);

    // Assert
    should(actual.size).equal(0);
  });
});
