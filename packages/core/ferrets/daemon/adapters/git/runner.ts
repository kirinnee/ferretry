import type { GitExecution, GitInvocation, GitRunner, GitWorkingDirectory } from '../../lib/worktrees/ports.ts';
import {
  checkedLimit,
  DEFAULT_GIT_STDERR_LIMIT,
  DEFAULT_GIT_STDOUT_LIMIT,
  DEFAULT_GIT_TIMEOUT_MS,
  GitProcessError,
  gitEnvironment,
  HARDENED_GIT_ARGUMENTS,
} from '../../lib/worktrees/git-invocation.ts';

export {
  DEFAULT_GIT_STDERR_LIMIT,
  DEFAULT_GIT_STDOUT_LIMIT,
  DEFAULT_GIT_TIMEOUT_MS,
  GitProcessError,
} from '../../lib/worktrees/git-invocation.ts';

/**
 * The byte-level spawn Git needs: byte stdout capped at `maxStdoutBytes`, stderr capped, a kill at the timeout that
 * also stops reading (a grandchild holding the pipe must not hang the daemon), and a cwd that is either a name or a
 * directory held open (a pin). These are the `kernel.spawn` additions being made on `rebuild/port-kernel` (byte
 * stdout + maxStdoutBytes + pinned cwd); the host binds this to them when they land. Until then it is unwired, and
 * the reading/killing code that today lived here (`readCapped`, the timeout, the pin bracket) belongs to the kernel's
 * adapter, which is the only place allowed to spawn (`banned-globals`).
 */
export interface GitByteSpawn {
  runBytes(
    program: 'git',
    args: readonly string[],
    options: {
      readonly cwd: GitWorkingDirectory;
      readonly env: Readonly<Record<string, string>>;
      readonly stdin?: Uint8Array;
      readonly timeoutMs: number;
      readonly maxStdoutBytes: number;
      readonly maxStderrBytes: number;
    },
  ): Promise<GitExecution>;
}

/** Today's `BunGitRunner`, over the kernel's spawn: same hardened arguments, environment and limits. */
export class KernelGitRunner implements GitRunner {
  constructor(private readonly spawn: GitByteSpawn) {}

  async run(invocation: GitInvocation): Promise<GitExecution> {
    const timeoutMs = checkedLimit(invocation.timeoutMs, DEFAULT_GIT_TIMEOUT_MS, 'Git timeout');
    const maxStdoutBytes = checkedLimit(invocation.maxStdoutBytes, DEFAULT_GIT_STDOUT_LIMIT, 'Git stdout limit');
    try {
      return await this.spawn.runBytes('git', [...HARDENED_GIT_ARGUMENTS, ...invocation.args], {
        cwd: invocation.cwd,
        // The kernel's spawn starts from its own scrubbed base; nothing of the daemon's environment is inherited here.
        env: gitEnvironment({}, invocation.literalPathspecs ?? true),
        ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
        timeoutMs,
        maxStdoutBytes,
        maxStderrBytes: DEFAULT_GIT_STDERR_LIMIT,
      });
    } catch (error) {
      if (error instanceof GitProcessError) throw error;
      throw new GitProcessError('spawn_failed', 'could not start Git', { cause: error });
    }
  }
}
