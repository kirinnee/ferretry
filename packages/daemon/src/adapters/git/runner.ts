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

async function readCapped(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<CappedRead> {
  const chunks: Uint8Array[] = [];
  let keptBytes = 0;
  let truncated = false;
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      if (chunk.byteLength === 0) continue;
      const remaining = maxBytes - keptBytes;
      if (remaining <= 0) {
        truncated = true;
        continue;
      }
      const kept = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(kept);
      keptBytes += kept.byteLength;
      truncated ||= kept.byteLength < chunk.byteLength;
    }
  } finally {
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

function gitEnvironment(inherited: Readonly<Record<string, string | undefined>>): Record<string, string> {
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
    GIT_LITERAL_PATHSPECS: '1',
  };
}

export class BunGitRunner implements GitRunner {
  constructor(
    private readonly inheritedEnvironment: () => Readonly<Record<string, string | undefined>> = () => process.env,
  ) {}

  async run(invocation: GitInvocation): Promise<GitExecution> {
    const timeoutMs = checkedLimit(invocation.timeoutMs, DEFAULT_GIT_TIMEOUT_MS, 'Git timeout');
    const maxStdoutBytes = checkedLimit(
      invocation.maxStdoutBytes,
      DEFAULT_GIT_STDOUT_LIMIT,
      'Git stdout limit',
    );

    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn(['git', ...HARDENED_GIT_ARGUMENTS, ...invocation.args], {
        cwd: invocation.cwd,
        env: gitEnvironment(this.inheritedEnvironment()),
        stdin: invocation.stdin ? new Blob([invocation.stdin as unknown as BlobPart]) : 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (error) {
      throw new GitProcessError('spawn_failed', 'could not start Git', { cause: error });
    }

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        readCapped(child.stdout, maxStdoutBytes),
        readCapped(child.stderr, DEFAULT_GIT_STDERR_LIMIT),
      ]);
      return {
        exitCode,
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
