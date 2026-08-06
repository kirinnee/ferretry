import { describe, it } from 'bun:test';
import should from 'should';
import { FsError, SessionFilesystem } from '../../../../src/lib/session/filesystem/index.ts';
import {
  directory,
  FAKE_POLICY_CWD,
  FAKE_ROOT,
  type FakeRootOptions,
  FakeRootPinner,
  FakeSessionGit,
  type SessionGitScript,
  textFile,
  treeOf,
} from './support.ts';

/**
 * The whole-session file index.
 *
 * The property under test throughout is the INVERSION that made this exist: a subtree the daemon refuses,
 * cannot read, or ran out of budget for must become a counted row and must NOT become the answer. Before
 * it, a client walked the tree itself and met a 403 in the first listing of any Git checkout — `.git` is
 * refused by name — and reported the whole session as having no files. Every case below is a shape that
 * used to erase the entire result set.
 */

const CWD = '/home/kirin/session';

const viewer = (root: FakeRootOptions = {}, git: SessionGitScript = {}) => {
  const pinner = new FakeRootPinner(root);
  const sessionGit = new FakeSessionGit(git);
  return { filesystem: new SessionFilesystem(pinner, sessionGit), pinner, git: sessionGit };
};

const NOT_A_REPO = { repo: false as const, prefix: '', hasHead: false };

const countFor = (skipped: readonly { reason: string; count: number }[], reason: string): number | undefined =>
  skipped.find(skip => skip.reason === reason)?.count;

const gitTree = (...paths: readonly string[]) =>
  treeOf(...paths.map(path => [path, textFile('not read by the index')] as const));

const EXPECTED_INDEX_EXCLUSIONS = [
  '.cache',
  '.git',
  '.gradle',
  '.hg',
  '.next',
  '.svn',
  '.terraform',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'generated',
  'node_modules',
  'out',
  'target',
  'vendor',
  'venv',
] as const;

