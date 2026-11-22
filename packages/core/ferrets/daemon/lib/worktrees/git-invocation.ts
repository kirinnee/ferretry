/**
 * How Ferrets runs Git (today's `adapters/git/runner.ts`, the pure half): the hardened arguments, the scrubbed
 * environment and the limits. The process itself is the kernel's (`kernel.spawn`); see `adapters/git/runner.ts`.
 */

export const DEFAULT_GIT_TIMEOUT_MS = 10_000;
export const DEFAULT_GIT_STDOUT_LIMIT = 1024 * 1024;
export const DEFAULT_GIT_STDERR_LIMIT = 64 * 1024;

// The hardened arguments and the scrubbed environment are owned by the shared tree index (`contract/tree-git.ts`,
// &F6061 U2): a ferret's file index and a project's must hold Git the same way, so there is one definition.
export { gitEnvironment, HARDENED_GIT_ARGUMENTS } from '../../../contract/tree-git.ts';

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
