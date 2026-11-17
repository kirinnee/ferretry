import type { FerretEndCause, RunnerExit } from '../../../contract/index.ts';

/** What a dead pane settles to: why the ferret ended, and the sentence its journal says. */
export interface ExitedEnd {
  readonly cause: FerretEndCause;
  /** Today's `session.exited` status: a clean exit is `stopped`, every other end `failed`. */
  readonly status: 'failed' | 'stopped';
  readonly reason: string;
}

/**
 * What an agent's pane that stayed dead means. THE CAUSE IS THE PROOF'S OWN WORDS: a signal is a `signal` (never an
 * invented exit code), a non-zero status is `agent_crashed`, status 0 is a `clean_exit` (the agent is done, so nothing
 * revives it) and a pane tmux recorded nothing for is `terminal_gone`, which is as far as the proof goes. The warden
 * and the auto-resume read the first, second and last as a death owed a revive; nobody's stop is ever one of them.
 * `lastLines` (already masked by the runner) rides on the cause and ends the reason, so every surface that says why
 * says what the harness said last.
 */
export function endOfExit(exit: RunnerExit): ExitedEnd {
  const lastLines = exit.lastLines === undefined ? {} : { lastLines: exit.lastLines };
  const said = exit.lastLines === undefined ? '' : `. Its last words: ${exit.lastLines}`;
  if (exit.signal !== undefined)
    return {
      cause: { kind: 'signal', signal: exit.signal, ...lastLines },
      status: 'failed',
      reason: `the agent was ended by signal ${exit.signal}${said}`,
    };
  if (exit.status === 0)
    return {
      cause: { kind: 'clean_exit' },
      status: 'stopped',
      reason: `the agent finished and exited (exit status 0)${said}`,
    };
  if (exit.status !== undefined)
    return {
      cause: { kind: 'agent_crashed', exitCode: exit.status, ...lastLines },
      status: 'failed',
      reason: `the agent exited with status ${exit.status}${said}`,
    };
  return {
    cause: { kind: 'terminal_gone', ...lastLines },
    status: 'failed',
    reason: `the agent exited on its own; how it exited was not recorded${said}`,
  };
}
