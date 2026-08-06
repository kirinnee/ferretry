import { afterAll, describe, it } from 'bun:test';
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import { BunGitRunner, GitCommandError } from '../../../../src/adapters/git/index.ts';
import { RunnerSessionGit } from '../../../../src/adapters/session/filesystem/index.ts';
import { MAX_DIFF_SIDE_BYTES } from '../../../../src/lib/session/filesystem/index.ts';
import type { GitInvocation, GitRunner } from '../../../../src/lib/worktrees/ports.ts';
import {
  cleanupTempDirectories,
  setupGit,
  stubGitDirectory,
  tempDirectory,
  tempRepository,
} from '../../support/repository.ts';

/**
 * The Git reads behind the working-tree viewer, against a real `git`.
 *
 * Two of the six gates are Git policy — is this path ignored, is it tracked — so a fake `git` here would
 * only prove that the parser matches the fixture somebody wrote. Every ignore verdict, every tracked
 * verdict and every rendered diff below comes from a throwaway repository built by the fixture helpers.
 */

const git = new RunnerSessionGit(new BunGitRunner());
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const NUL = String.fromCharCode(0);

/** A runner whose `git` is a script, for the failure paths a real Git will not produce on demand. */
const gitOnPath = async (script: string): Promise<RunnerSessionGit> => {
  const directory = await stubGitDirectory(script);
  return new RunnerSessionGit(new BunGitRunner(() => ({ PATH: directory })));
};

afterAll(async () => {
  await cleanupTempDirectories();
});

describe('RunnerSessionGit.repoInfo', () => {
  it('should report a worktree with its root, prefix and HEAD', async () => {
    // Arrange
    const { root } = await tempRepository('info');

    // Act
    const info = await git.repoInfo(root);

    // Assert
    should(info).eql({ repo: true, root, prefix: '', hasHead: true });
  });

  it('should report the prefix of a session started in a SUBDIRECTORY', async () => {
    // Arrange
    const { root } = await tempRepository('info-sub');
    await mkdir(path.join(root, 'packages', 'cli'), { recursive: true });

    // Act
    const info = await git.repoInfo(path.join(root, 'packages', 'cli'));

    // Assert
    should(info.prefix).eql('packages/cli/');
    should(info.root).eql(root);
  });

  it('should report a directory outside any repository rather than failing', async () => {
    // Arrange
    const plain = await tempDirectory('not-a-repo');

    // Act
    const info = await git.repoInfo(plain);

    // Assert
    should(info).eql({ repo: false, prefix: '', hasHead: false });
  });

  it('should report a repository with no commits as having no HEAD', async () => {
    // Arrange
    const fresh = await tempDirectory('fresh-repo');
    await setupGit(fresh, 'init', '-b', 'main', '--quiet');

    // Act
    const info = await git.repoInfo(fresh);

    // Assert
    should(info.repo).be.true();
    should(info.hasHead).be.false();
  });
});

describe('RunnerSessionGit.ignoredPaths', () => {
  const withIgnores = async (label: string, ignores: string): Promise<string> => {
    const { root } = await tempRepository(label);
    await writeFile(path.join(root, '.gitignore'), ignores);
    return root;
  };

  it('should report exactly the paths gitignore covers', async () => {
    // Arrange
    const root = await withIgnores('ignore', 'build/\nsecrets.yaml\n');
    await mkdir(path.join(root, 'build'), { recursive: true });

    // Act
    const ignored = await git.ignoredPaths(root, ['build', 'secrets.yaml', 'README.md']);

    // Assert
    should([...ignored].sort()).eql(['build', 'secrets.yaml']);
  });

  it('should report nothing when none of the paths is ignored', async () => {
    // Arrange
    const root = await withIgnores('ignore-none', 'build/\n');

    // Act
    const ignored = await git.ignoredPaths(root, ['README.md']);

    // Assert
    should(ignored.size).eql(0);
  });

  it('should treat the gate as vacuous outside a repository', async () => {
    // Arrange
    const plain = await tempDirectory('ignore-no-repo');

    // Act
    const ignored = await git.ignoredPaths(plain, ['anything']);

    // Assert
    should(ignored.size).eql(0);
  });

  it('should ask nothing of Git when there is nothing to ask about', async () => {
    // Arrange
    const plain = await tempDirectory('ignore-empty');

    // Act
    const ignored = await git.ignoredPaths(plain, ['', '']);

    // Assert
    should(ignored.size).eql(0);
  });

  it('should not let a filename that looks like pathspec magic abort the whole batch', async () => {
    // Arrange: `:(top)x` is a real, legal filename and also pathspec syntax.
    const root = await withIgnores('ignore-magic', 'build/\n');
    await mkdir(path.join(root, 'build'), { recursive: true });
    await writeFile(path.join(root, ':(top)x'), 'x\n');

    // Act
    const ignored = await git.ignoredPaths(root, [':(top)x', 'build']);

    // Assert
    should([...ignored]).eql(['build']);
  });

  it('should THROW when Git cannot tell, so the caller can fail closed', async () => {
    // Arrange: exit 2 is "we could not answer", which must never read as "not ignored".
    const stubbed = await gitOnPath(`#!/bin/sh
case "$*" in
  *rev-parse*--is-inside-work-tree*) printf 'true\\n/tmp/x\\n\\n'; exit 0 ;;
  *rev-parse*HEAD*) exit 0 ;;
  *check-ignore*) echo 'fatal: oops' >&2; exit 2 ;;
esac
exit 0
`);
    const plain = await tempDirectory('ignore-broken');

    // Act
    const failure = await stubbed.ignoredPaths(plain, ['a']).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(failure).be.instanceof(GitCommandError);
  });
});

