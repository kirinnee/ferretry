import { describe, it } from 'bun:test';
import should from 'should';
import {
  checkTreeIndexBounds,
  gitEnvironment,
  globalExcludesArguments,
  indexPinnedTree,
  MAX_INDEX_FILES,
  parseFileList,
  type TreeGitExecution,
  type TreeGitInvocation,
  type TreeGitRunner,
  type TreePolicy,
  treeGit,
} from '../../contract/index.ts';
import { FAKE_POLICY_CWD, FakeRootPinner, textFile, treeOf } from './daemon/session/filesystem/support.ts';

/**
 * The shared tree index (&F6061 U2): the one owner of how a file index asks Git, and of the walk that proves its names.
 *
 * The ferret index's own behaviour is pinned by `daemon/session/filesystem/index.test.ts`, which runs through this code.
 * What these cases pin is what a SECOND caller (a project's file finder) relies on: the caller's own secret rule is the
 * one applied, the owner's global exclude file reaches the file list, and a global config is read and never run.
 */

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const NUL = String.fromCharCode(0);

const executed = (overrides: Partial<TreeGitExecution> = {}): TreeGitExecution => ({
  exitCode: 0,
  stdout: new Uint8Array(),
  stderr: '',
  stdoutTruncated: false,
  stderrTruncated: false,
  timedOut: false,
  ...overrides,
});

/** A runner that answers from a script and remembers every command it was given. */
const scripted = (answer: (invocation: TreeGitInvocation) => TreeGitExecution) => {
  const calls: TreeGitInvocation[] = [];
  const runner: TreeGitRunner = {
    run: async invocation => {
      calls.push(invocation);
      return answer(invocation);
    },
  };
  return { runner, calls };
};

const isConfigRead = (invocation: TreeGitInvocation): boolean => invocation.args[0] === 'config';

describe('gitEnvironment', () => {
  it('should close the global config unless the command asks to read one value from it', () => {
    // Act
    const closed = gitEnvironment({}, true);
    const open = gitEnvironment({}, true, true);

    // Assert
    should(closed.GIT_CONFIG_GLOBAL).eql('/dev/null');
    should(open.GIT_CONFIG_GLOBAL).be.undefined();
    should(open.GIT_CONFIG_SYSTEM).eql('/dev/null');
    should(open.GIT_CONFIG_NOSYSTEM).eql('1');
  });

  it('should drop every inherited GIT_ name, so an ambient GIT_DIR or GIT_CONFIG_GLOBAL cannot steer the child', () => {
    // Act
    const environment = gitEnvironment(
      { GIT_DIR: '/elsewhere', GIT_CONFIG_GLOBAL: '/hostile', HOME: '/home/owner' },
      false,
      true,
    );

    // Assert
    should(environment.GIT_DIR).be.undefined();
    should(environment.GIT_CONFIG_GLOBAL).be.undefined();
    should(environment.HOME).eql('/home/owner');
  });
});

describe('globalExcludesArguments', () => {
  it('should hand back one -c core.excludesFile for the path Git expanded', async () => {
    // Arrange
    const { runner, calls } = scripted(() => executed({ stdout: encode('/home/owner/.gitignore_global\n') }));

    // Act
    const args = await globalExcludesArguments(runner, '/cwd', undefined);

    // Assert
    should(args).eql(['-c', 'core.excludesFile=/home/owner/.gitignore_global']);
    should(calls[0]?.args).eql(['config', '--global', '--type=path', '--get', 'core.excludesFile']);
    should(calls[0]?.readsGlobalConfig).be.true();
  });

  it('should add nothing when the owner set none (exit 1)', async () => {
    // Arrange
    const { runner } = scripted(() => executed({ exitCode: 1 }));

    // Act / Assert
    should(await globalExcludesArguments(runner, '/cwd', undefined)).eql([]);
  });

  it('should throw when Git cannot read the global config, rather than list what the owner told it to hide', async () => {
    // Arrange
    const { runner } = scripted(() => executed({ exitCode: 128, stderr: 'fatal: bad config line 3' }));

    // Act
    const failure = await globalExcludesArguments(runner, '/cwd', undefined).catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceof(Error);
    should((failure as Error).message).match(/git config failed: fatal: bad config line 3/);
  });

  it('should throw on a timeout', async () => {
    // Arrange
    const { runner } = scripted(() => executed({ exitCode: -1, timedOut: true }));

    // Act
    const failure = await globalExcludesArguments(runner, '/cwd', 5).catch((error: unknown) => error);

    // Assert
    should((failure as Error).message).eql('git config timed out');
  });
});

