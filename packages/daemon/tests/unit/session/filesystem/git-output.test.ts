import { describe, it } from 'bun:test';
import should from 'should';
import {
  EMPTY_TREE_OID,
  hasDiffableChange,
  parseBatchCheck,
  parseBranchHeader,
  parseCheckIgnore,
  parseFileList,
  parseHeadTreeEntry,
  parseNumstat,
  parsePorcelainStatus,
  parseRevParse,
  relabelDiffHeaders,
  type SessionGitChange,
  underPrefix,
  withLineStats,
} from '../../../../src/lib/session/filesystem/index.ts';

/**
 * Every place a hostile filename could be mistaken for structure.
 *
 * These are the parses that stand between Git's output and a client, and each case below is a shape that
 * would otherwise surface as a change that never existed, a path outside the session cwd, or a header a
 * file's own content forged.
 */

const NUL = String.fromCharCode(0);
const records = (...values: readonly string[]): string => values.map(value => `${value}${NUL}`).join('');

describe('parseRevParse', () => {
  it('should read the worktree facts in the order Git prints them', () => {
    // Arrange / Act
    const facts = parseRevParse('true\n/home/kirin/repo\npackages/cli/\n');

    // Assert
    should(facts).eql({ insideWorkTree: true, root: '/home/kirin/repo', prefix: 'packages/cli/' });
  });

  it('should report the repo root prefix as empty', () => {
    // Arrange / Act
    const facts = parseRevParse('true\n/home/kirin/repo\n\n');

    // Assert
    should(facts.prefix).eql('');
  });

  it('should report anything other than "true" as outside a worktree', () => {
    // Arrange / Act / Assert
    should(parseRevParse('false\n')).eql({ insideWorkTree: false, prefix: '' });
    should(parseRevParse('')).eql({ insideWorkTree: false, prefix: '' });
  });

  it('should omit a top level Git did not print', () => {
    // Arrange / Act
    const facts = parseRevParse('true\n');

    // Assert
    should(facts).eql({ insideWorkTree: true, prefix: '' });
  });
});

describe('parseBranchHeader', () => {
  it('should take the branch from an upstream-tracking header', () => {
    // Arrange / Act / Assert
    should(parseBranchHeader('main...origin/main [ahead 2]')).eql('main');
  });

  it('should take the branch of a repository with no commits yet', () => {
    // Arrange / Act / Assert
    should(parseBranchHeader('No commits yet on trunk')).eql('trunk');
  });

  it('should report a detached HEAD as having no branch', () => {
    // Arrange / Act / Assert
    should(parseBranchHeader('HEAD (no branch)')).be.undefined();
  });

  it('should report an empty header as having no branch', () => {
    // Arrange / Act / Assert
    should(parseBranchHeader('   ')).be.undefined();
  });
});

describe('underPrefix', () => {
  it('should pass a path through unchanged at the repository root', () => {
    // Arrange / Act / Assert
    should(underPrefix('src/a.ts', '')).eql('src/a.ts');
  });

  it('should re-express a path against the session prefix', () => {
    // Arrange / Act / Assert
    should(underPrefix('packages/cli/src/a.ts', 'packages/cli/')).eql('src/a.ts');
  });

  it('should refuse a sibling path, which reporting would leak', () => {
    // Arrange / Act / Assert
    should(underPrefix('packages/daemon/src/a.ts', 'packages/cli/')).be.undefined();
  });
});