describe('RunnerSessionGit.isTracked', () => {
  it('should confirm a committed file', async () => {
    // Arrange
    const { root } = await tempRepository('tracked');

    // Act / Assert
    should(await git.isTracked(root, 'README.md')).be.true();
  });

  it('should confirm a staged addition', async () => {
    // Arrange
    const { root } = await tempRepository('tracked-staged');
    await writeFile(path.join(root, 'added.ts'), 'export const a = 1;\n');
    await setupGit(root, 'add', 'added.ts');

    // Act / Assert
    should(await git.isTracked(root, 'added.ts')).be.true();
  });

  it('should refuse an untracked path', async () => {
    // Arrange
    const { root } = await tempRepository('tracked-no');
    await writeFile(path.join(root, 'scratch.ts'), 'x\n');

    // Act / Assert
    should(await git.isTracked(root, 'scratch.ts')).be.false();
  });

  it('should refuse a DIRECTORY pathspec, which the exit code alone would admit', async () => {
    // Arrange: `ls-files -- sub` matches every record beneath `sub`, so exit 0 is not the answer.
    const { root } = await tempRepository('tracked-dir');
    await mkdir(path.join(root, 'sub'), { recursive: true });
    await writeFile(path.join(root, 'sub', 'one.ts'), '1\n');
    await setupGit(root, 'add', 'sub/one.ts');

    // Act / Assert
    should(await git.isTracked(root, 'sub')).be.false();
  });
});

