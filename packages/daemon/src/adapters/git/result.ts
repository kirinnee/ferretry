import type { GitExecution } from '../../lib/worktrees/ports.ts';

export class GitCommandError extends Error {
  constructor(
    readonly action: string,
    readonly execution: GitExecution,
  ) {
    const detail = execution.stderr.trim() || `exit ${execution.exitCode}`;
    const suffix = execution.stderrTruncated ? ' (stderr truncated)' : '';
    super(execution.timedOut ? `${action} timed out${suffix}` : `${action} failed: ${detail}${suffix}`);
    this.name = 'GitCommandError';
  }
}

export function requireGitExit(
  action: string,
  execution: GitExecution,
  acceptedExitCodes: readonly number[] = [0],
): GitExecution {
  if (execution.timedOut || !acceptedExitCodes.includes(execution.exitCode)) {
    throw new GitCommandError(action, execution);
  }
  return execution;
}

export function decodeGitOutput(execution: GitExecution): string {
  return new TextDecoder().decode(execution.stdout);
}

export function stripFinalLineFeed(value: string): string {
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}
