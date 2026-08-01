import { afterAll, describe, it } from 'bun:test';
import path from 'node:path';
import should from 'should';
import {
  BunGitRunner,
  DEFAULT_GIT_STDERR_LIMIT,
  DEFAULT_GIT_STDOUT_LIMIT,
  DEFAULT_GIT_TIMEOUT_MS,
  GitProcessError,
} from '../../../src/adapters/git/index.ts';
import { cleanupTempDirectories, setupGit, stubGitDirectory, tempRepository } from '../support/repository.ts';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * The per-test budget, derived from the production one so the two can never drift apart again.
 *
 * A test budget SHORTER than the budget of the code under test cannot fail honestly. These tests
 * drive a real `git` through `BunGitRunner`, which is allowed `DEFAULT_GIT_TIMEOUT_MS` before it
 * gives up — but bun's default per-test budget is 5s, so under CI load bun's timeout fires first and
 * the failure reports a timeout that has nothing to do with the behaviour being asserted. The
 * runner's own timeout must always be the one that expires, which means every test here has to
 * outlast it.
 *
 * The slack is for the FIXTURES, and it has to be generous. Each test builds a real repository
 * first — `git init`, a config write, an add and a commit — and none of that runs through the
 * runner, so none of it is covered by `DEFAULT_GIT_TIMEOUT_MS`. A budget of runner + 10s assumed
 * that setup was free; on a loaded CI runner it is not, and the whole budget expired during
 * fixture work while the assertion never ran. The symptom is a test that fails at exactly its
 * budget, which reads like a hang in the code under test and is not one.
 */
const GIT_TEST_TIMEOUT_MS = DEFAULT_GIT_TIMEOUT_MS + 50_000;