describe('RunnerSessionGit.changes', () => {
  it('should report nothing outside a repository', async () => {
    // Arrange
    const plain = await tempDirectory('changes-no-repo');

    // Act
    const view = await git.changes(plain);

    // Assert
    should(view).eql({ repo: false, changes: [] });
  });

  it('should report the branch, a modification, a staged add and an untracked file with line counts', async () => {
    // Arrange
    const { root } = await tempRepository('changes');
    await writeFile(path.join(root, 'README.md'), '# fixture\nchanged\n');
    await writeFile(path.join(root, 'added.ts'), 'export const a = 1;\n');
    await setupGit(root, 'add', 'added.ts');
    await writeFile(path.join(root, 'scratch.txt'), 'noise\n');

    // Act
    const view = await git.changes(root);
    const byPath = new Map(view.changes.map(change => [change.path, change]));

    // Assert
    should(view.repo).be.true();
    should(view.branch).eql('main');
    should(byPath.get('README.md')).match({ status: ' M', additions: 1, deletions: 0 });
    should(byPath.get('added.ts')).match({ status: 'A ', additions: 1, deletions: 0 });
    should(byPath.get('scratch.txt')?.status).eql('??');
    should(byPath.get('scratch.txt')?.additions).be.undefined();
  });

  it('should report a rename with its source, folding both halves onto one row', async () => {
    // Arrange
    const { root } = await tempRepository('changes-rename');
    await setupGit(root, 'mv', 'README.md', 'DOCS.md');

    // Act
    const view = await git.changes(root);

    // Assert
    should(view.changes).have.length(1);
    should(view.changes[0]).match({ path: 'DOCS.md', from: 'README.md' });
    should(view.changes[0]?.status).match(/R/);
  });

  it('should hide a session subdirectory from its own siblings', async () => {
    // Arrange
    const { root } = await tempRepository('changes-prefix');
    await mkdir(path.join(root, 'mine'), { recursive: true });
    await writeFile(path.join(root, 'mine', 'in.ts'), 'in\n');
    await writeFile(path.join(root, 'sibling.ts'), 'out\n');

    // Act
    const view = await git.changes(path.join(root, 'mine'));

    // Assert
    should(view.changes.map(change => change.path)).eql(['in.ts']);
  });

  it('should report a deletion in a repository with no commits at all', async () => {
    // Arrange: the stats pass has no HEAD to diff against and falls back to the empty tree.
    const fresh = await tempDirectory('changes-fresh');
    await setupGit(fresh, 'init', '-b', 'main', '--quiet');
    await writeFile(path.join(fresh, 'new.ts'), 'export const a = 1;\n');
    await setupGit(fresh, 'add', 'new.ts');

    // Act
    const view = await git.changes(fresh);

    // Assert
    should(view.branch).eql('main');
    should(view.changes[0]).match({ path: 'new.ts', additions: 1 });
  });

  it('should refuse when Git itself fails', async () => {
    // Arrange
    const stubbed = await gitOnPath(`#!/bin/sh
case "$*" in
  *rev-parse*--is-inside-work-tree*) printf 'true\\n/tmp/x\\n\\n'; exit 0 ;;
  *rev-parse*HEAD*) exit 0 ;;
  *status*) echo 'fatal: index broken' >&2; exit 128 ;;
esac
exit 0
`);
    const plain = await tempDirectory('changes-broken');

    // Act
    const failure = await stubbed.changes(plain).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(failure).be.instanceof(GitCommandError);
  });

  it('should degrade to a status list when the optional stats pass fails', async () => {
    // Arrange: counts are enrichment; losing them must not take a readable directory down.
    const stubbed = await gitOnPath(`#!/bin/sh
case "$*" in
  *rev-parse*--is-inside-work-tree*) printf 'true\\n/tmp/x\\n\\n'; exit 0 ;;
  *rev-parse*HEAD*) exit 0 ;;
  *status*) printf '## main\\0 M a.ts\\0'; exit 0 ;;
  *numstat*) echo 'fatal: no' >&2; exit 129 ;;
esac
exit 0
`);
    const plain = await tempDirectory('changes-nostats');

    // Act
    const view = await stubbed.changes(plain);

    // Assert
    should(view.changes).eql([{ path: 'a.ts', status: ' M' }]);
  });
});