describe('treeGit.listFiles', () => {
  it('should put the excludes before the subcommand and ask for the list through the same runner', async () => {
    // Arrange
    const { runner, calls } = scripted(invocation =>
      isConfigRead(invocation)
        ? executed({ stdout: encode('/x/ignore\n') })
        : executed({ stdout: encode(`a.ts${NUL}b.ts${NUL}a.ts${NUL}`) }),
    );

    // Act
    const listed = await treeGit(runner).listFiles('/cwd', 1024);

    // Assert
    should(listed).eql({ paths: ['a.ts', 'b.ts'], truncated: false });
    should(calls[1]?.args).eql([
      '-c',
      'core.excludesFile=/x/ignore',
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
    ]);
    should(calls[1]?.maxStdoutBytes).eql(1024);
    should(calls[1]?.readsGlobalConfig).be.undefined();
  });

  it('should answer an expired budget with an incomplete empty list and spawn nothing', async () => {
    // Arrange
    const { runner, calls } = scripted(() => executed());

    // Act
    const listed = await treeGit(runner).listFiles('/cwd', 1024, { expired: () => true, remainingMs: () => 0 });

    // Assert
    should(listed).eql({ paths: [], truncated: true });
    should(calls).eql([]);
  });

  it('should not start the list when the config read spent the budget', async () => {
    // Arrange
    const asked: true[] = [];
    const budget = {
      expired: () => {
        asked.push(true);
        return asked.length > 1;
      },
      remainingMs: () => 100,
    };
    const { runner, calls } = scripted(() => executed({ exitCode: 1 }));

    // Act
    const listed = await treeGit(runner).listFiles('/cwd', 1024, budget);

    // Assert
    should(listed).eql({ paths: [], truncated: true });
    should(calls.map(call => call.args[0])).eql(['config']);
  });

  it('should hand the runner what is left of the budget as the timeout, rounded up', async () => {
    // Arrange
    const { runner, calls } = scripted(invocation => executed({ exitCode: isConfigRead(invocation) ? 1 : 0 }));

    // Act
    await treeGit(runner).listFiles('/cwd', 1024, { expired: () => false, remainingMs: () => 12.2 });

    // Assert
    should(calls.map(call => call.timeoutMs)).eql([13, 13]);
  });

  it('should throw the caller’s own error type when the list fails', async () => {
    // Arrange
    class Mine extends Error {}
    const { runner } = scripted(invocation =>
      isConfigRead(invocation) ? executed({ exitCode: 1 }) : executed({ exitCode: 128, stderr: 'boom' }),
    );

    // Act
    const failure = await treeGit(runner, () => new Mine('mine'))
      .listFiles('/cwd', 1024)
      .catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceof(Mine);
  });
});

