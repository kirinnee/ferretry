import type { RegisteredTerminalPane } from '../reap.ts';

/**
 * What a session becomes once its registered pane has been PROVEN not to hold a running agent.
 *
 * The self-check is the only loop this daemon runs over every session, and it had nothing to say
 * about a pane after launch: its one repair for an unwatched live session is starting a monitor,
 * and this daemon runs none. So a harness that exited — finished, crashed or closed by a human —
 * left its session reading `running` for as long as the daemon lived, while attach and snapshot
 * already refused it for having no live pane. The list was the one surface that lied.
 *
 * THIS IS A DECISION, NOT AN OBSERVATION. The adapter proves the pane is dead or gone against the
 * durable registration and hands over only that proof; everything here is what the proof means.
 * Nothing in this slice kills or launches anything, so a verdict can cost nothing but a write.
 */

/** How the registered pane was proven not to be running. */
export type SessionPaneExit =
  /**
   * tmux kept the pane after its program ended. `exitStatus` is `pane_dead_status`, set when the
   * program exited; `signal` is `pane_dead_signal`, set INSTEAD when a signal ended it.
   */
  | { readonly kind: 'exited'; readonly exitStatus?: number | undefined; readonly signal?: number | undefined }
  /** tmux no longer has the pane's session at all, so how the program ended was never recorded. */
  | { readonly kind: 'gone' };

/** A session whose registered pane is not running, as the adapter proved it. */
export interface SessionExitObservation {
  readonly id: string;
  /** The status the session was read with; the settle refuses if it has moved since. */
  readonly status: string;
  /** The registration the pane was proven against; the settle refuses if it was replaced since. */
  readonly registration: RegisteredTerminalPane;
  readonly exit: SessionPaneExit;
}

/** The terminal record an exited session is given. */
export interface ExitedSessionTransition {
  readonly status: 'completed' | 'failed';
  readonly health: 'idle' | 'crashed' | 'unknown';
  readonly reason: string;
  /** Only when tmux kept one: an unknown exit is never written as a number. */
  readonly exitCode?: number | undefined;
}

/**
 * The statuses that claim an agent is running in the pane right now.
 *
 * Deliberately NOT the complement of the terminal set. `created` and `starting` have no pane yet or
 * are mid-launch; `retrying` and `rate_limited` are the daemon deliberately between panes; and
 * `kill_failed` is a stop that could not finish, whose own remedy is to try the stop again. Each of
 * those already says something true that "it exited" would overwrite.
 */
const RUNNING_STATUSES: ReadonlySet<string> = new Set([
  'running',
  'thinking',
  'tool_running',
  'awaiting_question',
  'awaiting_user',
  'interrupted',
  'waiting',
]);

/** Whether a session's status claims a live agent, which is the only claim a dead pane refutes. */
export function claimsRunningAgent(status: string | undefined): boolean {
  return status !== undefined && RUNNING_STATUSES.has(status);
}

function exitReason(exit: SessionPaneExit): string {
  if (exit.kind === 'gone')
    return 'the agent is no longer running: its terminal is gone, so how it exited was not recorded';
  if (exit.exitStatus !== undefined) return `the agent exited on its own (exit status ${exit.exitStatus})`;
  return exit.signal === undefined
    ? 'the agent exited on its own; how it exited was not recorded'
    : `the agent was ended by signal ${exit.signal}`;
}

/**
 * The record an exited session gets, or `undefined` when its status no longer claims an agent.
 *
 * TWO EXISTING TERMINAL STATUSES, NOT A NEW ONE. `failed` and `completed` are what every surface —
 * the list, the resume policy, the reap, the warden — already treats as over, and a third terminal
 * spelling would be one each of them could forget. What says EXITED rather than stopped is the
 * reason, the journal event and the recorded exit status; `stopped` stays the human's own verb.
 *
 * EXIT STATUS 0 IS FINISHED, IN EITHER MODE. Nothing in the session contract says a harness must
 * never leave on its own, so a clean exit is read as the agent being done rather than as a crash.
 * A non-zero status failed and says so with the number, and so does a signal — as the signal, never
 * as an invented exit code. An exit nobody recorded — tmux kept no
 * status, or the terminal is gone entirely — fails too, because the session is over and success
 * cannot be claimed without evidence, but its health is `unknown` rather than `crashed`: nothing
 * observed a crash either.
 */
export function exitedSessionTransition(observation: SessionExitObservation): ExitedSessionTransition | undefined {
  if (!claimsRunningAgent(observation.status)) return undefined;
  const exitCode = observation.exit.kind === 'exited' ? observation.exit.exitStatus : undefined;
  const reason = exitReason(observation.exit);
  if (exitCode === undefined) {
    const signalled = observation.exit.kind === 'exited' && observation.exit.signal !== undefined;
    return { status: 'failed', health: signalled ? 'crashed' : 'unknown', reason };
  }
  return exitCode === 0
    ? { status: 'completed', health: 'idle', reason, exitCode }
    : { status: 'failed', health: 'crashed', reason, exitCode };
}
