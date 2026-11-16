import { describe, expect, test } from 'bun:test';
import { GitProcessError, KernelGitRunner, type GitByteSpawn } from '../../../../daemon/adapters/git/runner.ts';
import type { GitExecution } from '../../../../daemon/lib/worktrees/ports.ts';

/** The runner over a scripted spawn: how it hands Git to the kernel and what it says when the kernel cannot start it. */

const EXECUTION: GitExecution = {
  exitCode: 0,
  stdout: new Uint8Array(),
  stderr: '',
  stdoutTruncated: false,
  stderrTruncated: false,
  timedOut: false,
};

const failing = (error: unknown): GitByteSpawn => ({
  runBytes: async () => {
    throw error;
  },
});

describe('KernelGitRunner over a spawn that fails', () => {
  test('a spawn that cannot start Git is a spawn_failed refusal that keeps the kernel error as its cause', async () => {
    const cause = new Error('ENOENT: git not found');
    const refusal = await new KernelGitRunner(failing(cause))
      .run({ cwd: '/work', args: ['status'] })
      .catch(error => error);
    expect(refusal).toBeInstanceOf(GitProcessError);
    expect(refusal.code).toBe('spawn_failed');
    expect(refusal.message).toBe('could not start Git');
    expect(refusal.cause).toBe(cause);
  });

  test('a refusal the spawn already raised as a Git process error passes through untouched', async () => {
    const original = new GitProcessError('invalid_limit', 'already said');
    const refusal = await new KernelGitRunner(failing(original))
      .run({ cwd: '/work', args: ['status'] })
      .catch(error => error);
    expect(refusal).toBe(original);
  });

  test('a limit that is not a non-negative integer is refused before anything is spawned', async () => {
    let spawned = 0;
    const runner = new KernelGitRunner({
      runBytes: async () => {
        spawned += 1;
        return EXECUTION;
      },
    });
    const refusal = await runner.run({ cwd: '/work', args: ['log'], maxStdoutBytes: -1 }).catch(error => error);
    expect(refusal).toBeInstanceOf(GitProcessError);
    expect(refusal.code).toBe('invalid_limit');
    expect(spawned).toBe(0);
  });
});

describe('KernelGitRunner over a spawn that answers', () => {
  test('hardened arguments lead, the environment is scrubbed and the limits are the defaults', async () => {
    const seen: { args: readonly string[]; options: Parameters<GitByteSpawn['runBytes']>[2] }[] = [];
    const runner = new KernelGitRunner({
      runBytes: async (_program, args, options) => {
        seen.push({ args, options });
        return EXECUTION;
      },
    });
    expect(await runner.run({ cwd: '/work', args: ['status', '--porcelain'] })).toBe(EXECUTION);
    const call = seen[0];
    expect(call?.args.slice(-2)).toEqual(['status', '--porcelain']);
    expect(call?.args).toContain('core.hooksPath=/dev/null');
    expect(call?.options).toMatchObject({
      cwd: '/work',
      maxStdoutBytes: 1024 * 1024,
      maxStderrBytes: 64 * 1024,
      env: { LC_ALL: 'C', GIT_LITERAL_PATHSPECS: '1' },
    });
    expect(call?.options).not.toHaveProperty('stdin');
  });

  test('stdin and an explicit literal-pathspec choice are forwarded', async () => {
    const seen: Parameters<GitByteSpawn['runBytes']>[2][] = [];
    const runner = new KernelGitRunner({
      runBytes: async (_program, _args, options) => {
        seen.push(options);
        return EXECUTION;
      },
    });
    const stdin = new Uint8Array([1, 2]);
    await runner.run({
      cwd: '/work',
      args: ['add'],
      stdin,
      literalPathspecs: false,
      maxStdoutBytes: 10,
      timeoutMs: 50,
    });
    expect(seen[0]?.stdin).toBe(stdin);
    expect(seen[0]?.maxStdoutBytes).toBe(10);
    expect(seen[0]?.env).not.toHaveProperty('GIT_LITERAL_PATHSPECS');
  });
});
