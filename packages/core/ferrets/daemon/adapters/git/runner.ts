import { type Duration, milliseconds } from '@ferretry/std';
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
 * The byte-level spawn Git needs, named exactly as the kernel's `SpawnPort.runBytes` (kernel item O,
 * `rebuild/port-kernel` bdb8148f7): byte stdout capped at `maxStdoutBytes`, stderr capped, a `SIGKILL` at the
 * timeout that also stops reading, and a cwd that is a folder or a directory held open (`PinnedWorkingDirectory`).
 * The result is today's `GitExecution`, field for field the kernel's `SpawnBytesResult`.
 *
 * The one difference is the named cwd: the domain names a folder as a string, and the host maps it to the kernel's
 * `FencedPath` through `RootHandle.realPath` (kernel item N) when it binds this. The reading and killing code that
 * today lived here (`readCapped`, the timeout, the pin bracket) is the kernel adapter's, the only place allowed to
 * spawn (`banned-globals`).
 */
export interface GitByteSpawn {
  runBytes(
    program: 'git',
    args: readonly string[],
    options: {
      readonly cwd?: GitWorkingDirectory;
      readonly env?: Readonly<Record<string, string>>;
      readonly stdin?: string | Uint8Array;
      readonly timeout?: Duration;
      readonly maxStdoutBytes?: number;
      readonly maxStderrBytes?: number;
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
        timeout: milliseconds(timeoutMs),
        maxStdoutBytes,
        maxStderrBytes: DEFAULT_GIT_STDERR_LIMIT,
      });
    } catch (error) {
      if (error instanceof GitProcessError) throw error;
      throw new GitProcessError('spawn_failed', 'could not start Git', { cause: error });
    }
  }
}