describe('parseNumstat', () => {
  it('should read counts for a path containing a tab and a newline', () => {
    // Arrange: only the FIRST two tabs are structure; everything after is the literal path.
    const stdout = records('3\t1\tsrc/od\td\nname.ts');

    // Act
    const stats = parseNumstat(stdout, false);

    // Assert
    should(stats.get('src/od\td\nname.ts')).eql({ additions: 3, deletions: 1 });
  });

  it('should give a binary pair no made-up count', () => {
    // Arrange
    const stats = parseNumstat(records('-\t-\tlogo.png', '2\t0\ta.ts'), false);

    // Act / Assert
    should(stats.has('logo.png')).be.false();
    should(stats.get('a.ts')).eql({ additions: 2, deletions: 0 });
  });

  it('should discard the unterminated tail of a capped stream', () => {
    // Arrange: the cap landed mid-record, so the fragment is not a real row.
    const stdout = `${records('1\t1\tkept.ts')}4\t4\tcut`;

    // Act
    const stats = parseNumstat(stdout, true);

    // Assert
    should([...stats.keys()]).eql(['kept.ts']);
  });

  it('should keep a complete final record even when the stream was capped', () => {
    // Arrange / Act
    const stats = parseNumstat(records('1\t1\tkept.ts'), true);

    // Assert
    should([...stats.keys()]).eql(['kept.ts']);
  });

  it('should skip a record whose shape is not two counts and a path', () => {
    // Arrange / Act
    const stats = parseNumstat(records('', 'nofields', '\t\tempty', '1\t1\t', '1\tx\ta.ts'), false);

    // Assert
    should(stats.size).eql(0);
  });

  it('should refuse a count that is not a safe non-negative integer', () => {
    // Arrange / Act
    const stats = parseNumstat(records('1e999\t0\ta.ts', '-2\t0\tb.ts'), false);

    // Assert
    should(stats.size).eql(0);
  });
});

describe('parsePorcelainStatus', () => {
  it('should read the branch header and every following row', () => {
    // Arrange
    const stdout = records('## main...origin/main', ' M a.ts', 'A  added.ts', '?? scratch.txt');

    // Act
    const status = parsePorcelainStatus(stdout, false, '');

    // Assert
    should(status.branch).eql('main');
    should(status.changes).eql([
      { path: 'a.ts', status: ' M' },
      { path: 'added.ts', status: 'A ' },
      { path: 'scratch.txt', status: '??' },
    ]);
  });

  it('should read a rename as one row carrying its source', () => {
    // Arrange: destination first, then source, as two NUL-separated fields.
    const stdout = records('## main', 'R  new.ts', 'old.ts');

    // Act
    const status = parsePorcelainStatus(stdout, false, '');

    // Assert
    should(status.changes).eql([{ path: 'new.ts', status: 'R ', from: 'old.ts' }]);
  });

  it('should read a copy the same way a rename is read', () => {
    // Arrange
    const status = parsePorcelainStatus(records('C  copy.ts', 'source.ts'), false, '');

    // Act / Assert
    should(status.changes).eql([{ path: 'copy.ts', status: 'C ', from: 'source.ts' }]);
  });

  it('should drop a rename whose source record the cap cut off entirely', () => {
    // Arrange: the destination terminated, then the cap landed mid-source. The pair is atomic — neither
    // half is honest enough to emit alone.
    const stdout = `${records('R  new.ts')}old`;

    // Act
    const status = parsePorcelainStatus(stdout, true, '');

    // Assert
    should(status.changes).eql([]);
  });

  it('should omit a rename SOURCE that sits outside the session cwd', () => {
    // Arrange
    const stdout = records('R  mine/new.ts', 'elsewhere/old.ts');

    // Act
    const status = parsePorcelainStatus(stdout, false, 'mine/');

    // Assert
    should(status.changes).eql([{ path: 'new.ts', status: 'R ' }]);
  });

  it('should hide sibling paths from a session in a subdirectory', () => {
    // Arrange
    const stdout = records('## main', ' M mine/in.ts', ' M other/out.ts', ' M mine/');

    // Act
    const status = parsePorcelainStatus(stdout, false, 'mine/');

    // Assert
    should(status.changes).eql([{ path: 'in.ts', status: ' M' }]);
  });

  it('should discard the unterminated tail of a capped stream', () => {
    // Arrange
    const stdout = `${records('## main', ' M kept.ts')} M cu`;

    // Act
    const status = parsePorcelainStatus(stdout, true, '');

    // Assert
    should(status.changes).eql([{ path: 'kept.ts', status: ' M' }]);
  });

  it('should skip a record too short to hold a status and a path', () => {
    // Arrange / Act
    const status = parsePorcelainStatus(records(' M', '', ' M a.ts'), false, '');

    // Assert
    should(status.changes).eql([{ path: 'a.ts', status: ' M' }]);
  });

  it('should report no branch when there is no header at all', () => {
    // Arrange / Act
    const status = parsePorcelainStatus(records(' M a.ts'), false, '');

    // Assert
    should(status.branch).be.undefined();
    should(status.changes).have.length(1);
  });
});

