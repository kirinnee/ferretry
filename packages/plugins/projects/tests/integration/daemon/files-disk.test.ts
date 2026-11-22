/**
 * The project file index over the kernel's REAL `imports` root, real `git` and a temp disk (never a real home): a fake user
 * home holding a project. Linux only for the held-folder reach, as `folders-disk.test.ts`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_PROJECT_INDEX_LIMITS, ProjectFolderRefused } from '../../../daemon/features/files/build.ts';
import { ProjectIndexSummarySchema } from '../../../contract/index.ts';
import { cleanUp, git, put, world } from './files-support.ts';

afterEach(cleanUp);

const paths = (files: readonly { readonly path: string }[]): string[] => files.map(file => file.path);
const skip = (summary: { readonly skipped: readonly { reason: string; count: number }[] }, reason: string) =>
  summary.skipped.find(row => row.reason === reason)?.count ?? 0;

describe('a project that is a Git repository', () => {
  test('takes Git’s whole list at any depth: nested .gitignore, info/exclude and the owner’s global ignore all apply', async () => {
    const w = await world();
    await put(w.user, { '.config/git/ignore': 'global-ignored.txt\n' });
    git(w.project, w.user, 'init', '-q');
    await put(w.project, {
      '.gitignore': 'root-ignored.txt\n',
      'README.md': '# x',
      'root-ignored.txt': '',
      'global-ignored.txt': '',
      'excluded-by-info.txt': '',
      'sub/.gitignore': 'inner-ignored.txt\n',
      'sub/inner-ignored.txt': '',
      'sub/kept.ts': '',
      '.prettierrc': '{}',
      // six folders deep: a depth-5 cut would drop it, and Git's list does not.
      'a/b/c/d/e/f/deep.ts': '',
    });
    await put(w.project, { '.git/info/exclude': 'excluded-by-info.txt\n' });

    const index = await w.build();

    expect(paths(index.files)).toEqual([
      '.gitignore',
      '.prettierrc',
      'README.md',
      'sub/.gitignore',
      'sub/kept.ts',
      'a/b/c/d/e/f/deep.ts',
    ]);
    expect(index.summary.coverage).toBe('complete');
    expect(ProjectIndexSummarySchema.safeParse(index.summary).success).toBe(true);
  });

  test('drops secret-looking names and noisy build roots, counted; a tracked file deleted from disk is not listed', async () => {
    const w = await world();
    git(w.project, w.user, 'init', '-q');
    await put(w.project, {
      'a.ts': '',
      '.env': 'TOKEN=x',
      'deploy/prod.pem': 'key',
      'server.key': 'key',
      'dist/out.js': '',
      'gone.ts': '',
    });
    git(w.project, w.user, 'add', '-A');
    await rm(join(w.project, 'gone.ts'));

    const index = await w.build();

    expect(paths(index.files)).toEqual(['a.ts']);
    expect(skip(index.summary, 'denied')).toBe(3);
    expect(skip(index.summary, 'excluded')).toBe(1);
    expect(skip(index.summary, 'unsupported')).toBe(1);
    expect(JSON.stringify(index)).not.toContain('TOKEN');
  });

  test('indexes a nested repository with its own ignore rules, and names a linked worktree without entering it', async () => {
    const w = await world();
    git(w.project, w.user, 'init', '-q', '-b', 'main');
    await put(w.project, { 'top.ts': '' });
    git(w.project, w.user, 'add', '-A');
    git(w.project, w.user, 'commit', '-q', '-m', 'one');
    // an untracked nested repository with its own .gitignore and a secret name
    await mkdir(join(w.project, 'libs', 'inner'), { recursive: true });
    git(join(w.project, 'libs', 'inner'), w.user, 'init', '-q');
    await put(join(w.project, 'libs', 'inner'), {
      '.gitignore': 'private-notes.txt\n',
      'src/lib.ts': '',
      'private-notes.txt': '',
      '.env': 'S=1',
    });
    // a linked worktree of the project itself: one more copy of every file, not entered
    git(w.project, w.user, 'worktree', 'add', '-q', '.worktrees/feature', '-b', 'feature');

    const index = await w.build();

    expect(paths(index.files)).toEqual(['top.ts', 'libs/inner/.gitignore', 'libs/inner/src/lib.ts']);
    expect(index.summary.nestedWorktrees).toEqual(['.worktrees/feature']);
    expect(skip(index.summary, 'excluded')).toBeGreaterThanOrEqual(1);
    expect(skip(index.summary, 'denied')).toBe(1);
    expect(paths(index.files).some(path => path.includes('private-notes') || path.includes('.worktrees'))).toBe(false);
  });

  test('does not fall back to a raw walk when Git cannot answer: the list is empty and partial, with a reason', async () => {
    const w = await world(undefined, {
      git: {
        isInsideWorkTree: async () => true,
        listFiles: async () => {
          throw new Error('git ls-files failed: dubious ownership');
        },
      },
    });
    await put(w.project, { 'ignored-by-git-but-on-disk.txt': '', '.gitignore': 'ignored-by-git-but-on-disk.txt\n' });

    const index = await w.build();

    expect(index.files).toEqual([]);
    expect(index.summary.coverage).toBe('partial');
    expect(skip(index.summary, 'unreadable')).toBe(1);
  });

  test('a repository Git will not even name is a partial, empty answer — never walked', async () => {
    const w = await world(undefined, {
      git: {
        isInsideWorkTree: async () => {
          throw new Error('git rev-parse failed: dubious ownership');
        },
        listFiles: async () => ({ paths: [], truncated: false }),
      },
    });
    await put(w.project, { 'a.ts': '' });

    const index = await w.build();

    expect(index.files).toEqual([]);
    expect(index.summary.coverage).toBe('partial');
  });
});

describe('a project that is not a repository', () => {
  test('walks five folders deep, indexes whole every repository it finds, and skips hidden, noisy and secret names', async () => {
    const w = await world();
    await put(w.project, {
      'notes.txt': '',
      'docs/guide.md': '',
      '.hidden/secret-place.md': '',
      'node_modules/dep/index.js': '',
      '.env': 'S=1',
      'keys/server.pem': '',
      // five folders deep is opened; six is not
      'a/b/c/d/e/five.txt': '',
      'a/b/c/d/e/f/six.txt': '',
    });
    // a repository inside, with a file far below it and an ignored one
    await put(w.project, { 'app/.gitignore': 'out.log\n', 'app/src/x/y/z/w/v/u/deep.ts': '', 'app/out.log': '' });
    git(join(w.project, 'app'), w.user, 'init', '-q');

    const index = await w.build();

    expect(paths(index.files)).toEqual([
      'notes.txt',
      'app/.gitignore',
      'docs/guide.md',
      'a/b/c/d/e/five.txt',
      'app/src/x/y/z/w/v/u/deep.ts',
    ]);
    expect(skip(index.summary, 'denied')).toBe(2);
    // hidden folder, node_modules, and the folder past depth five
    expect(skip(index.summary, 'excluded')).toBe(3);
    expect(index.summary.coverage).toBe('complete');
  });

  test('never follows a link, never names one, and a `.git` file (a linked worktree) is named and not entered', async () => {
    const w = await world();
    await put(w.parent, { 'outside/stolen.txt': '' });
    await put(w.user, { '.ssh/config': '' });
    await put(w.project, { 'ok.txt': '', 'wt/file.txt': '' });
    await symlink(join(w.parent, 'outside'), join(w.project, 'linked-out'));
    await symlink(join(w.user, '.ssh'), join(w.project, 'to-ssh'));
    await writeFile(join(w.project, 'wt', '.git'), 'gitdir: /elsewhere');

    const index = await w.build();

    expect(paths(index.files)).toEqual(['ok.txt']);
    expect(index.summary.nestedWorktrees).toEqual(['wt']);
    expect(skip(index.summary, 'unsupported')).toBe(2);
    expect(JSON.stringify(index)).not.toContain('stolen');
  });
});

describe('the bounds', () => {
  test('keep shallow files first at the file cap, count what was cut, and name where the files are', async () => {
    const w = await world({ ...DEFAULT_PROJECT_INDEX_LIMITS, maxFiles: 4 });
    git(w.project, w.user, 'init', '-q');
    await put(w.project, {
      'README.md': '',
      'a.ts': '',
      'big/one/two/x.ts': '',
      'big/y.ts': '',
      'big/z.ts': '',
      'small/q.ts': '',
    });

    const index = await w.build();

    expect(paths(index.files)).toEqual(['README.md', 'a.ts', 'big/y.ts', 'big/z.ts']);
    expect(index.summary.coverage).toBe('partial');
    expect(skip(index.summary, 'truncated')).toBe(2);
    expect(index.summary.biggestFolders).toEqual([{ folder: 'big', files: 2 }]);
    expect(index.summary.indexed).toBe(4);
  });

  test('a spent time budget answers an empty partial index and names the bound, without walking', async () => {
    const w = await world({ ...DEFAULT_PROJECT_INDEX_LIMITS, budgetMs: 0 });
    await put(w.project, { 'a.txt': '', 'b/c.txt': '' });

    const index = await w.build();

    expect(index.files).toEqual([]);
    expect(index.summary.coverage).toBe('partial');
    expect(skip(index.summary, 'truncated')).toBeGreaterThanOrEqual(1);
  });

  test('stop opening folders at the folder cap and say so', async () => {
    const w = await world({ ...DEFAULT_PROJECT_INDEX_LIMITS, maxFolders: 2 });
    await put(w.project, { 'a/1.txt': '', 'b/2.txt': '', 'c/3.txt': '' });

    const index = await w.build();

    expect(index.summary.coverage).toBe('partial');
    expect(skip(index.summary, 'truncated')).toBeGreaterThanOrEqual(1);
    expect(index.files.length).toBeLessThan(3);
  });
});

describe('the project folder itself', () => {
  test('is refused when it is private, holds a sign-in file, is a link, or is not there', async () => {
    const w = await world();
    await put(w.user, { '.ssh/config': '', 'vault/auth.json': '{}', 'vault/notes.txt': '' });
    await symlink(w.project, join(w.user, 'alias'));
    const refusals = async (path: string) => {
      try {
        await w.build(path);
      } catch (error) {
        return error instanceof ProjectFolderRefused ? error.reason : 'other';
      }
      return 'built';
    };

    expect(await refusals(join(w.user, '.ssh'))).toBe('private');
    expect(await refusals(join(w.user, 'vault'))).toBe('private');
    expect(await refusals(join(w.user, 'alias'))).toBe('unavailable');
    expect(await refusals(join(w.user, 'missing'))).toBe('unavailable');
    expect(await refusals(w.project)).toBe('built');
  });
});