describe('RunnerSessionGit HEAD reads', () => {
  it('should read a committed blob with its mode', async () => {
    // Arrange
    const { root } = await tempRepository('head-entry');

    // Act
    const entry = await git.headEntry(root, 'README.md', MAX_DIFF_SIDE_BYTES);

    // Assert
    should(entry?.mode).eql(0o100644);
    should(new TextDecoder().decode(entry?.bytes)).eql('# fixture\n');
    should(entry?.truncated).be.false();
  });

  it('should read the executable mode a commit recorded', async () => {
    // Arrange
    const { root } = await tempRepository('head-mode');
    const script = path.join(root, 'run.sh');
    await writeFile(script, '#!/bin/sh\n');
    await chmod(script, 0o755);
    await setupGit(root, 'add', 'run.sh');
    await setupGit(root, 'commit', '--quiet', '-m', 'feat: script');

    // Act
    const entry = await git.headEntry(root, 'run.sh', MAX_DIFF_SIDE_BYTES);

    // Assert
    should(entry?.mode).eql(0o100755);
  });

  it('should decline a DIRECTORY pathspec rather than reporting its first child', async () => {
    // Arrange
    const { root } = await tempRepository('head-dir');
    await mkdir(path.join(root, 'sub'), { recursive: true });
    await writeFile(path.join(root, 'sub', 'one.ts'), '1\n');
    await setupGit(root, 'add', 'sub/one.ts');
    await setupGit(root, 'commit', '--quiet', '-m', 'feat: sub');

    // Act / Assert
    should(await git.headEntry(root, 'sub', MAX_DIFF_SIDE_BYTES)).be.undefined();
  });

  it('should decline a path absent from HEAD', async () => {
    // Arrange
    const { root } = await tempRepository('head-absent');

    // Act / Assert
    should(await git.headEntry(root, 'never.ts', MAX_DIFF_SIDE_BYTES)).be.undefined();
  });

  it('should decline any HEAD read outside a repository or before the first commit', async () => {
    // Arrange
    const plain = await tempDirectory('head-no-repo');
    const fresh = await tempDirectory('head-fresh');
    await setupGit(fresh, 'init', '-b', 'main', '--quiet');

    // Act / Assert
    should(await git.headEntry(plain, 'a.ts', MAX_DIFF_SIDE_BYTES)).be.undefined();
    should(await git.readHeadBlob(fresh, 'a.ts', MAX_DIFF_SIDE_BYTES)).be.undefined();
    should(await git.readHeadBlob(plain, 'a.ts', MAX_DIFF_SIDE_BYTES)).be.undefined();
  });

  it('should read a committed blob by content address for the rendered "before" view', async () => {
    // Arrange
    const { root } = await tempRepository('blob');

    // Act
    const blob = await git.readHeadBlob(root, 'README.md', MAX_DIFF_SIDE_BYTES);

    // Assert
    should(blob?.size).eql(10);
    should(new TextDecoder().decode(blob?.bytes)).eql('# fixture\n');
  });

  it('should report an oversized committed blob by its size alone', async () => {
    // Arrange
    const { root } = await tempRepository('blob-big');

    // Act
    const blob = await git.readHeadBlob(root, 'README.md', 4);

    // Assert
    should(blob).eql({ size: 10 });
  });

  it('should decline a committed path that is not a blob', async () => {
    // Arrange
    const { root } = await tempRepository('blob-tree');
    await mkdir(path.join(root, 'sub'), { recursive: true });
    await writeFile(path.join(root, 'sub', 'one.ts'), '1\n');
    await setupGit(root, 'add', 'sub/one.ts');
    await setupGit(root, 'commit', '--quiet', '-m', 'feat: sub');

    // Act / Assert
    should(await git.readHeadBlob(root, 'sub', MAX_DIFF_SIDE_BYTES)).be.undefined();
  });

  it('should decline a path absent from HEAD without inventing a size', async () => {
    // Arrange
    const { root } = await tempRepository('blob-absent');

    // Act / Assert
    should(await git.readHeadBlob(root, 'never.ts', MAX_DIFF_SIDE_BYTES)).be.undefined();
  });
});

