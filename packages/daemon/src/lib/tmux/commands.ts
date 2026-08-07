import { sessionTarget, TmuxAddressError } from './address.ts';
import type { TmuxLaunch } from './contracts.ts';

export const paneMetadataFormat =
  '#{pane_dead}|#{pane_dead_status}|#{cursor_x}|#{cursor_y}|#{pane_height}|#{pane_width}';

export function hasSessionArguments(session: string): readonly string[] {
  return ['has-session', '-t', sessionTarget(session)];
}

export function listSessionsArguments(): readonly string[] {
  return ['list-sessions', '-F', '#{session_name}'];
}

export function capturePaneArguments(session: string, history: boolean): readonly string[] {
  return history
    ? ['capture-pane', '-p', '-S', '-', '-t', sessionTarget(session)]
    : ['capture-pane', '-p', '-t', sessionTarget(session)];
}

export function paneMetadataArguments(session: string): readonly string[] {
  return ['display-message', '-p', '-t', sessionTarget(session), paneMetadataFormat];
}

export function panePidArguments(session: string): readonly string[] {
  return ['display-message', '-p', '-t', sessionTarget(session), '#{pane_pid}'];
}

export function paneIdentityArguments(session: string): readonly string[] {
  return ['display-message', '-p', '-t', sessionTarget(session), '#{pane_id}\t#{pane_pid}'];
}

export function killPaneArguments(paneId: string): readonly string[] {
  if (!/^%(?:0|[1-9][0-9]*)$/u.test(paneId)) throw new TmuxAddressError('pane id is not usable');
  return ['kill-pane', '-t', paneId];
}

export function sendLiteralArguments(session: string, text: string): readonly string[] {
  if (text.length === 0) throw new TmuxAddressError('literal text must not be empty');
  return ['send-keys', '-t', sessionTarget(session), '-l', text];
}

export function sendKeyArguments(session: string, key: string): readonly string[] {
  if (!/^[A-Za-z0-9+_-]+$/.test(key)) throw new TmuxAddressError('key must be a tmux key name');
  return ['send-keys', '-t', sessionTarget(session), key];
}

/**
 * The paste buffer one session's deliveries use.
 *
 * Derived from the session name rather than randomised so that a crashed delivery leaves at most one
 * stale buffer per session instead of one per attempt — a tmux buffer holds the payload in the
 * server's memory, and a turn brief is not something to leave lying there.
 */
export function pasteBufferName(session: string): string {
  return `fy-paste-${sessionTarget(session)}`;
}

/**
 * Load a payload into that buffer from stdin.
 *
 * Stdin, not an argument: a turn brief is far past any argv limit, and a value on the command line
 * would be visible in `/proc` to every user on the box.
 */
export function loadBufferArguments(session: string): readonly string[] {
  return ['load-buffer', '-b', pasteBufferName(session), '-'];
}

/**
 * Paste it into the pane as ONE bracketed-paste event (`-p`), deleting the buffer afterwards (`-d`).
 *
 * Bracketed paste is what tells the TUI these characters are data rather than typing, so a payload
 * containing a newline arrives as one message instead of submitting itself half-written.
 */
export function pasteBufferArguments(session: string): readonly string[] {
  return ['paste-buffer', '-p', '-d', '-b', pasteBufferName(session), '-t', sessionTarget(session)];
}

/** Drop the buffer when a paste never happened, so a failed delivery leaves no payload behind. */
export function deleteBufferArguments(session: string): readonly string[] {
  return ['delete-buffer', '-b', pasteBufferName(session)];
}

/**
 * A POSIX environment name. The bound is what keeps `-e NAME=VALUE` unambiguous: tmux splits that
 * argument on the FIRST `=`, so a name containing one would silently rename the variable and hand
 * the program a value it never asked for — and a per-session secret delivered under the wrong name
 * is a secret the agent cannot read and an operator cannot see is missing.
 */
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Turns one environment entry into the `-e` argument pair tmux accepts.
 *
 * A NUL cannot cross an `execve` boundary at all and a newline would end the argument early, so both
 * are refused here rather than truncating the value on its way to the pane. The value is otherwise
 * passed through verbatim: it never reaches a shell, so quoting and expansion are not in play.
 */
function environmentArgument(name: string, value: string): readonly string[] {
  if (!ENVIRONMENT_NAME.test(name)) throw new TmuxAddressError(`environment name is not usable: ${name}`);
  if (value.includes('\0') || value.includes('\n'))
    throw new TmuxAddressError(`environment value for ${name} may not contain a newline or NUL`);
  return ['-e', `${name}=${value}`];
}

export function newSessionArguments(launch: TmuxLaunch): readonly string[] {
  const args = ['new-session', '-d', '-s', sessionTarget(launch.session), '-c', launch.cwd];
  if (launch.width !== undefined) args.push('-x', String(launch.width));
  if (launch.height !== undefined) args.push('-y', String(launch.height));
  // Sorted so one launch produces one argv: the caller hands over a record, and an argv that
  // depends on its key insertion order is an argv no test can pin and no operator can compare.
  for (const name of Object.keys(launch.env ?? {}).sort())
    args.push(...environmentArgument(name, (launch.env ?? {})[name] ?? ''));
  return [...args, ...launch.command];
}

export function remainOnExitArguments(session: string): readonly string[] {
  return ['set-option', '-t', sessionTarget(session), 'remain-on-exit', 'on'];
}

export function killSessionArguments(session: string): readonly string[] {
  return ['kill-session', '-t', sessionTarget(session)];
}
