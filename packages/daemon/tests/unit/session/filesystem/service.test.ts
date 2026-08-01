import { describe, it } from 'bun:test';
import should from 'should';
import {
  FsError,
  SessionFilesystem,
  type FsFileView,
  type FsListing,
} from '../../../../src/lib/session/filesystem/index.ts';
import {
  directory,
  FAKE_MTIME,
  FAKE_POLICY_CWD,
  FAKE_ROOT,
  FakeRootPinner,
  FakeSessionGit,
  textFile,
  treeOf,
  type FakeRootOptions,
  type SessionGitScript,
} from './support.ts';

/**
 * The domain's gate orchestration.
 *
 * Containment itself is NOT what these prove — that is a kernel question, answered by the integration tests
 * against the real procfs pinner. What is proved here is everything the domain is responsible for: that
 * both secrets gates run on both sides of the walk, that a refusal from EITHER side wins, that a path whose
 * component identities changed while Git was answering is refused rather than served, and that Git is only
 * ever handed the pinned working directory.
 */

const CWD = '/home/kirin/session';

const viewer = (root: FakeRootOptions = {}, git: SessionGitScript = {}) => {
  const pinner = new FakeRootPinner(root);
  const sessionGit = new FakeSessionGit(git);
  return { filesystem: new SessionFilesystem(pinner, sessionGit), pinner, git: sessionGit };
};