describe('the session file index inside a Git worktree', () => {
  it('should ask Git once for the whole tree rather than once per directory', async () => {
    // Arrange
    const { filesystem, git } = viewer(
      { tree: gitTree('README.md', 'src/app.ts', 'src/deep/nested/leaf.ts') },
      { listFiles: () => ({ paths: ['README.md', 'src/app.ts', 'src/deep/nested/leaf.ts'], truncated: false }) },
    );

    // Act
    const index = await filesystem.index(CWD);

    // Assert
    should(git.listCalls).have.length(1);
    should(git.listCalls[0]?.cwd).eql(FAKE_POLICY_CWD);
    should(index.files.map(file => file.path)).eql(['README.md', 'src/app.ts', 'src/deep/nested/leaf.ts']);
    should(index.files.map(file => file.name)).eql(['README.md', 'app.ts', 'leaf.ts']);
    should(index.root).eql(FAKE_ROOT);
    should(index.coverage).eql('complete');
    should(index.skipped).eql([]);
  });

  it('should count a denied path instead of letting it erase the index', async () => {
    // Arrange: exactly what killed the client crawl — a checkout whose listing contains `.git`.
    const { filesystem } = viewer(
      { tree: gitTree('README.md') },
      {
        listFiles: () => ({
          paths: ['README.md', '.git/config', 'node_modules/left-pad/index.js', 'deploy/prod.pem'],
          truncated: false,
        }),
      },
    );

    // Act
    const index = await filesystem.index(CWD);

    // Assert
    should(index.files.map(file => file.path)).eql(['README.md']);
    should(index.skipped).eql([
      { reason: 'denied', count: 1 },
      { reason: 'excluded', count: 2 },
    ]);
    should(index.coverage).eql('complete');
  });

  it('should report a repository it could not interrogate as partial rather than as empty', async () => {
    // Arrange
    const { filesystem } = viewer(
      { tree: gitTree('a.ts', 'b.ts') },
      {
        listFiles: () => {
          throw new Error('git ls-files timed out');
        },
      },
    );

    // Act
    const index = await filesystem.index(CWD);

    // Assert
    should(index.files).eql([]);
    should(index.coverage).eql('partial');
    should(index.skipped).eql([{ reason: 'unreadable', count: 1 }]);
  });

  it('should never fall back to walking a worktree whose Git could not be reached', async () => {
    // Arrange: falling back would enumerate exactly the directories the ignore gate closes.
    const { filesystem, pinner } = viewer(
      { tree: treeOf(['', directory([{ name: 'secret.txt', type: 'file' }])]) },
      {
        repoInfo: () => {
          throw new FsError('unsupported', 'git is unavailable');
        },
      },
    );

    // Act
    const failure = await filesystem.index(CWD).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(failure).be.instanceof(FsError);
    should(pinner.lastRoot.opens).eql([]);
    should(pinner.lastRoot.closed).be.true();
  });

  it('should downgrade coverage when Git output hit its byte cap', async () => {
    // Arrange
    const { filesystem } = viewer(
      { tree: gitTree('a.ts', 'b.ts', 'c.ts', 'd.ts') },
      { listFiles: () => ({ paths: ['a.ts', 'b.ts'], truncated: true }) },
    );

    // Act
    const index = await filesystem.index(CWD);

    // Assert
    should(index.files).have.length(2);
    should(index.coverage).eql('partial');
    should(countFor(index.skipped, 'truncated')).eql(1);
  });

  it('should stop at the file bound and say by how much, rather than returning a short list silently', async () => {
    // Arrange
    const { filesystem } = viewer(
      { tree: gitTree('a.ts', 'b.ts', 'c.ts', 'd.ts') },
      { listFiles: () => ({ paths: ['d.ts', 'b.ts', 'c.ts', 'a.ts'], truncated: false }) },
    );

    // Act
    const index = await filesystem.index(CWD, { maxFiles: 2 });

    // Assert
    should(index.files.map(file => file.path)).eql(['a.ts', 'b.ts']);
    should(index.coverage).eql('partial');
    should(countFor(index.skipped, 'truncated')).eql(2);
  });

  it('should drop a path no read route would accept and count it as unsupported', async () => {
    // Arrange: a backslash is a legal POSIX filename character the syntactic gate refuses.
    const { filesystem } = viewer(
      { tree: gitTree('ok.ts', 'trailing') },
      { listFiles: () => ({ paths: ['ok.ts', 'weird\\name.ts', 'trailing/'], truncated: false }) },
    );

    // Act
    const index = await filesystem.index(CWD);

    // Assert
    should(index.files.map(file => file.path)).eql(['ok.ts', 'trailing']);
    should(index.skipped).eql([{ reason: 'unsupported', count: 1 }]);
  });

  it('should bound the byte cap it hands Git rather than accepting whatever fits', async () => {
    // Arrange
    const { filesystem, git } = viewer({ tree: treeOf() }, { listFiles: () => ({ paths: [], truncated: false }) });

    // Act
    await filesystem.index(CWD);

    // Assert
    should(git.listCalls[0]?.maxBytes).be.above(0);
  });

  it('should advertise only current regular files proven by the pinned root', async () => {
    // Arrange: cached Git names may be deleted, symlinks, directories/submodules, or raced elsewhere.
    const { filesystem, pinner } = viewer(
      {
        tree: treeOf(
          ['kept.ts', textFile('kept')],
          ['link.ts', { error: new FsError('not_a_file', 'symlink') }],
          ['submodule', directory([])],
          ['socket', { type: 'other' }],
          ['moved.ts', textFile('moved', { canonical: 'elsewhere.ts' })],
        ),
      },
      {
        listFiles: () => ({
          paths: ['submodule', 'deleted.ts', 'kept.ts', 'link.ts', 'socket', 'moved.ts'],
          truncated: false,
        }),
      },
    );

    // Act
    const index = await filesystem.index(CWD);

    // Assert
    should(index.files.map(file => file.path)).eql(['kept.ts']);
    should(index.skipped).eql([{ reason: 'unsupported', count: 5 }]);
    should(pinner.lastRoot.targets.every(target => target.closed)).be.true();
    should(pinner.lastRoot.closed).be.true();
  });

  it('should preserve valid rows but admit partial coverage when one candidate cannot be opened', async () => {
    // Arrange
    const { filesystem } = viewer(
      {
        tree: treeOf(['good.ts', textFile('good')], ['unreadable.ts', { error: new Error('EIO') }]),
      },
      { listFiles: () => ({ paths: ['unreadable.ts', 'good.ts'], truncated: false }) },
    );

    // Act
    const index = await filesystem.index(CWD);

    // Assert
    should(index.files.map(file => file.path)).eql(['good.ts']);
    should(index.coverage).eql('partial');
    should(index.skipped).eql([{ reason: 'unreadable', count: 1 }]);
  });

  it('should apply the exact metadata, dependency, generated, vendor, build and cache exclusions', async () => {
    // Arrange
    const excluded = EXPECTED_INDEX_EXCLUSIONS.map(directoryName => `${directoryName}/hidden.ts`);
    const { filesystem } = viewer(
      { tree: gitTree('src/kept.ts') },
      { listFiles: () => ({ paths: [...excluded, 'src/kept.ts'], truncated: false }) },
    );

    // Act
    const index = await filesystem.index(CWD);

    // Assert
    should(index.files.map(file => file.path)).eql(['src/kept.ts']);
    should(index.skipped).eql([{ reason: 'excluded', count: EXPECTED_INDEX_EXCLUSIONS.length }]);
  });

  it('should sort before applying the candidate bound', async () => {
    // Arrange
    const { filesystem } = viewer(
      { tree: gitTree('a.ts', 'b.ts', 'z.ts') },
      { listFiles: () => ({ paths: ['z.ts', 'b.ts', 'a.ts'], truncated: false }) },
    );

    // Act
    const index = await filesystem.index(CWD, { maxCandidates: 2 });

    // Assert
    should(index.files.map(file => file.path)).eql(['a.ts', 'b.ts']);
    should(index.coverage).eql('partial');
    should(countFor(index.skipped, 'truncated')).eql(1);
  });

  it('should index huge and binary files by metadata without reading their content', async () => {
    // Arrange
    const { filesystem, pinner } = viewer(
      {
        tree: treeOf(
          ['huge.iso', textFile('', { size: Number.MAX_SAFE_INTEGER })],
          ['binary.dat', { type: 'file', bytes: new Uint8Array([0, 1, 2]) }],
        ),
      },
      { listFiles: () => ({ paths: ['huge.iso', 'binary.dat'], truncated: false }) },
    );

    // Act
    const index = await filesystem.index(CWD);

    // Assert
    should(index.files.map(file => file.path)).eql(['binary.dat', 'huge.iso']);
    should(pinner.lastRoot.targets.every(target => target.readCalls.length === 0)).be.true();
    should(pinner.lastRoot.targets.every(target => target.closed)).be.true();
  });

  it('should reject invalid bounds before pinning or asking Git', async () => {
    // Arrange
    const { filesystem, pinner, git } = viewer({ tree: treeOf() });

    // Act
    const failures = await Promise.all([
      filesystem.index(CWD, { maxFiles: -1 }).catch((error: unknown) => error),
      filesystem.index(CWD, { maxCandidates: 1.5 }).catch((error: unknown) => error),
      filesystem.index(CWD, { maxDirectories: Number.NaN }).catch((error: unknown) => error),
      filesystem.index(CWD, { maxFiles: 20_001 }).catch((error: unknown) => error),
    ]);

    // Assert
    should(failures.every(error => error instanceof RangeError)).be.true();
    should(pinner.roots).eql([]);
    should(git.cwds).eql([]);
  });
});

