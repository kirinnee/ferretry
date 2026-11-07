import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { type GitByteSpawn, KernelGitRunner } from '../../../daemon/adapters/git/runner.ts';
import {
  DEFAULT_GIT_STDERR_LIMIT,
  DEFAULT_GIT_STDOUT_LIMIT,
  DEFAULT_GIT_TIMEOUT_MS,
  GitProcessError,
} from '../../../daemon/lib/worktrees/git-invocation.ts';
import type {
  GitExecution,
  PinnedWorkingDirectory,
  WorktreeFileSystem,
  WorktreeFileType,
} from '../../../daemon/lib/worktrees/ports.ts';

/**
 * The host IO the worktree and file-browser code needs, as TESTS provide it: today's `BunGitRunner` process code
 * (capped reads, the kill at the timeout, the pin bracket) and today's `NodeWorktreeFileSystem`. In the product the
 * kernel provides both (`kernel.spawn` byte stdout + maxStdoutBytes + pinned cwd, and the `RootHandle` additions on
 * `rebuild/port-kernel`); tests are exempt from `banned-globals` and drive real Git and a real disk through these.
 */

interface CappedRead {
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
}

const ABANDONED = Symbol('abandoned');

/**
 * Reads at most `maxBytes`, and stops the moment `abandoned` settles. Without that escape a
 * grandchild process inheriting the pipe would keep the stream open forever, so the daemon would
 * hang past its own timeout even though the Git process itself was already killed.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  abandoned: Promise<typeof ABANDONED>,
): Promise<CappedRead> {
  const chunks: Uint8Array[] = [];
  let keptBytes = 0;
  let truncated = false;
  let abandonedRead = false;
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await Promise.race([reader.read(), abandoned]);
      if (result === ABANDONED) {
        abandonedRead = true;
        break;
      }
      if (result.done) break;
      const chunk = result.value;
      // `remaining` is never negative, so an empty chunk arriving after the cap keeps `kept` empty
      // and must NOT be reported as a truncation.
      const remaining = maxBytes - keptBytes;
      const kept = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(kept);
      keptBytes += kept.byteLength;
      truncated ||= kept.byteLength < chunk.byteLength;
    }
  } finally {
    if (abandonedRead) await reader.cancel();
    reader.releaseLock();
  }

  const bytes = new Uint8Array(keptBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

async function checkWorkingDirectory(cwd: string): Promise<void> {
  try {
    if (!(await stat(cwd)).isDirectory()) {
      throw new Error('Git working directory is not a directory');
    }
  } catch (error) {
    throw new GitProcessError('spawn_failed', 'could not start Git', { cause: error });
  }
}

/** Today's `BunGitRunner` process half: the arguments and environment arrive already hardened. */
export class BunGitByteSpawn implements GitByteSpawn {
  constructor(
    private readonly inheritedEnvironment: () => Readonly<Record<string, string | undefined>> = () => process.env,
  ) {}

  async runBytes(
    program: 'git',
    args: readonly string[],
    options: Parameters<GitByteSpawn['runBytes']>[2],
  ): Promise<GitExecution> {
    const cwd = options.cwd ?? '.';
    const named: string | undefined = typeof cwd === 'string' ? cwd : undefined;
    const pinned: PinnedWorkingDirectory | undefined = typeof cwd === 'string' ? undefined : cwd;
    if (named !== undefined) await checkWorkingDirectory(named);
    const inherited: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.inheritedEnvironment()))
      if (!key.startsWith('GIT_') && value !== undefined) inherited[key] = value;

    let child: Bun.Subprocess<'ignore' | Blob, 'pipe', 'pipe'>;
    const release = pinned?.install();
    try {
      child = Bun.spawn([program, ...args], {
        cwd: named ?? '.',
        env: { ...inherited, ...options.env },
        stdin: options.stdin ? new Blob([options.stdin]) : 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (error) {
      throw new GitProcessError('spawn_failed', 'could not start Git', { cause: error });
    } finally {
      release?.();
    }

    let timedOut = false;
    const abandoned = Promise.withResolvers<typeof ABANDONED>();
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      abandoned.resolve(ABANDONED);
    }, options.timeout ?? DEFAULT_GIT_TIMEOUT_MS);

    try {
      const [exitResult, stdout, stderr] = await Promise.all([
        Promise.race([child.exited, abandoned.promise]),
        readCapped(child.stdout, options.maxStdoutBytes ?? DEFAULT_GIT_STDOUT_LIMIT, abandoned.promise),
        readCapped(child.stderr, options.maxStderrBytes ?? DEFAULT_GIT_STDERR_LIMIT, abandoned.promise),
      ]);
      return {
        exitCode: exitResult === ABANDONED ? -1 : exitResult,
        stdout: stdout.bytes,
        stderr: new TextDecoder().decode(stderr.bytes),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class NodeWorktreeFileSystem implements WorktreeFileSystem {
  async makeDirectory(target: string, mode: number): Promise<void> {
    await mkdir(target, { recursive: true, mode });
  }

  async realPath(target: string): Promise<string> {
    return await realpath(target);
  }

  async type(target: string): Promise<WorktreeFileType> {
    try {
      const stats = await lstat(target);
      if (stats.isDirectory()) return 'directory';
      if (stats.isFile()) return 'file';
      if (stats.isSymbolicLink()) return 'symlink';
      return 'other';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
  }

  async readText(target: string): Promise<string> {
    return await readFile(target, 'utf8');
  }

  async writeText(target: string, content: string, mode: number): Promise<void> {
    await writeFile(target, content, { encoding: 'utf8', mode, flag: 'wx' });
  }
}

/** Today's `new BunGitRunner(env)`: the product's runner over the test spawn. */
export function testGitRunner(
  inheritedEnvironment?: () => Readonly<Record<string, string | undefined>>,
): KernelGitRunner {
  return new KernelGitRunner(new BunGitByteSpawn(inheritedEnvironment));
}

/** Today's `SystemWorktreeClock`, for tests that drive real Git (the product's is `KernelWorktreeClock`). */
export class TestWorktreeClock {
  nowIso(): string {
    return new Date().toISOString();
  }
}