describe('treeGit.isInsideWorkTree', () => {
  it('should say yes for a work tree and no for a folder outside any repository', async () => {
    // Arrange
    const inside = scripted(() => executed({ stdout: encode('true\n') }));
    const outside = scripted(() =>
      executed({ exitCode: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' }),
    );

    // Act / Assert
    should(await treeGit(inside.runner).isInsideWorkTree('/cwd')).be.true();
    should(await treeGit(outside.runner).isInsideWorkTree('/cwd')).be.false();
  });

  it('should throw for a repository Git refuses (dubious ownership) rather than call it "not a repository"', async () => {
    // Arrange: walking it would list exactly what its ignore rules hide.
    const { runner } = scripted(() =>
      executed({ exitCode: 128, stderr: 'fatal: detected dubious ownership in repository at /srv/x' }),
    );

    // Act
    const failure = await treeGit(runner)
      .isInsideWorkTree('/cwd')
      .catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceof(Error);
  });
});

describe('parseFileList', () => {
  it('should drop the half-name at the end of a capped list', () => {
    should(parseFileList(`a${NUL}b`, true)).eql(['a']);
    should(parseFileList(`a${NUL}b`, false)).eql(['a', 'b']);
  });
});

describe('indexPinnedTree with another caller’s secret rule', () => {
  const policy = (denied: (rel: string) => boolean): TreePolicy => ({
    normalize: rel => rel,
    isDenied: denied,
  });
  const gitListing = (paths: readonly string[]) => ({
    isInsideWorkTree: async () => true,
    listFiles: async () => ({ paths, truncated: false }),
  });

  it('should apply the caller’s own rule, counting what it drops as denied', async () => {
    // Arrange
    const pinner = new FakeRootPinner({
      tree: treeOf(['a.ts', textFile('x')], ['notes.secret', textFile('y')]),
    });
    const root = await pinner.pin('/ignored');

    // Act
    const index = await indexPinnedTree(root, {
      git: gitListing(['a.ts', 'notes.secret']),
      policy: policy(rel => rel.endsWith('.secret')),
      nowMs: () => 0,
    });

    // Assert
    should(index.files.map(file => file.path)).eql(['a.ts']);
    should(index.skipped).eql([{ reason: 'denied', count: 1 }]);
    should(index.coverage).eql('complete');
    should(index.root).eql(root.rootReal);
  });

  it('should hand Git the held directory, never a name', async () => {
    // Arrange
    const pinner = new FakeRootPinner({ tree: treeOf(['a.ts', textFile('x')]) });
    const root = await pinner.pin('/ignored');
    const seen: unknown[] = [];

    // Act
    await indexPinnedTree(root, {
      git: {
        isInsideWorkTree: async cwd => {
          seen.push(cwd);
          return true;
        },
        listFiles: async cwd => {
          seen.push(cwd);
          return { paths: ['a.ts'], truncated: false };
        },
      },
      policy: policy(() => false),
      nowMs: () => 0,
    });

    // Assert
    should(seen).eql([FAKE_POLICY_CWD, FAKE_POLICY_CWD]);
  });

  it('should fence an agent’s walk by the held root’s verdict, and a root that cannot answer fences everything', async () => {
    // Arrange: no Git repository, so the walk reads the root's children.
    const pinner = new FakeRootPinner({
      tree: treeOf(['', { type: 'dir', entries: [{ name: 'a.ts', type: 'file' }] }]),
    });
    const root = await pinner.pin('/ignored');
    const notRepo = { isInsideWorkTree: async () => false, listFiles: async () => ({ paths: [], truncated: false }) };

    // Act
    const person = await indexPinnedTree(root, { git: notRepo, policy: policy(() => false), nowMs: () => 0 });
    // The same root with the verdict taken away: a spread would lose the class's methods, so it is spelled out.
    const withoutVerdict = {
      rootReal: root.rootReal,
      policyCwd: root.policyCwd,
      open: (rel: string, options?: Parameters<typeof root.open>[1]) => root.open(rel, options),
      probe: () => root.probe(),
      close: () => root.close(),
    };
    const agent = await indexPinnedTree(
      withoutVerdict,
      { git: notRepo, policy: policy(() => false), nowMs: () => 0 },
      { fenced: true },
    );

    // Assert
    should(person.files.map(file => file.path)).eql(['a.ts']);
    should(agent.files).eql([]);
    should(agent.skipped).eql([{ reason: 'denied', count: 1 }]);
  });
});

describe('checkTreeIndexBounds', () => {
  it('should refuse a bound that is not a real one and accept the defaults', () => {
    should(() => checkTreeIndexBounds({ maxFiles: MAX_INDEX_FILES + 1 })).throw(RangeError);
    should(() => checkTreeIndexBounds({ maxFiles: MAX_INDEX_FILES })).not.throw();
    should(() => checkTreeIndexBounds({ budgetMs: -1 })).throw(RangeError);
    should(() => checkTreeIndexBounds({})).not.throw();
  });
});