describe('RunnerSessionGit.diffSnapshots', () => {
  const render = async (
    label: string,
    oldText: string | undefined,
    newText: string | undefined,
    modes: { readonly old?: number; readonly new?: number } = {},
  ): Promise<string> => {
    const rendered = await git.diffSnapshots(
      `${label}.ts`,
      oldText === undefined ? undefined : { bytes: encode(oldText), mode: modes.old ?? 0o100644 },
      newText === undefined ? undefined : { bytes: encode(newText), mode: modes.new ?? 0o100644 },
    );
    return rendered.diff;
  };

  it('should render a modification with the requested path on both sides', async () => {
    // Act
    const diff = await render('mod', 'one\n', 'two\n');

    // Assert
    should(diff).match(/^diff --git a\/mod\.ts b\/mod\.ts$/m);
    should(diff).match(/^--- a\/mod\.ts$/m);
    should(diff).match(/^\+\+\+ b\/mod\.ts$/m);
    should(diff).match(/^-one$/m);
    should(diff).match(/^\+two$/m);
  });

  it('should render a deletion, whose header Git would otherwise label a/x a/x', async () => {
    // Act
    const diff = await render('del', 'gone\n', undefined);

    // Assert
    should(diff).match(/^diff --git a\/del\.ts b\/del\.ts$/m);
    should(diff).match(/^-gone$/m);
  });

  it('should render an addition', async () => {
    // Act
    const diff = await render('add', undefined, 'fresh\n');

    // Assert
    should(diff).match(/^diff --git a\/add\.ts b\/add\.ts$/m);
    should(diff).match(/^\+fresh$/m);
  });

  it('should render nothing when both sides are identical', async () => {
    // Act
    const diff = await render('same', 'same\n', 'same\n');

    // Assert
    should(diff).eql('');
  });

  it('should render nothing at all when neither side exists', async () => {
    // Act
    const rendered = await git.diffSnapshots('none.ts', undefined, undefined);

    // Assert
    should(rendered).eql({ diff: '', truncated: false });
  });

  it('should render a mode change on its own', async () => {
    // Act
    const diff = await render('chmod', 'body\n', 'body\n', { new: 0o100755 });

    // Assert
    should(diff).match(/old mode 100644/);
    should(diff).match(/new mode 100755/);
  });

  it('should render a symlink-to-file type change without ever following the link', async () => {
    // Arrange: the old side's bytes are the link TEXT, and it names a path that does not exist.
    const diff = await render('link', '/nowhere/at/all', 'real content\n', { old: 0o120000 });

    // Assert
    should(diff).match(/deleted file mode 120000/);
    should(diff).match(/new file mode 100644/);
  });

  it('should not let a file made of forged headers rewrite the real one', async () => {
    // Arrange: every body line carries a prefix, so only a column-zero `diff --git ` is a header.
    const forged = 'diff --git a/evil b/evil\n--- a/evil\n+++ b/evil\n';

    // Act
    const diff = await render('forged', forged, `${forged}tail\n`);

    // Assert
    should(diff.split('\n').filter(line => line.startsWith('diff --git '))).eql(['diff --git a/forged.ts b/forged.ts']);
    // Both sides carry the forged text, so it renders as a CONTEXT line — still at column one, still
    // untouched.
    should(diff).match(/^ diff --git a\/evil b\/evil$/m);
  });

  it('should render a path with spaces and non-ASCII characters', async () => {
    // Act
    const rendered = await git.diffSnapshots(
      'dir with space/naïve — file.ts',
      { bytes: encode('a\n'), mode: 0o100644 },
      { bytes: encode('b\n'), mode: 0o100644 },
    );

    // Assert
    should(rendered.diff).match(
      /^diff --git a\/dir with space\/naïve — file\.ts b\/dir with space\/naïve — file\.ts$/m,
    );
  });

  it('should render a NUL-bearing side as binary rather than as text', async () => {
    // Act
    const rendered = await git.diffSnapshots(
      'blob.bin',
      { bytes: new Uint8Array([1, 0, 2]), mode: 0o100644 },
      { bytes: new Uint8Array([1, 0, 3]), mode: 0o100644 },
    );

    // Assert
    should(rendered.diff).match(/Binary files/);
  });

  it('should leave nothing behind in the temp directory', async () => {
    // Arrange
    const before = await Array.fromAsync(new Bun.Glob('ferretry-diff-*').scan({ cwd: '/tmp', onlyFiles: false }));

    // Act
    await render('scratch', 'one\n', 'two\n');
    const after = await Array.fromAsync(new Bun.Glob('ferretry-diff-*').scan({ cwd: '/tmp', onlyFiles: false }));

    // Assert
    should(after).eql(before);
  });

  it('should refuse when Git cannot format the pair at all', async () => {
    // Arrange: `--no-index` exits 1 for "they differ", so only above that is a real failure.
    const stubbed = await gitOnPath(`#!/bin/sh
echo 'fatal: cannot diff' >&2
exit 129
`);

    // Act
    const failure = await stubbed.diffSnapshots('a.ts', { bytes: encode('a\n'), mode: 0o100644 }, undefined).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(failure).be.instanceof(GitCommandError);
  });

  it('should report the rendered diff as truncated when it exceeds the stdout cap', async () => {
    // Arrange: a wide change whose rendering is larger than the runner will keep.
    const wide = `${'x'.repeat(120)}\n`.repeat(20_000);

    // Act
    const rendered = await git.diffSnapshots(
      'wide.ts',
      { bytes: encode(''), mode: 0o100644 },
      { bytes: encode(wide), mode: 0o100644 },
    );

    // Assert
    should(rendered.truncated).be.true();
  });
});