describe('BunGitRunner', () => {
  afterAll(async () => {
    await cleanupTempDirectories();
  });

  it(
    'should expose conservative default limits',
    () => {
      // Act + Assert
      should(DEFAULT_GIT_TIMEOUT_MS).equal(10_000);
      should(DEFAULT_GIT_STDOUT_LIMIT).equal(1024 * 1024);
      should(DEFAULT_GIT_STDERR_LIMIT).equal(64 * 1024);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'should run a command in the requested checkout and report success',
    async () => {
      // Arrange
      const repository = await tempRepository('runner-ok');
      const subject = new BunGitRunner();

      // Act
      const actual = await subject.run({ cwd: repository.root, args: ['rev-parse', 'HEAD'] });

      // Assert
      should(actual.exitCode).equal(0);
      should(decode(actual.stdout).trim()).equal(repository.head);
      should(actual.stderr).equal('');
      should(actual.stdoutTruncated).be.false();
      should(actual.stderrTruncated).be.false();
      should(actual.timedOut).be.false();
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'should surface the exit code and stderr instead of swallowing a failure',
    async () => {
      // Arrange
      const repository = await tempRepository('runner-fail');
      const subject = new BunGitRunner();

      // Act
      const actual = await subject.run({ cwd: repository.root, args: ['rev-parse', '--verify', 'refs/heads/absent'] });

      // Assert
      should(actual.exitCode).not.equal(0);
      should(actual.stderr).not.be.empty();
      should(actual.timedOut).be.false();
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'should pass arguments through without any shell interpretation',
    async () => {
      // Arrange — a branch name full of shell metacharacters would be catastrophic under `sh -c`.
      const hostile = 'feat/a;b$(id)&&y|z;>pwned';
      const repository = await tempRepository('runner-args');
      await setupGit(repository.root, 'branch', '--', hostile);
      const subject = new BunGitRunner();

      // Act
      const actual = await subject.run({
        cwd: repository.root,
        args: ['show-ref', '--verify', '--', `refs/heads/${hostile}`],
      });

      // Assert
      should(actual.exitCode).equal(0);
      should(decode(actual.stdout)).containEql(`refs/heads/${hostile}`);
      should(await Bun.file(path.join(repository.root, 'pwned')).exists()).be.false();
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'should cap stdout and mark the result truncated',
    async () => {
      // Arrange
      const repository = await tempRepository('runner-cap');
      const subject = new BunGitRunner();

      // Act
      const actual = await subject.run({
        cwd: repository.root,
        args: ['rev-parse', 'HEAD'],
        maxStdoutBytes: 4,
      });

      // Assert
      should(actual.stdout.byteLength).equal(4);
      should(decode(actual.stdout)).equal(repository.head.slice(0, 4));
      should(actual.stdoutTruncated).be.true();
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'should keep nothing at all when the stdout budget is zero',
    async () => {
      // Arrange
      const repository = await tempRepository('runner-zero');
      const subject = new BunGitRunner();

      // Act
      const actual = await subject.run({ cwd: repository.root, args: ['rev-parse', 'HEAD'], maxStdoutBytes: 0 });

      // Assert
      should(actual.stdout.byteLength).equal(0);
      should(actual.stdoutTruncated).be.true();
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it.each([
    { label: 'timeout', invocation: { timeoutMs: -1 }, message: 'Git timeout must be a non-negative safe integer' },
    {
      label: 'timeout fraction',
      invocation: { timeoutMs: 1.5 },
      message: 'Git timeout must be a non-negative safe integer',
    },
    {
      label: 'stdout limit',
      invocation: { maxStdoutBytes: Number.NaN },
      message: 'Git stdout limit must be a non-negative safe integer',
    },
  ])(
    'should refuse an invalid $label rather than spawn Git',
    async ({ invocation, message }) => {
      // Arrange
      const repository = await tempRepository('runner-limit');
      const subject = new BunGitRunner();

      // Act
      const actual = await subject
        .run({ cwd: repository.root, args: ['status'], ...invocation })
        .then(() => undefined)
        .catch((error: unknown) => error);

      // Assert
      should(actual).be.instanceof(GitProcessError);
      should((actual as GitProcessError).code).equal('invalid_limit');
      should((actual as GitProcessError).message).equal(message);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'should kill a command that outlives its timeout and report it as timed out',
    async () => {
      // Arrange — a stub `git` that never returns, so the timeout is the only way this finishes.
      const repository = await tempRepository('runner-timeout');
      const stubs = await stubGitDirectory('#!/bin/sh\nsleep 60\n');
      const subject = new BunGitRunner(() => ({ PATH: `${stubs}:${process.env.PATH ?? ''}` }));

      // Act
      const actual = await subject.run({ cwd: repository.root, args: ['rev-parse', 'HEAD'], timeoutMs: 25 });

      // Assert
      should(actual.timedOut).be.true();
      should(actual.exitCode).not.equal(0);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'should fail loudly when Git cannot be started at all',
    async () => {
      // Arrange
      const repository = await tempRepository('runner-spawn');
      const subject = new BunGitRunner();

      // Act
      const actual = await subject
        .run({ cwd: path.join(repository.root, 'absent'), args: ['status'] })
        .then(() => undefined)
        .catch((error: unknown) => error);

      // Assert
      should(actual).be.instanceof(GitProcessError);
      should((actual as GitProcessError).code).equal('spawn_failed');
      should((actual as GitProcessError).name).equal('GitProcessError');
      should((actual as GitProcessError).cause).not.be.undefined();
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'should scrub inherited GIT_* variables while keeping the rest of the environment',
    async () => {
      // Arrange — an inherited GIT_DIR from the daemon's own process would silently retarget Git.
      const repository = await tempRepository('runner-env');
      const subject = new BunGitRunner(() => ({
        PATH: process.env.PATH,
        GIT_DIR: path.join(repository.root, 'hijacked'),
        GIT_WORK_TREE: path.join(repository.root, 'hijacked-tree'),
        UNSET_VARIABLE: undefined,
      }));

      // Act — Git can only be found at all if the non-GIT_ PATH survived the scrub.
      const actual = await subject.run({ cwd: repository.root, args: ['rev-parse', '--absolute-git-dir'] });

      // Assert
      should(actual.exitCode).equal(0);
      should(decode(actual.stdout).trim()).equal(path.join(repository.root, '.git'));
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'should pin a machine-readable locale and quoting for parseable output',
    async () => {
      // Arrange — quotepath=false keeps non-ASCII paths literal instead of octal-escaped.
      const repository = await tempRepository('runner-locale');
      await Bun.write(path.join(repository.root, 'ünicode.txt'), 'x');
      const subject = new BunGitRunner();

      // Act
      const actual = await subject.run({ cwd: repository.root, args: ['status', '--porcelain'] });

      // Assert
      should(actual.exitCode).equal(0);
      should(decode(actual.stdout)).containEql('ünicode.txt');
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'should refuse to run repository hooks or a configured pager',
    async () => {
      // Arrange
      const repository = await tempRepository('runner-hooks');
      const marker = path.join(repository.root, 'hook-ran');
      const hooks = path.join(repository.root, '.git', 'hooks');
      await Bun.write(path.join(hooks, 'post-checkout'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
      await setupGit(repository.root, 'config', 'core.pager', 'false');
      const subject = new BunGitRunner();

      // Act
      const actual = await subject.run({ cwd: repository.root, args: ['log', '--oneline'] });

      // Assert
      should(actual.exitCode).equal(0);
      should(decode(actual.stdout)).containEql('chore: seed');
      should(await Bun.file(marker).exists()).be.false();
    },
    GIT_TEST_TIMEOUT_MS,
  );
});