describe('the session file index outside a Git worktree', () => {
  const walked = (root: FakeRootOptions) => viewer(root, { repoInfo: () => NOT_A_REPO });

  it('should walk every directory beneath the pinned root', async () => {
    // Arrange
    const { filesystem, git } = walked({
      tree: treeOf(
        [
          '',
          directory([
            { name: 'src', type: 'dir' },
            { name: 'README.md', type: 'file' },
          ]),
        ],
        ['src', directory([{ name: 'app.ts', type: 'file' }])],
        ['src/app.ts', textFile('x')],
      ),
    });

    // Act
    const index = await filesystem.index(CWD);

    // Assert
    should(index.files.map(file => file.path)).eql(['README.md', 'src/app.ts']);
    should(index.coverage).eql('complete');
    // A tree with no repository is never asked a single ignore question.
    should(git.listCalls).eql([]);
    should(git.ignoreCalls).eql([]);
  });

  it('should isolate one unreadable directory instead of collapsing the whole index', async () => {
    // Arrange
    const { filesystem } = walked({
      tree: treeOf(
        [
          '',
          directory([
            { name: 'open', type: 'dir' },
            { name: 'closed', type: 'dir' },
            { name: 'top.md', type: 'file' },
          ]),
        ],
        ['open', directory([{ name: 'kept.ts', type: 'file' }])],
        ['closed', { type: 'dir', entries: [], error: new FsError('denied', 'EACCES') }],
      ),
    });

    // Act
    const index = await filesystem.index(CWD);

    // Assert
    should(index.files.map(file => file.path)).eql(['open/kept.ts', 'top.md']);
    should(index.coverage).eql('partial');
    should(countFor(index.skipped, 'unreadable')).eql(1);
  });

  it('should never enqueue a denied directory, at any depth', async () => {
    // Arrange
    const { filesystem, pinner } = walked({
      tree: treeOf(
        [
          '',
          directory([
            { name: '.git', type: 'dir' },
            { name: 'node_modules', type: 'dir' },
            { name: 'src', type: 'dir' },
          ]),
        ],
        ['src', directory([{ name: 'node_modules', type: 'dir' }])],
      ),
    });

    // Act
    const index = await filesystem.index(CWD);

    // Assert
    should(pinner.lastRoot.opens).eql(['', 'src']);
    should(index.files).eql([]);
    should(index.skipped).eql([{ reason: 'excluded', count: 3 }]);
    should(index.coverage).eql('complete');
  });

  it('should refuse to index a symlink or an escaping entry, because neither can ever be served', async () => {
    // Arrange
    const { filesystem } = walked({
      tree: treeOf([
        '',
        directory([
          { name: 'link.ts', type: 'symlink' },
          { name: 'outside', type: 'dir', escapes: true },
          { name: 'real.ts', type: 'file' },
        ]),
      ]),
    });

    // Act
    const index = await filesystem.index(CWD);

    // Assert
    should(index.files.map(file => file.path)).eql(['real.ts']);
    should(index.skipped).eql([{ reason: 'unsupported', count: 2 }]);
  });

  it('should count a truncated directory listing without losing the entries it did see', async () => {
    // Arrange
    const { filesystem } = walked({
      tree: treeOf(['', directory([{ name: 'seen.ts', type: 'file' }], true)]),
    });

    // Act
    const index = await filesystem.index(CWD);

    // Assert
    should(index.files.map(file => file.path)).eql(['seen.ts']);
    should(index.coverage).eql('partial');
    should(countFor(index.skipped, 'truncated')).eql(1);
  });

  it('should stop at the directory bound and count what it never looked at', async () => {
    // Arrange
    const { filesystem } = walked({
      tree: treeOf(
        [
          '',
          directory([
            { name: 'a', type: 'dir' },
            { name: 'b', type: 'dir' },
          ]),
        ],
        ['a', directory([{ name: 'in-a.ts', type: 'file' }])],
        ['b', directory([{ name: 'in-b.ts', type: 'file' }])],
      ),
    });

    // Act
    const index = await filesystem.index(CWD, { maxDirectories: 2 });

    // Assert
    should(index.files.map(file => file.path)).eql(['a/in-a.ts']);
    should(index.coverage).eql('partial');
    // The directory it had to abandon plus the one still queued behind it.
    should(countFor(index.skipped, 'truncated')).eql(1);
  });

  it('should stop at the file bound part-way through a directory', async () => {
    // Arrange
    const { filesystem } = walked({
      tree: treeOf([
        '',
        directory([
          { name: 'one.ts', type: 'file' },
          { name: 'two.ts', type: 'file' },
          { name: 'three.ts', type: 'file' },
        ]),
      ]),
    });

    // Act
    const index = await filesystem.index(CWD, { maxFiles: 1 });

    // Assert
    should(index.files.map(file => file.path)).eql(['one.ts']);
    should(countFor(index.skipped, 'truncated')).eql(2);
  });

  it('should count a name the syntactic gate refuses rather than emitting a row that cannot be opened', async () => {
    // Arrange
    const { filesystem } = walked({
      tree: treeOf(['', directory([{ name: 'back\\slash.ts', type: 'file' }])]),
    });

    // Act
    const index = await filesystem.index(CWD);

    // Assert
    should(index.files).eql([]);
    should(index.skipped).eql([{ reason: 'unsupported', count: 1 }]);
  });

  it('should close the pin and every directory it opened', async () => {
    // Arrange
    const { filesystem, pinner } = walked({
      tree: treeOf(['', directory([{ name: 'only.ts', type: 'file' }])]),
    });

    // Act
    await filesystem.index(CWD);

    // Assert
    should(pinner.lastRoot.closed).be.true();
    should(pinner.lastRoot.targets.every(target => target.closed)).be.true();
  });

  it('should sort the complete candidate set before applying the file response bound', async () => {
    // Arrange: breadth-first discovery sees z.ts before the lexically earlier nested path.
    const { filesystem } = walked({
      tree: treeOf(
        [
          '',
          directory([
            { name: 'z.ts', type: 'file' },
            { name: 'a', type: 'dir' },
          ]),
        ],
        ['a', directory([{ name: 'first.ts', type: 'file' }])],
      ),
    });

    // Act
    const index = await filesystem.index(CWD, { maxFiles: 1 });

    // Assert
    should(index.files.map(file => file.path)).eql(['a/first.ts']);
    should(index.coverage).eql('partial');
    should(countFor(index.skipped, 'truncated')).eql(1);
  });

  it('should apply the exact index exclusions without opening any excluded subtree', async () => {
    // Arrange
    const entries = EXPECTED_INDEX_EXCLUSIONS.map(name => ({ name, type: 'dir' as const }));
    const { filesystem, pinner } = walked({
      tree: treeOf(['', directory([...entries, { name: 'kept.ts', type: 'file' }])]),
    });

    // Act
    const index = await filesystem.index(CWD);

    // Assert
    should(index.files.map(file => file.path)).eql(['kept.ts']);
    should(index.skipped).eql([{ reason: 'excluded', count: EXPECTED_INDEX_EXCLUSIONS.length }]);
    should(pinner.lastRoot.opens).eql(['']);
  });
});