describe('the hardened runner as this viewer needs it', () => {
  it('should keep porcelain paths repo-root-relative whatever the repository config says', async () => {
    // Arrange: a repo-local `status.relativePaths=true` would change the shape the parser filters by.
    const { root } = await tempRepository('relative-paths');
    await setupGit(root, 'config', 'status.relativePaths', 'true');
    await mkdir(path.join(root, 'sub'), { recursive: true });
    await writeFile(path.join(root, 'sub', 'in.ts'), 'in\n');

    // Act
    const view = await git.changes(path.join(root, 'sub'));

    // Assert
    should(view.changes.map(change => change.path)).eql(['in.ts']);
  });

  it('should list untracked files even when the repository asks Git to hide them', async () => {
    // Arrange
    const { root } = await tempRepository('show-untracked');
    await setupGit(root, 'config', 'status.showUntrackedFiles', 'no');
    await writeFile(path.join(root, 'scratch.txt'), 'noise\n');

    // Act
    const view = await git.changes(root);

    // Assert
    should(view.changes.map(change => change.path)).eql(['scratch.txt']);
  });

  it('should never detect a rename in a DIFF, which would print an out-of-cwd source path', async () => {
    // Arrange: with detection on, an in-cwd destination renders with the sibling's full content.
    const { root } = await tempRepository('no-renames');
    await mkdir(path.join(root, 'mine'), { recursive: true });
    const body = Array.from({ length: 40 }, (_unused, index) => `line ${index}\n`).join('');
    await writeFile(path.join(root, 'outside.ts'), body);
    await setupGit(root, 'add', 'outside.ts');
    await setupGit(root, 'commit', '--quiet', '-m', 'feat: outside');
    await rm(path.join(root, 'outside.ts'));
    await writeFile(path.join(root, 'mine', 'inside.ts'), body);
    await setupGit(root, 'add', '--all');

    // Act
    const view = await git.changes(path.join(root, 'mine'));

    // Assert: the destination is a plain addition, and the sibling source is not reported at all.
    should(view.changes.map(change => change.path)).eql(['inside.ts']);
    should(view.changes[0]?.from).be.undefined();
  });

  it('should ignore an inherited GIT_DIR that would redirect the read to another repository', async () => {
    // Arrange
    const { root } = await tempRepository('env-git-dir');
    const elsewhere = await tempRepository('env-elsewhere');
    const runner = new BunGitRunner(() => ({
      PATH: process.env.PATH,
      GIT_DIR: path.join(elsewhere.root, '.git'),
      GIT_WORK_TREE: elsewhere.root,
    }));

    // Act
    const info = await new RunnerSessionGit(runner).repoInfo(root);

    // Assert
    should(info.root).eql(root);
  });

  it('should not follow a symlinked pathspec when asking whether a path is tracked', async () => {
    // Arrange: `link -> README.md` is not itself tracked, however innocent its target.
    const { root } = await tempRepository('tracked-link');
    await symlink(path.join(root, 'README.md'), path.join(root, 'link'));

    // Act / Assert
    should(await git.isTracked(root, 'link')).be.false();
  });

  it('should read a path whose name is NUL-free but adversarially punctuated', async () => {
    // Arrange
    const { root } = await tempRepository('odd-name');
    const name = 'we"ird\tname.ts';
    await writeFile(path.join(root, name), 'body\n');
    await setupGit(root, 'add', '--', name);
    await setupGit(root, 'commit', '--quiet', '-m', 'feat: odd');

    // Act
    const tracked = await git.isTracked(root, name);
    const entry = await git.headEntry(root, name, MAX_DIFF_SIDE_BYTES);

    // Assert
    should(tracked).be.true();
    should(new TextDecoder().decode(entry?.bytes)).eql('body\n');
    should(name.includes(NUL)).be.false();
  });
});