const refusalFrom = async (act: () => Promise<unknown>): Promise<FsError> => {
  try {
    await act();
  } catch (error) {
    if (error instanceof FsError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('SessionFilesystem root handling', () => {
  it('should report the root as PINNED rather than as configured, and close the pin', async () => {
    // Arrange
    const { filesystem, pinner } = viewer({ rootReal: '/real/worktree' });

    // Act
    const root = await filesystem.resolveRoot(CWD);

    // Assert
    should(root).eql('/real/worktree');
    should(pinner.pinnedCwds).eql([CWD]);
    should(pinner.lastRoot.closed).be.true();
  });

  it('should surface the pinner refusal for a session cwd that is not served', async () => {
    // Arrange
    const { filesystem } = viewer({ pinError: new FsError('denied', 'session cwd is not served') });

    // Act
    const error = await refusalFrom(async () => await filesystem.resolveRoot(CWD));

    // Assert
    should(error.code).eql('denied');
  });

  it('should ask Git about the repository through the PINNED working directory', async () => {
    // Arrange
    const { filesystem, git } = viewer({}, { repoInfo: () => ({ repo: true, prefix: '', hasHead: true }) });

    // Act
    const repo = await filesystem.isRepo(CWD);

    // Assert
    should(repo).be.true();
    should(git.cwds).eql([FAKE_POLICY_CWD]);
  });

  it('should report a non-repository cwd as one, rather than failing', async () => {
    // Arrange
    const { filesystem } = viewer({}, { repoInfo: () => ({ repo: false, prefix: '', hasHead: false }) });

    // Act / Assert
    should(await filesystem.isRepo(CWD)).be.false();
  });

  it('should read the change list from the pinned tree', async () => {
    // Arrange
    const { filesystem, git } = viewer(
      {},
      { changes: () => ({ repo: true, branch: 'main', changes: [{ path: 'a.ts', status: ' M' }] }) },
    );

    // Act
    const view = await filesystem.changes(CWD);

    // Assert
    should(view).eql({ repo: true, branch: 'main', changes: [{ path: 'a.ts', status: ' M' }] });
    should(git.cwds).eql([FAKE_POLICY_CWD]);
  });
});

describe('SessionFilesystem.resolve', () => {
  it('should resolve the root itself without a walk', async () => {
    // Arrange
    const { filesystem, pinner } = viewer({ tree: treeOf() });

    // Act
    const target = await filesystem.resolve(CWD, './');

    // Assert
    should(target).eql({ rootReal: FAKE_ROOT, rel: '', absolute: FAKE_ROOT });
    should(pinner.lastRoot.opens).eql([]);
  });

  it('should report the absolute location derived from the walk, and close the target', async () => {
    // Arrange
    const { filesystem, pinner } = viewer({ tree: treeOf(['src/a.ts', textFile('x')]) });

    // Act
    const target = await filesystem.resolve(CWD, 'src/a.ts/');

    // Assert
    should(target).eql({ rootReal: FAKE_ROOT, rel: 'src/a.ts', absolute: `${FAKE_ROOT}/src/a.ts` });
    should(pinner.lastRoot.targets[0]?.closed).be.true();
  });

  it('should refuse a traversal before any walk happens', async () => {
    // Arrange
    const { filesystem, pinner } = viewer({ tree: treeOf() });

    // Act
    const error = await refusalFrom(async () => await filesystem.resolve(CWD, '../elsewhere'));

    // Assert
    should(error.code).eql('invalid_path');
    should(pinner.lastRoot.opens).eql([]);
  });
});

describe('SessionFilesystem.list', () => {
  const tree = () =>
    treeOf([
      '',
      directory([
        { name: 'zeta.ts', type: 'file', size: 12, mtime: FAKE_MTIME },
        { name: 'src', type: 'dir' },
        { name: 'alpha.ts', type: 'file' },
        { name: 'assets', type: 'dir' },
      ]),
    ]);

  it('should list directories before files and each group by name', async () => {
    // Arrange
    const { filesystem } = viewer({ tree: tree() });

    // Act
    const listing: FsListing = await filesystem.list(CWD);

    // Assert
    should(listing.root).eql(FAKE_ROOT);
    should(listing.path).eql('');
    should(listing.entries.map(entry => entry.name)).eql(['assets', 'src', 'alpha.ts', 'zeta.ts']);
    should(listing.entries[3]).eql({ name: 'zeta.ts', type: 'file', size: 12, mtime: FAKE_MTIME });
    should(listing.truncated).be.undefined();
  });

  it('should report a directory that ran past the entry cap as truncated', async () => {
    // Arrange
    const { filesystem } = viewer({ tree: treeOf(['', directory([{ name: 'a', type: 'file' }], true)]) });

    // Act
    const listing = await filesystem.list(CWD, '');

    // Assert
    should(listing.truncated).be.true();
  });

  it('should badge a denied entry by its own name and by what a symlink points at', async () => {
    // Arrange: `alias` is lexically innocent and canonically the object store.
    const { filesystem } = viewer({
      tree: treeOf([
        '',
        directory([
          { name: '.env', type: 'file' },
          { name: 'alias', type: 'symlink', target: '.git' },
          { name: 'notes.md', type: 'file' },
        ]),
      ]),
    });

    // Act
    const listing = await filesystem.list(CWD);
    const byName = new Map(listing.entries.map(entry => [entry.name, entry]));

    // Assert
    should(byName.get('.env')?.denied).be.true();
    should(byName.get('alias')?.denied).be.true();
    should(byName.get('notes.md')?.denied).be.undefined();
  });

  it('should badge a symlink that leaves the root as escaping and keep it out of the ignore batch', async () => {
    // Arrange
    const { filesystem, git } = viewer({
      tree: treeOf([
        '',
        directory([
          { name: 'outside', type: 'symlink', escapes: true },
          { name: 'inside.ts', type: 'file' },
        ]),
      ]),
    });

    // Act
    const listing = await filesystem.list(CWD);
    const byName = new Map(listing.entries.map(entry => [entry.name, entry]));

    // Assert
    should(byName.get('outside')?.escapes).be.true();
    should(byName.get('outside')?.ignored).be.undefined();
    should(git.ignoreCalls.at(-1)?.rels).eql(['inside.ts']);
  });

  it('should badge a gitignored entry, including one reached through a symlink to an ignored target', async () => {
    // Arrange
    const { filesystem } = viewer(
      {
        tree: treeOf([
          '',
          directory([
            { name: 'build', type: 'dir' },
            { name: 'out', type: 'symlink', target: 'build' },
            { name: 'src', type: 'dir' },
          ]),
        ]),
      },
      { ignoredPaths: () => new Set(['build']) },
    );

    // Act
    const listing = await filesystem.list(CWD);
    const byName = new Map(listing.entries.map(entry => [entry.name, entry]));

    // Assert
    should(byName.get('build')?.ignored).be.true();
    should(byName.get('out')?.ignored).be.true();
    should(byName.get('src')?.ignored).be.undefined();
  });

  it('should still list a directory whose ignore batch failed, badging nothing', async () => {
    // Arrange: badges are advisory; the gates that decide whether BYTES are served run on the read.
    const { filesystem } = viewer(
      { tree: treeOf(['', directory([{ name: 'src', type: 'dir' }])]) },
      {
        ignoredPaths: () => {
          throw new Error('git is unavailable');
        },
      },
    );

    // Act
    const listing = await filesystem.list(CWD);

    // Assert
    should(listing.entries).eql([{ name: 'src', type: 'dir' }]);
  });

  it('should refuse to enumerate a denied directory by its lexical path', async () => {
    // Arrange
    const { filesystem } = viewer({ tree: treeOf(['.git', directory([])]) });

    // Act
    const error = await refusalFrom(async () => await filesystem.list(CWD, '.git'));

    // Assert
    should(error.code).eql('denied');
  });

  it('should refuse to enumerate a directory whose CANONICAL path is denied', async () => {
    // Arrange: an in-root symlinked directory whose target is the object store.
    const { filesystem } = viewer({ tree: treeOf(['alias', { type: 'dir', canonical: '.git', entries: [] }]) });

    // Act
    const error = await refusalFrom(async () => await filesystem.list(CWD, 'alias'));

    // Assert
    should(error.code).eql('denied');
  });

  it('should refuse to enumerate a gitignored directory, because the filenames are themselves the leak', async () => {
    // Arrange
    const { filesystem } = viewer(
      { tree: treeOf(['build', directory([{ name: 'prod-credentials.json', type: 'file' }])]) },
      { ignoredPaths: () => new Set(['build']) },
    );

    // Act
    const error = await refusalFrom(async () => await filesystem.list(CWD, 'build'));

    // Assert
    should(error.code).eql('ignored');
  });

  it('should refuse enumeration when the directory becomes ignored only AFTER it was opened', async () => {
    // Arrange: the first verdict is clean and the second is not. Either one refuses.
    const { filesystem } = viewer(
      { tree: treeOf(['build', directory([])]) },
      { ignoredPaths: (_cwd, _rels, call) => (call === 1 ? new Set() : new Set(['build'])) },
    );

    // Act
    const error = await refusalFrom(async () => await filesystem.list(CWD, 'build'));

    // Assert
    should(error.code).eql('ignored');
  });

  it('should refuse enumeration when Git cannot prove the directory unignored', async () => {
    // Arrange
    const { filesystem } = viewer(
      { tree: treeOf(['build', directory([])]) },
      {
        ignoredPaths: () => {
          throw new Error('git timed out');
        },
      },
    );

    // Act
    const error = await refusalFrom(async () => await filesystem.list(CWD, 'build'));

    // Assert
    should(error.code).eql('ignored');
  });

  it('should refuse a path that is not a directory', async () => {
    // Arrange
    const { filesystem } = viewer({ tree: treeOf(['a.ts', textFile('x')]) });

    // Act
    const error = await refusalFrom(async () => await filesystem.list(CWD, 'a.ts'));

    // Assert
    should(error.code).eql('not_a_directory');
  });

  it('should refuse a directory whose components changed while its policy was being checked', async () => {
    // Arrange: the re-walk the domain performs after Git's verdict sees a different inode.
    const tree = treeOf(['src', directory([])]);
    const { filesystem } = viewer({
      tree,
      onOpen: (rel, attempt, staged) => {
        if (rel === 'src' && attempt === 2) {
          staged.set('src', {
            type: 'dir',
            entries: [],
            identities: [{ dev: 1, ino: 999, ctimeMs: 5, mode: 0o40755 }],
          });
        }
      },
    });

    // Act
    const error = await refusalFrom(async () => await filesystem.list(CWD, 'src'));

    // Assert
    should(error.code).eql('not_found');
    should(error.message).match(/changed while its secrets policy/);
  });

  it('should run the validation barrier after pinning and before enumerating', async () => {
    // Arrange
    const order: string[] = [];
    const { filesystem } = viewer({
      tree: treeOf(['src', directory([{ name: 'a.ts', type: 'file' }])]),
      onOpen: rel => order.push(`open:${rel}`),
    });

    // Act
    const listing = await filesystem.list(CWD, 'src', {
      afterValidation: async () => {
        order.push('barrier');
      },
    });

    // Assert
    should(order).eql(['open:src', 'barrier', 'open:src']);
    should(listing.entries).have.length(1);
  });
});

describe('SessionFilesystem.readFile from the working tree', () => {
  it('should serve the bytes of a regular file', async () => {
    // Arrange
    const { filesystem } = viewer({ tree: treeOf(['src/a.ts', textFile('hello')]) });

    // Act
    const view: FsFileView = await filesystem.readFile(CWD, 'src/a.ts');

    // Assert
    should(view).eql({ path: 'src/a.ts', size: 5, mtime: FAKE_MTIME, content: 'hello' });
  });

  it('should require a file path rather than serving the root', async () => {
    // Arrange
    const { filesystem } = viewer({ tree: treeOf() });

    // Act
    const error = await refusalFrom(async () => await filesystem.readFile(CWD, ''));

    // Assert
    should(error.code).eql('invalid_path');
  });

  it('should report a binary file without its content', async () => {
    // Arrange
    const { filesystem } = viewer({ tree: treeOf(['bin', { type: 'file', bytes: new Uint8Array([1, 0, 2]) }]) });

    // Act
    const view = await filesystem.readFile(CWD, 'bin');

    // Assert
    should(view.binary).be.true();
    should(view.content).be.undefined();
  });

  it('should report a file over the cap by its real size, without reading it', async () => {
    // Arrange
    const { filesystem } = viewer({ tree: treeOf(['big', { type: 'file', size: 4096, bytes: new Uint8Array(4) }]) });

    // Act
    const view = await filesystem.readFile(CWD, 'big', { maxBytes: 8 });

    // Assert
    should(view).eql({ path: 'big', size: 4096, mtime: FAKE_MTIME, tooLarge: true });
  });

  it('should refuse a denylisted path with the denial badge and the real metadata', async () => {
    // Arrange
    const { filesystem } = viewer({ tree: treeOf(['.env', textFile('TOKEN=1')]) });

    // Act
    const view = await filesystem.readFile(CWD, '.env');

    // Assert
    should(view).eql({ path: '.env', size: 7, mtime: FAKE_MTIME, denied: true, reason: 'denylist' });
  });

  it('should refuse a path whose CANONICAL location is denylisted', async () => {
    // Arrange
    const { filesystem } = viewer({ tree: treeOf(['alias/config', textFile('x', { canonical: '.git/config' })]) });

    // Act
    const view = await filesystem.readFile(CWD, 'alias/config');

    // Assert
    should(view.denied).be.true();
    should(view.path).eql('alias/config');
  });

  it('should refuse a gitignored path with the ignore badge', async () => {
    // Arrange
    const { filesystem } = viewer(
      { tree: treeOf(['secrets.decrypted', textFile('x')]) },
      { ignoredPaths: () => new Set(['secrets.decrypted']) },
    );

    // Act
    const view = await filesystem.readFile(CWD, 'secrets.decrypted');

    // Assert
    should(view.ignored).be.true();
    should(view.reason).eql('ignored');
  });

  it('should keep the PRE-WALK refusal even when the post-walk verdict is clean', async () => {
    // Arrange: an ignored original replaced by an unignored object must not be laundered.
    const { filesystem } = viewer(
      { tree: treeOf(['swapped', textFile('x')]) },
      { ignoredPaths: (_cwd, _rels, call) => (call === 1 ? new Set(['swapped']) : new Set()) },
    );

    // Act
    const view = await filesystem.readFile(CWD, 'swapped');

    // Assert
    should(view.ignored).be.true();
  });

  it('should refuse when the file becomes ignored only AFTER the walk', async () => {
    // Arrange
    const { filesystem } = viewer(
      { tree: treeOf(['later', textFile('x')]) },
      { ignoredPaths: (_cwd, _rels, call) => (call === 1 ? new Set() : new Set(['later'])) },
    );

    // Act
    const view = await filesystem.readFile(CWD, 'later');

    // Assert
    should(view.ignored).be.true();
  });

  it('should refuse a directory asked for as a file', async () => {
    // Arrange
    const { filesystem } = viewer({ tree: treeOf(['src', directory([])]) });

    // Act
    const error = await refusalFrom(async () => await filesystem.readFile(CWD, 'src'));

    // Assert
    should(error.code).eql('not_a_file');
  });

  it('should refuse a file whose components changed while its policy was being checked', async () => {
    // Arrange
    const tree = treeOf(['a.ts', textFile('hello')]);
    const { filesystem } = viewer({
      tree,
      onOpen: (rel, attempt, staged) => {
        if (rel === 'a.ts' && attempt === 2) {
          staged.set('a.ts', textFile('hello', { identities: [{ dev: 1, ino: 7, ctimeMs: 9, mode: 0o100644 }] }));
        }
      },
    });

    // Act
    const error = await refusalFrom(async () => await filesystem.readFile(CWD, 'a.ts'));

    // Assert
    should(error.code).eql('not_found');
    should(error.message).match(/changed while its secrets policy/);
  });

  it('should run the validation barrier after the walk and before the bytes are read', async () => {
    // Arrange
    const order: string[] = [];
    const { filesystem } = viewer({
      tree: treeOf(['a.ts', textFile('hello')]),
      onOpen: rel => order.push(`open:${rel}`),
    });

    // Act
    await filesystem.readFile(CWD, 'a.ts', {
      afterValidation: async () => {
        order.push('barrier');
      },
    });

    // Assert
    should(order).eql(['open:a.ts', 'barrier', 'open:a.ts']);
  });
});

describe('SessionFilesystem.readFile from HEAD', () => {
  const blob = (content: string) => ({ size: content.length, bytes: new TextEncoder().encode(content) });

  it('should serve the committed bytes without walking the working tree', async () => {
    // Arrange
    const { filesystem, pinner } = viewer({ tree: treeOf() }, { readHeadBlob: () => blob('committed') });

    // Act
    const view = await filesystem.readFile(CWD, 'a.ts', { rev: 'head' });

    // Assert
    should(view).eql({ path: 'a.ts', size: 9, content: 'committed', rev: 'head' });
    should(pinner.lastRoot.opens).eql([]);
  });

  it('should apply the denylist to a HEAD read, because these bytes never leave the machine either', async () => {
    // Arrange
    const { filesystem } = viewer({ tree: treeOf() }, { readHeadBlob: () => blob('TOKEN=1') });

    // Act
    const view = await filesystem.readFile(CWD, '.env', { rev: 'head' });

    // Assert
    should(view).eql({ path: '.env', size: 0, denied: true, reason: 'denylist', rev: 'head' });
  });

  it('should recheck the ignore gate AFTER the read, since ignore policy is worktree state', async () => {
    // Arrange
    const { filesystem } = viewer(
      { tree: treeOf() },
      {
        readHeadBlob: () => blob('committed'),
        ignoredPaths: (_cwd, _rels, call) => (call === 1 ? new Set() : new Set(['a.ts'])),
      },
    );

    // Act
    const view = await filesystem.readFile(CWD, 'a.ts', { rev: 'head' });

    // Assert
    should(view.ignored).be.true();
    should(view.rev).eql('head');
  });

  it('should report a path absent from HEAD as missing', async () => {
    // Arrange
    const { filesystem } = viewer({ tree: treeOf() }, { readHeadBlob: () => undefined });

    // Act
    const error = await refusalFrom(async () => await filesystem.readFile(CWD, 'a.ts', { rev: 'head' }));

    // Assert
    should(error.code).eql('not_found');
    should(error.message).match(/not in HEAD/);
  });

  it('should report an oversized committed blob by its size alone', async () => {
    // Arrange
    const { filesystem } = viewer({ tree: treeOf() }, { readHeadBlob: () => ({ size: 9_000_000 }) });

    // Act
    const view = await filesystem.readFile(CWD, 'a.ts', { rev: 'head' });

    // Assert
    should(view).eql({ path: 'a.ts', size: 9_000_000, tooLarge: true, rev: 'head' });
  });

  it('should report a binary committed blob without content', async () => {
    // Arrange
    const { filesystem } = viewer(
      { tree: treeOf() },
      { readHeadBlob: () => ({ size: 3, bytes: new Uint8Array([7, 0, 7]) }) },
    );

    // Act
    const view = await filesystem.readFile(CWD, 'a.ts', { rev: 'head' });

    // Assert
    should(view.binary).be.true();
    should(view.content).be.undefined();
  });
});

describe('SessionFilesystem.diff', () => {
  const head = (content: string, mode = 0o100644) => ({
    mode,
    bytes: new TextEncoder().encode(content),
    truncated: false,
  });

  it('should require a file path', async () => {
    // Arrange
    const { filesystem } = viewer({ tree: treeOf() });

    // Act
    const error = await refusalFrom(async () => await filesystem.diff(CWD, '.'));

    // Assert
    should(error.code).eql('invalid_path');
  });

  it('should diff the pinned working bytes against the committed ones', async () => {
    // Arrange
    const { filesystem, git } = viewer(
      { tree: treeOf(['a.ts', textFile('new')]) },
      {
        isTracked: () => true,
        headEntry: () => head('old'),
        diffSnapshots: () => ({ diff: 'DIFF', truncated: false }),
      },
    );

    // Act
    const view = await filesystem.diff(CWD, 'a.ts');

    // Assert
    should(view).eql({ path: 'a.ts', diff: 'DIFF', kind: 'tracked' });
    should(git.diffCalls[0]?.oldSide?.mode).eql(0o100644);
    should(new TextDecoder().decode(git.diffCalls[0]?.newSide?.bytes)).eql('new');
  });

  it('should carry the executable bit of the working file into the diff mode', async () => {
    // Arrange
    const { filesystem, git } = viewer(
      { tree: treeOf(['run.sh', textFile('#!/bin/sh', { mode: 0o100755 })]) },
      { isTracked: () => true },
    );

    // Act
    await filesystem.diff(CWD, 'run.sh');

    // Assert
    should(git.diffCalls[0]?.newSide?.mode).eql(0o100755);
  });

  it('should treat a path Git does not know as untracked', async () => {
    // Arrange
    const { filesystem } = viewer(
      { tree: treeOf(['fresh.ts', textFile('new')]) },
      { diffSnapshots: () => ({ diff: 'ADDED', truncated: false }) },
    );

    // Act
    const view = await filesystem.diff(CWD, 'fresh.ts');

    // Assert
    should(view.kind).eql('untracked');
  });

  it('should diff a DELETED file, which no longer exists on disk', async () => {
    // Arrange: the walk 404s and the index answers for it — the ` D` row a Changes list shows.
    const { filesystem, git } = viewer(
      { tree: treeOf() },
      {
        isTracked: () => true,
        headEntry: () => head('gone'),
        diffSnapshots: () => ({ diff: 'DEL', truncated: false }),
      },
    );

    // Act
    const view = await filesystem.diff(CWD, 'gone.ts');

    // Assert
    should(view).eql({ path: 'gone.ts', diff: 'DEL', kind: 'tracked' });
    should(git.diffCalls[0]?.newSide).be.undefined();
  });

  it('should still ask HEAD for a path the index has forgotten, so a staged deletion renders', async () => {
    // Arrange
    const { filesystem } = viewer(
      { tree: treeOf() },
      {
        isTracked: () => false,
        headEntry: () => head('gone'),
        diffSnapshots: () => ({ diff: 'RM', truncated: false }),
      },
    );

    // Act
    const view = await filesystem.diff(CWD, 'removed.ts');

    // Assert
    should(view.kind).eql('tracked');
    should(view.diff).eql('RM');
  });

  it('should 404 an arbitrary missing path that Git knows nothing about', async () => {
    // Arrange
    const { filesystem } = viewer({ tree: treeOf() }, { isTracked: () => false, headEntry: () => undefined });

    // Act
    const error = await refusalFrom(async () => await filesystem.diff(CWD, 'invented.ts'));

    // Assert
    should(error.code).eql('not_found');
  });

  it('should report no diff outside a repository, but only for a path that exists', async () => {
    // Arrange
    const { filesystem } = viewer(
      { tree: treeOf(['a.ts', textFile('x')]) },
      { repoInfo: () => ({ repo: false, prefix: '', hasHead: false }) },
    );

    // Act
    const view = await filesystem.diff(CWD, 'a.ts');

    // Assert
    should(view).eql({ path: 'a.ts', diff: '', kind: 'none' });
  });

  it('should 404 a missing path outside a repository, where nothing can answer for it', async () => {
    // Arrange
    const { filesystem } = viewer(
      { tree: treeOf() },
      { repoInfo: () => ({ repo: false, prefix: '', hasHead: false }) },
    );

    // Act
    const error = await refusalFrom(async () => await filesystem.diff(CWD, 'a.ts'));

    // Assert
    should(error.code).eql('not_found');
  });

  it('should refuse the diff of a denylisted path — a diff of a secret is a secret', async () => {
    // Arrange
    const { filesystem } = viewer({ tree: treeOf(['.env', textFile('TOKEN=1')]) }, { isTracked: () => true });

    // Act
    const view = await filesystem.diff(CWD, '.env');

    // Assert
    should(view).eql({ path: '.env', diff: '', kind: 'none', denied: true, reason: 'denylist' });
  });

  it('should refuse the diff of a gitignored path', async () => {
    // Arrange
    const { filesystem } = viewer(
      { tree: treeOf(['out.js', textFile('x')]) },
      { ignoredPaths: () => new Set(['out.js']) },
    );

    // Act
    const view = await filesystem.diff(CWD, 'out.js');

    // Assert
    should(view).eql({ path: 'out.js', diff: '', kind: 'none', ignored: true, reason: 'ignored' });
  });

  it('should report truncation rather than diffing a partial working file', async () => {
    // Arrange: a partial diff renders as removals that never happened.
    const { filesystem } = viewer(
      { tree: treeOf(['big.ts', { type: 'file', size: 99_000_000, bytes: new Uint8Array(4) }]) },
      { isTracked: () => true },
    );

    // Act
    const view = await filesystem.diff(CWD, 'big.ts');

    // Assert
    should(view).eql({ path: 'big.ts', diff: '', kind: 'tracked', truncated: true });
  });

  it('should report truncation when the committed side was cut', async () => {
    // Arrange
    const { filesystem } = viewer(
      { tree: treeOf(['a.ts', textFile('x')]) },
      { isTracked: () => true, headEntry: () => ({ mode: 0o100644, bytes: new Uint8Array(4), truncated: true }) },
    );

    // Act
    const view = await filesystem.diff(CWD, 'a.ts');

    // Assert
    should(view.truncated).be.true();
  });

  it('should propagate the truncation Git reports on the rendered diff', async () => {
    // Arrange
    const { filesystem } = viewer(
      { tree: treeOf(['a.ts', textFile('x')]) },
      { isTracked: () => true, diffSnapshots: () => ({ diff: 'PART', truncated: true }) },
    );

    // Act
    const view = await filesystem.diff(CWD, 'a.ts');

    // Assert
    should(view).eql({ path: 'a.ts', diff: 'PART', kind: 'tracked', truncated: true });
  });

  it('should refuse a directory asked for as a diff', async () => {
    // Arrange
    const { filesystem } = viewer({ tree: treeOf(['src', directory([])]) });

    // Act
    const error = await refusalFrom(async () => await filesystem.diff(CWD, 'src'));

    // Assert
    should(error.code).eql('not_a_file');
  });

  it('should let a containment refusal from the walk stand, rather than treating it as a deletion', async () => {
    // Arrange
    const { filesystem } = viewer({
      tree: treeOf(['link', { error: new FsError('escapes_root', 'path escapes the session root: link') }]),
    });

    // Act
    const error = await refusalFrom(async () => await filesystem.diff(CWD, 'link'));

    // Assert
    should(error.code).eql('escapes_root');
  });

  it('should refuse a diff whose components changed while its policy was being checked', async () => {
    // Arrange
    const tree = treeOf(['a.ts', textFile('x')]);
    const { filesystem } = viewer(
      {
        tree,
        onOpen: (rel, attempt, staged) => {
          if (rel === 'a.ts' && attempt === 2) {
            staged.set('a.ts', textFile('x', { identities: [{ dev: 2, ino: 2, ctimeMs: 2, mode: 0o100644 }] }));
          }
        },
      },
      { isTracked: () => true },
    );

    // Act
    const error = await refusalFrom(async () => await filesystem.diff(CWD, 'a.ts'));

    // Assert
    should(error.code).eql('not_found');
  });

  it('should run the validation barrier after the walk and before Git is consulted', async () => {
    // Arrange
    const order: string[] = [];
    const { filesystem } = viewer(
      { tree: treeOf(['a.ts', textFile('x')]), onOpen: rel => order.push(`open:${rel}`) },
      {
        isTracked: () => {
          order.push('git:isTracked');
          return true;
        },
      },
    );

    // Act
    await filesystem.diff(CWD, 'a.ts', {
      afterValidation: async () => {
        order.push('barrier');
      },
    });

    // Assert
    should(order).eql(['open:a.ts', 'barrier', 'git:isTracked', 'open:a.ts']);
  });
});