describe('withLineStats', () => {
  const modified: SessionGitChange = { path: 'a.ts', status: ' M' };

  it('should attach the counts for a path', () => {
    // Arrange / Act
    const changes = withLineStats([modified], new Map([['a.ts', { additions: 3, deletions: 2 }]]));

    // Assert
    should(changes).eql([{ path: 'a.ts', status: ' M', additions: 3, deletions: 2 }]);
  });

  it('should fold both halves of a rename onto its one row', () => {
    // Arrange: with detection off, a rename is a deletion at `from` plus an addition at `path`.
    const rename: SessionGitChange = { path: 'new.ts', status: 'R ', from: 'old.ts' };
    const stats = new Map([
      ['new.ts', { additions: 10, deletions: 0 }],
      ['old.ts', { additions: 0, deletions: 10 }],
    ]);

    // Act
    const changes = withLineStats([rename], stats);

    // Assert
    should(changes[0]).match({ additions: 10, deletions: 10 });
  });

  it('should leave a row Git could not count exactly as it was', () => {
    // Arrange / Act
    const changes = withLineStats([modified], new Map());

    // Assert
    should(changes).eql([modified]);
  });
});

describe('hasDiffableChange', () => {
  it('should see nothing to count in an untracked-or-ignored-only list', () => {
    // Arrange / Act / Assert
    should(
      hasDiffableChange([
        { path: 'a', status: '??' },
        { path: 'b', status: '!!' },
      ]),
    ).be.false();
  });

  it('should see something to count as soon as one row is tracked', () => {
    // Arrange / Act / Assert
    should(
      hasDiffableChange([
        { path: 'a', status: '??' },
        { path: 'b', status: ' M' },
      ]),
    ).be.true();
  });
});

describe('parseHeadTreeEntry', () => {
  it('should read the mode and object id of a blob', () => {
    // Arrange / Act
    const entry = parseHeadTreeEntry(records('100755 blob abc123\trun.sh'), 'run.sh');

    // Assert
    should(entry).eql({ mode: 0o100755, oid: 'abc123' });
  });

  it('should read a path containing a newline', () => {
    // Arrange / Act
    const entry = parseHeadTreeEntry(records('100644 blob abc123\tod\nd.ts'), 'od\nd.ts');

    // Assert
    should(entry?.oid).eql('abc123');
  });

  it('should decline a gitlink, which has no blob to read', () => {
    // Arrange / Act / Assert
    should(parseHeadTreeEntry(records('160000 commit abc123\tsubmodule'), 'submodule')).be.undefined();
  });

  it('should decline a record for a DIFFERENT path than the one asked about', () => {
    // Arrange: a directory pathspec reports the first entry beneath it.
    should(parseHeadTreeEntry(records('100644 blob abc123\tsub/one.ts'), 'sub')).be.undefined();
  });

  it('should decline empty or unparsable output', () => {
    // Arrange / Act / Assert
    should(parseHeadTreeEntry('', 'a.ts')).be.undefined();
    should(parseHeadTreeEntry(records('garbage'), 'a.ts')).be.undefined();
  });
});

describe('parseBatchCheck', () => {
  it('should read the object id and size of a blob', () => {
    // Arrange / Act
    const reply = parseBatchCheck(`abc123 blob 42\n`);

    // Assert
    should(reply).eql({ oid: 'abc123', size: 42 });
  });

  it('should strip the NUL the -z form leaves behind before reading the size', () => {
    // Arrange / Act
    const reply = parseBatchCheck(`abc123 blob 7${NUL}\n`);

    // Assert
    should(reply?.size).eql(7);
  });

  it('should decline anything that is not a blob', () => {
    // Arrange / Act / Assert
    should(parseBatchCheck('abc123 tree 42\n')).be.undefined();
    should(parseBatchCheck('HEAD:./x missing\n')).be.undefined();
    should(parseBatchCheck('')).be.undefined();
  });

  it('should decline a size that is not a safe non-negative integer', () => {
    // Arrange / Act / Assert
    should(parseBatchCheck('abc123 blob huge\n')).be.undefined();
    should(parseBatchCheck('abc123 blob -1\n')).be.undefined();
  });
});