describe('RunnerSessionGit.listFiles', () => {
  it('should list tracked and untracked files while Git itself removes the ignored ones', async () => {
    // The gitignore rule is applied by the tool that defines it. Reimplementing that matching to build
    // a search index is how a build directory full of credentials ends up in one.
    // Arrange
    const { root } = await tempRepository('list-files');
    await writeFile(path.join(root, '.gitignore'), 'dist/\n*.log\n');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'dist'), { recursive: true });
    await writeFile(path.join(root, 'src', 'app.ts'), 'export const x = 1;\n');
    await writeFile(path.join(root, 'src', 'untracked.ts'), 'export const y = 2;\n');
    await writeFile(path.join(root, 'dist', 'bundle.js'), 'built\n');
    await writeFile(path.join(root, 'debug.log'), 'noisy\n');
    await setupGit(root, 'add', 'src/app.ts');

    // Act
    const listed = await git.listFiles(root, MAX_DIFF_SIDE_BYTES);

    // Assert
    should([...listed.paths].sort()).eql(['.gitignore', 'README.md', 'src/app.ts', 'src/untracked.ts']);
    should(listed.truncated).be.false();
  });

  it('should never name a path inside .git or an ignored node_modules', async () => {
    // The two directories the whole crawl used to die on.
    // Arrange
    const { root } = await tempRepository('list-files-denied');
    await writeFile(path.join(root, '.gitignore'), 'node_modules/\n');
    await mkdir(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');

    // Act
    const listed = await git.listFiles(root, MAX_DIFF_SIDE_BYTES);

    // Assert
    should(listed.paths.some(entry => entry.startsWith('.git/'))).be.false();
    should(listed.paths.some(entry => entry.startsWith('node_modules/'))).be.false();
    should(listed.paths).containEql('README.md');
  });

  it('should still name an UNIGNORED node_modules, so the daemon denylist is what refuses it', async () => {
    // Git has no opinion about `node_modules`; the unconditional denylist does. Proving Git reports it
    // is what proves the two gates are separate, rather than one accidentally covering for the other.
    // Arrange
    const { root } = await tempRepository('list-files-unignored');
    await mkdir(path.join(root, 'node_modules'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'thing.js'), 'x\n');

    // Act
    const listed = await git.listFiles(root, MAX_DIFF_SIDE_BYTES);

    // Assert
    should(listed.paths).containEql('node_modules/thing.js');
  });

  it('should bound itself to a session started in a SUBDIRECTORY, never listing its siblings', async () => {
    // Arrange
    const { root } = await tempRepository('list-files-sub');
    await mkdir(path.join(root, 'packages', 'cli'), { recursive: true });
    await mkdir(path.join(root, 'packages', 'daemon'), { recursive: true });
    await writeFile(path.join(root, 'packages', 'cli', 'mine.ts'), 'x\n');
    await writeFile(path.join(root, 'packages', 'daemon', 'theirs.ts'), 'y\n');

    // Act
    const listed = await git.listFiles(path.join(root, 'packages', 'cli'), MAX_DIFF_SIDE_BYTES);

    // Assert
    should(listed.paths).eql(['mine.ts']);
  });

  it('should report a path holding a newline as one path rather than as two', async () => {
    // Arrange
    const { root } = await tempRepository('list-files-newline');
    await writeFile(path.join(root, 'we\nird.ts'), 'x\n');

    // Act
    const listed = await git.listFiles(root, MAX_DIFF_SIDE_BYTES);

    // Assert
    should(listed.paths).containEql('we\nird.ts');
    should(listed.paths).have.length(2);
  });

  it('should say when its own output was capped rather than presenting a short list as whole', async () => {
    // Arrange
    const { root } = await tempRepository('list-files-capped');
    for (let index = 0; index < 40; index += 1) {
      await writeFile(path.join(root, `file-${index}-with-a-long-enough-name.ts`), 'x\n');
    }

    // Act
    const listed = await git.listFiles(root, 64);

    // Assert
    should(listed.truncated).be.true();
    should(listed.paths.length).be.below(41);
  });

  it('should refuse rather than answer when Git could not be run at all', async () => {
    // The domain turns this throw into an index that reports itself incomplete; answering "no files"
    // here would make a broken interrogation indistinguishable from an empty tree.
    // Arrange
    const broken = await gitOnPath('#!/bin/sh\nexit 3\n');
    const plain = await tempDirectory('list-files-broken');

    // Act
    const failure = await broken.listFiles(plain, MAX_DIFF_SIDE_BYTES).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(failure).be.instanceof(GitCommandError);
  });

  it('should turn a runner timeout into an explicit failure even when the child reported exit zero', async () => {
    // The domain catches this named failure and reports a partial/unreadable index. Treating exit zero as
    // success would turn a killed process's short output into a confidently complete search result.
    // Arrange
    const invocations: GitInvocation[] = [];
    const runner: GitRunner = {
      run: invocation => {
        invocations.push(invocation);
        return Promise.resolve({
          exitCode: 0,
          stdout: encode('partial.ts\0'),
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: true,
        });
      },
    };
    const subject = new RunnerSessionGit(runner);

    // Act
    const failure = await subject.listFiles('/pinned/session', 128).catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceof(GitCommandError);
    should((failure as GitCommandError).execution.timedOut).be.true();
    should((failure as Error).message).match(/timed out/u);
    should(invocations).have.length(1);
    should(invocations[0]?.args).eql(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    should(invocations[0]?.maxStdoutBytes).eql(128);
  });
});
