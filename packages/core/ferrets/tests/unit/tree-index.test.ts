import { describe, it } from 'bun:test';
import should from 'should';
import {
  checkTreeIndexBounds,
  gitEnvironment,
  establishGlobalConfig,
  indexPinnedTree,
  MAX_INDEX_FILES,
  MAX_PROJECT_INDEX_CANDIDATES,
  MAX_PROJECT_INDEX_FILES,
  parseFileList,
  TreeRootDeniedError,
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

const isConfigRead = (invocation: TreeGitInvocation): boolean => invocation.args.includes('config');

describe('gitEnvironment', () => {
  it('should close the global config unless the command asks to see the owner’s exclusions', () => {
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

describe('establishGlobalConfig', () => {
  const failureOf = async (execution: TreeGitExecution): Promise<unknown> => {
    const { runner } = scripted(() => execution);
    return establishGlobalConfig(runner, '/cwd', undefined).then(
      () => undefined,
      (error: unknown) => error,
    );
  };

  it('should ask Git to read the global config and everything it includes, and run nothing from it', async () => {
    // Arrange
    const { runner, calls } = scripted(() => executed());

    // Act
    await establishGlobalConfig(runner, '/cwd', undefined);

    // Assert
    // The XDG config is named as an include because Git skips an unreadable one in silence next to a readable ~/.gitconfig.
    should(calls[0]?.args).eql([
      '-c',
      'include.path=~/.config/git/config',
      'config',
      '--global',
      '--includes',
      '--list',
      '-z',
    ]);
    should(calls[0]?.readsGlobalConfig).be.true();
  });

  it('should accept a global config that is absent: no file, no rules', async () => {
    // Arrange / Act / Assert
    should(
      await failureOf(
        executed({
          exitCode: 128,
          stderr: "fatal: unable to read config file '/h/.gitconfig': No such file or directory\n",
        }),
      ),
    ).be.undefined();
  });

  it('should throw when the global config is unreadable (permission denied), rather than list what it hides', async () => {
    // Arrange
    const execution = executed({
      exitCode: 128,
      stderr: "warning: unable to access '/h/.gitconfig': Permission denied\nfatal: unable to read config file\n",
    });

    // Act
    const failure = await failureOf(execution);

    // Assert
    should(failure).be.instanceof(Error);
    should((failure as Error).message).match(/^git config failed:/);
  });

  it('should throw for a malformed config, an unreadable include, and a warning on a zero exit', async () => {
    should(
      await failureOf(executed({ exitCode: 128, stderr: 'fatal: bad config line 3 in file /h/.gitconfig' })),
    ).be.instanceof(Error);
    should(
      await failureOf(executed({ exitCode: 128, stderr: "fatal: unable to access '/h/inc': Permission denied" })),
    ).be.instanceof(Error);
    should(
      await failureOf(executed({ exitCode: 0, stderr: "warning: unable to access '/h/.config/git/config'" })),
    ).be.instanceof(Error);
  });

  it('should throw on a timeout and on an answer cut by the byte cap', async () => {
    should(((await failureOf(executed({ exitCode: -1, timedOut: true }))) as Error).message).eql(
      'git config timed out',
    );
    should(await failureOf(executed({ stdoutTruncated: true }))).be.instanceof(Error);
  });
});

describe('treeGit.listFiles', () => {
  it('should let Git resolve the owner’s exclusions: no -c override, the owner’s global config readable', async () => {
    // Arrange
    const { runner, calls } = scripted(invocation =>
      isConfigRead(invocation) ? executed() : executed({ stdout: encode(`a.ts${NUL}b.ts${NUL}a.ts${NUL}`) }),
    );

    // Act
    const listed = await treeGit(runner).listFiles('/cwd', 1024);

    // Assert
    should(listed).eql({ paths: ['a.ts', 'b.ts'], truncated: false });
    should(calls[1]?.args).eql(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    should(calls[1]?.args).not.containEql('-c');
    should(calls[1]?.maxStdoutBytes).eql(1024);
    should(calls[1]?.readsGlobalConfig).be.true();
  });

  it('should throw when Git warns it could not read an ignore file, even on a zero exit', async () => {
    // Arrange
    const { runner } = scripted(invocation =>
      isConfigRead(invocation)
        ? executed()
        : executed({
            stdout: encode(`a.ts${NUL}`),
            stderr: "warning: unable to access '/h/.config/git/ignore': Permission denied",
          }),
    );

    // Act
    const failure = await treeGit(runner)
      .listFiles('/cwd', 1024)
      .catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceof(Error);
    should((failure as Error).message).match(/^git ls-files failed:/);
  });

  it('should throw when the global config cannot be established, and never ask for the list', async () => {
    // Arrange
    const { runner, calls } = scripted(() => executed({ exitCode: 128, stderr: 'fatal: bad config line 1' }));

    // Act
    const failure = await treeGit(runner)
      .listFiles('/cwd', 1024)
      .catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceof(Error);
    should(calls.map(call => (call.args.includes('config') ? 'config' : call.args[0]))).eql(['config']);
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
    const { runner, calls } = scripted(() => executed());

    // Act
    const listed = await treeGit(runner).listFiles('/cwd', 1024, budget);

    // Assert
    should(listed).eql({ paths: [], truncated: true });
    should(calls.map(call => (call.args.includes('config') ? 'config' : call.args[0]))).eql(['config']);
  });

  it('should hand the runner what is left of the budget as the timeout, rounded up', async () => {
    // Arrange
    const { runner, calls } = scripted(() => executed());

    // Act
    await treeGit(runner).listFiles('/cwd', 1024, { expired: () => false, remainingMs: () => 12.2 });

    // Assert
    should(calls.map(call => call.timeoutMs)).eql([13, 13]);
  });

  it('should throw the caller’s own error type when the list fails', async () => {
    // Arrange
    class Mine extends Error {}
    const { runner } = scripted(invocation =>
      isConfigRead(invocation) ? executed() : executed({ exitCode: 128, stderr: 'boom' }),
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

  it('should withhold the shared secret names even from a caller whose own rule withholds nothing', async () => {
    // Arrange: a permissive caller, both for a Git tree and for a walked one.
    const names = ['a.ts', '.env', 'deploy/prod.pem', '.ssh/known_hosts', 'id_work.key'];
    const pinner = new FakeRootPinner({ tree: treeOf(...names.map(name => [name, textFile('x')] as const)) });
    const root = await pinner.pin('/ignored');

    // Act
    const index = await indexPinnedTree(root, {
      git: gitListing(names),
      policy: policy(() => false),
      nowMs: () => 0,
    });

    // Assert
    should(index.files.map(file => file.path)).eql(['a.ts']);
    should(index.skipped).eql([{ reason: 'denied', count: 4 }]);
  });

  it('should withhold the shared secret names from a walked tree too', async () => {
    // Arrange
    const pinner = new FakeRootPinner({
      tree: treeOf([
        '',
        {
          type: 'dir',
          entries: [
            { name: 'a.ts', type: 'file' },
            { name: '.env', type: 'file' },
            { name: '.ssh', type: 'dir' },
          ],
        },
      ]),
    });
    const root = await pinner.pin('/ignored');

    // Act
    const index = await indexPinnedTree(root, {
      git: { isInsideWorkTree: async () => false, listFiles: async () => ({ paths: [], truncated: false }) },
      policy: policy(() => false),
      nowMs: () => 0,
    });

    // Assert
    should(index.files.map(file => file.path)).eql(['a.ts']);
    should(index.skipped).eql([{ reason: 'denied', count: 2 }]);
  });

  it('should refuse a root that is itself a key store, whatever the caller’s rule, and ask Git nothing', async () => {
    // Arrange: `known_hosts` is innocent when judged relative to its folder; `.env` is a folder named like a secret file.
    for (const rootReal of ['/home/owner/.ssh', '/home/owner/.gnupg', '/srv/app/.env', '/home/owner/.ssh/deep/er']) {
      const pinner = new FakeRootPinner({ rootReal, tree: treeOf(['known_hosts', textFile('x')]) });
      const root = await pinner.pin('/ignored');
      const asked: string[] = [];

      // Act
      const failure = await indexPinnedTree(root, {
        git: {
          isInsideWorkTree: async () => {
            asked.push('rev-parse');
            return true;
          },
          listFiles: async () => {
            asked.push('ls-files');
            return { paths: ['known_hosts'], truncated: false };
          },
        },
        policy: policy(() => false),
        nowMs: () => 0,
      }).catch((error: unknown) => error);

      // Assert
      should(failure).be.instanceof(TreeRootDeniedError);
      should(asked).eql([]);
    }
  });

  it('should still serve an ordinary root', async () => {
    // Arrange
    const pinner = new FakeRootPinner({ rootReal: '/home/owner/project', tree: treeOf(['a.ts', textFile('x')]) });
    const root = await pinner.pin('/ignored');

    // Act
    const index = await indexPinnedTree(root, {
      git: gitListing(['a.ts']),
      policy: policy(() => false),
      nowMs: () => 0,
    });

    // Assert
    should(index.files.map(file => file.path)).eql(['a.ts']);
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

  it('should raise the ceilings only for the project scale (&F6061 U5), and no further', () => {
    should(() => checkTreeIndexBounds({ scale: 'project', maxFiles: MAX_PROJECT_INDEX_FILES })).not.throw();
    should(() => checkTreeIndexBounds({ scale: 'project', maxFiles: MAX_PROJECT_INDEX_FILES + 1 })).throw(RangeError);
    should(() => checkTreeIndexBounds({ scale: 'project', maxCandidates: MAX_PROJECT_INDEX_CANDIDATES })).not.throw();
    should(() => checkTreeIndexBounds({ scale: 'session', maxFiles: MAX_PROJECT_INDEX_FILES })).throw(RangeError);
    should(() => checkTreeIndexBounds({ maxFiles: MAX_PROJECT_INDEX_FILES })).throw(RangeError);
  });
});

describe('the project scale keeps shallow files first when a ceiling bites', () => {
  const policy: TreePolicy = { normalize: rel => rel, isDenied: () => false };
  const names = ['a/b/c/deep.ts', 'a/mid.ts', 'z/other.ts', 'README.md', 'top.ts'];
  const gitListing = {
    isInsideWorkTree: async () => true,
    listFiles: async () => ({ paths: names, truncated: false }),
  };
  const run = async (scale: 'session' | 'project') => {
    const pinner = new FakeRootPinner({ tree: treeOf(...names.map(name => [name, textFile('x')] as const)) });
    const root = await pinner.pin('/ignored');
    return indexPinnedTree(root, { git: gitListing, policy, nowMs: () => 0 }, { scale, maxFiles: 3 });
  };

  it('should keep README.md and top.ts and drop the deepest names, and say a bound bit', async () => {
    // Act
    const index = await run('project');

    // Assert
    should(index.files.map(file => file.path)).eql(['README.md', 'top.ts', 'a/mid.ts']);
    should(index.coverage).eql('partial');
    should(index.skipped).eql([{ reason: 'truncated', count: 2 }]);
  });

  it('should keep a ferret index in path order, as before', async () => {
    // Act
    const index = await run('session');

    // Assert
    should(index.files.map(file => file.path)).eql(['README.md', 'a/b/c/deep.ts', 'a/mid.ts']);
  });
});