describe('parseCheckIgnore', () => {
  it('should un-prefix every path it echoes back', () => {
    // Arrange / Act
    const ignored = parseCheckIgnore(records('./build', './secrets.yaml'));

    // Assert
    should([...ignored]).eql(['build', 'secrets.yaml']);
  });

  it('should keep a path Git did not prefix', () => {
    // Arrange / Act
    const ignored = parseCheckIgnore(records('build'));

    // Assert
    should([...ignored]).eql(['build']);
  });

  it('should read empty output as nothing ignored', () => {
    // Arrange / Act / Assert
    should(parseCheckIgnore('').size).eql(0);
  });
});

describe('relabelDiffHeaders', () => {
  it('should rewrite the one header Git derives from whichever side exists', () => {
    // Arrange: a deletion prints `a/x a/x`, an addition `b/x b/x`.
    const diff = 'diff --git a/b/del.ts a/b/del.ts\n--- a/del.ts\n+++ /dev/null\n';

    // Act
    const relabelled = relabelDiffHeaders(diff, 'del.ts');

    // Assert
    should(relabelled).match(/^diff --git a\/del\.ts b\/del\.ts$/m);
  });

  it('should rewrite BOTH headers a type change emits', () => {
    // Arrange
    const diff = 'diff --git a/x a/x\ndeleted file mode 120000\ndiff --git b/x b/x\nnew file mode 100644\n';

    // Act
    const relabelled = relabelDiffHeaders(diff, 'x');

    // Assert
    should(relabelled.split('\n').filter(line => line.startsWith('diff --git '))).eql([
      'diff --git a/x b/x',
      'diff --git a/x b/x',
    ]);
  });

  it('should leave a forged header inside the body alone', () => {
    // Arrange: every body line carries a prefix, so only column zero is a real header.
    const diff = 'diff --git a/x a/x\n+diff --git a/evil b/evil\n diff --git a/ctx b/ctx\n';

    // Act
    const relabelled = relabelDiffHeaders(diff, 'x');

    // Assert
    should(relabelled).eql('diff --git a/x b/x\n+diff --git a/evil b/evil\n diff --git a/ctx b/ctx\n');
  });

  it('should leave an empty diff empty', () => {
    // Arrange / Act / Assert
    should(relabelDiffHeaders('', 'x')).eql('');
  });
});

describe('the empty tree object id', () => {
  it('should be the well-known constant Git recognises without a commit', () => {
    // Arrange / Act / Assert
    should(EMPTY_TREE_OID).eql('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  });
});

describe('parsing the file list', () => {
  const NUL = String.fromCharCode(0);

  it('should read one NUL-terminated path per record', () => {
    // Arrange
    const stdout = `README.md${NUL}src/app.ts${NUL}`;

    // Act
    const paths = parseFileList(stdout, false);

    // Assert
    should(paths).eql(['README.md', 'src/app.ts']);
  });

  it('should drop the unterminated tail of a capped stream, never index a half name', () => {
    // A fragment presented as an ordinary record puts a file that does not exist into a search result
    // and sends the reader to a 404.
    // Arrange
    const stdout = `README.md${NUL}src/very-long-pa`;

    // Act
    const paths = parseFileList(stdout, true);

    // Assert
    should(paths).eql(['README.md']);
  });

  it('should keep a complete final record even when the stream was capped', () => {
    // Arrange
    const stdout = `README.md${NUL}src/app.ts${NUL}`;

    // Act
    const paths = parseFileList(stdout, true);

    // Assert
    should(paths).eql(['README.md', 'src/app.ts']);
  });

  it('should report a conflicted path once, not once per merge stage', () => {
    // Arrange
    const stdout = `both.ts${NUL}both.ts${NUL}both.ts${NUL}other.ts${NUL}`;

    // Act
    const paths = parseFileList(stdout, false);

    // Assert
    should(paths).eql(['both.ts', 'other.ts']);
  });

  it('should treat a path holding a newline or a tab as one path', () => {
    // Arrange
    const stdout = `weird\nname.ts${NUL}tab\tname.ts${NUL}`;

    // Act
    const paths = parseFileList(stdout, false);

    // Assert
    should(paths).eql(['weird\nname.ts', 'tab\tname.ts']);
  });

  it('should read an empty listing as no paths at all', () => {
    // Arrange / Act / Assert
    should(parseFileList('', false)).eql([]);
  });
});
