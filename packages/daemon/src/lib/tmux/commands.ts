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

export function sendLiteralArguments(session: string, text: string): readonly string[] {
  if (text.length === 0) throw new TmuxAddressError('literal text must not be empty');
  return ['send-keys', '-t', sessionTarget(session), '-l', text];
}

export function sendKeyArguments(session: string, key: string): readonly string[] {
  if (!/^[A-Za-z0-9+_-]+$/.test(key)) throw new TmuxAddressError('key must be a tmux key name');
  return ['send-keys', '-t', sessionTarget(session), key];
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
