import { stat } from 'node:fs/promises';
import type { GitExecution, GitInvocation, GitRunner } from '../../lib/worktrees/ports.ts';

export const DEFAULT_GIT_TIMEOUT_MS = 10_000;
export const DEFAULT_GIT_STDOUT_LIMIT = 1024 * 1024;
export const DEFAULT_GIT_STDERR_LIMIT = 64 * 1024;

const HARDENED_GIT_ARGUMENTS: readonly string[] = [
  '--no-optional-locks',
  '-c',
  'core.pager=cat',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotepath=false',
  '-c',
  'diff.external=',
  // Porcelain paths must stay repo-root-relative whatever a repo-local `status.relativePaths=true` says,
  // because that is the shape the status parser filters by prefix. And `showUntrackedFiles=all` is pinned
  // because a repo-local or global `no` would otherwise hide every untracked file from a Changes list.
  '-c',
  'status.relativePaths=false',
  '-c',
  'status.showUntrackedFiles=all',
] as const;

export class GitProcessError extends Error {
  constructor(
    readonly code: 'invalid_limit' | 'spawn_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GitProcessError';
  }
}

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

function checkedLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new GitProcessError('invalid_limit', `${label} must be a non-negative safe integer`);
  }
  return limit;
}

function gitEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  literalPathspecs: boolean,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (!key.startsWith('GIT_') && value !== undefined) environment[key] = value;
  }
  return {
    ...environment,
    LC_ALL: 'C',
    LANG: 'C',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_ASKPASS: '',
    ...(literalPathspecs ? { GIT_LITERAL_PATHSPECS: '1' } : {}),
  };
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

export class BunGitRunner implements GitRunner {
  constructor(
    private readonly inheritedEnvironment: () => Readonly<Record<string, string | undefined>> = () => process.env,
  ) {}

  async run(invocation: GitInvocation): Promise<GitExecution> {
    const timeoutMs = checkedLimit(invocation.timeoutMs, DEFAULT_GIT_TIMEOUT_MS, 'Git timeout');
    const maxStdoutBytes = checkedLimit(invocation.maxStdoutBytes, DEFAULT_GIT_STDOUT_LIMIT, 'Git stdout limit');

    await checkWorkingDirectory(invocation.cwd);

    // Git is given stdin only when the caller has bytes for it. Every command this daemon runs is
    // non-interactive, so an open stdin with nothing written could only ever hang the daemon on a prompt —
    // a supplied buffer is closed by the runtime once written, which is a different thing.
    let child: Bun.Subprocess<'ignore' | Blob, 'pipe', 'pipe'>;
    try {
      child = Bun.spawn(['git', ...HARDENED_GIT_ARGUMENTS, ...invocation.args], {
        cwd: invocation.cwd,
        env: gitEnvironment(this.inheritedEnvironment(), invocation.literalPathspecs ?? true),
        stdin: invocation.stdin ? new Blob([invocation.stdin]) : 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (error) {
      throw new GitProcessError('spawn_failed', 'could not start Git', { cause: error });
    }

    let timedOut = false;
    const abandoned = Promise.withResolvers<typeof ABANDONED>();
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      abandoned.resolve(ABANDONED);
    }, timeoutMs);

    try {
      const [exitResult, stdout, stderr] = await Promise.all([
        Promise.race([child.exited, abandoned.promise]),
        readCapped(child.stdout, maxStdoutBytes, abandoned.promise),
        readCapped(child.stderr, DEFAULT_GIT_STDERR_LIMIT, abandoned.promise),
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
