/**
 * How Ferrets runs Git (today's `adapters/git/runner.ts`, the pure half): the hardened arguments, the scrubbed
 * environment and the limits. The process itself is the kernel's (`kernel.spawn`); see `adapters/git/runner.ts`.
 */

export const DEFAULT_GIT_TIMEOUT_MS = 10_000;
export const DEFAULT_GIT_STDOUT_LIMIT = 1024 * 1024;
export const DEFAULT_GIT_STDERR_LIMIT = 64 * 1024;

export const HARDENED_GIT_ARGUMENTS: readonly string[] = [
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

export function checkedLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new GitProcessError('invalid_limit', `${label} must be a non-negative safe integer`);
  }
  return limit;
}

export function gitEnvironment(
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
