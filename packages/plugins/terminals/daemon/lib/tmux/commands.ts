import { sessionTarget, TmuxAddressError } from './address.ts';
import type { TmuxLaunch } from './contracts.ts';
import { CONTROL_SUBSCRIPTION_NAMES } from './control-protocol.ts';

export const paneMetadataFormat =
  '#{pane_dead}|#{pane_dead_status}|#{cursor_x}|#{cursor_y}|#{pane_height}|#{pane_width}';

/**
 * Everything one turn-watch tick needs to know about a pane, in ONE question: what used to take a
 * `has-session` and a metadata `display-message`, plus the activity stamp that says whether the screen
 * has changed since it was last captured. A session that does not exist fails the question outright,
 * exactly as `has-session` did.
 */
export const paneActivityFormat = `${paneMetadataFormat}|#{window_activity}|#{history_size}|#{pane_id}|#{pane_pid}`;

export function paneActivityArguments(session: string): readonly string[] {
  return ['display-message', '-p', '-t', sessionTarget(session), paneActivityFormat];
}

/**
 * The active pane of every session's active window, in one listing: the pane `display-message -t
 * <session>` would have answered for, for every session at once.
 */
export const paneIdentityTableFormat = '#{session_name}\t#{window_active}#{pane_active}\t#{pane_id}\t#{pane_pid}';

export function paneIdentityTableArguments(): readonly string[] {
  return ['list-panes', '-a', '-F', paneIdentityTableFormat];
}

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

/**
 * Rows `first` to `last` of the visible screen, WITH attributes (`-e`). Rows are counted from the top
 * of the screen, 0-based, which is what `-S`/`-E` mean without `-` on a capture of the visible pane.
 */
export function captureRowsArguments(session: string, first: number, last: number): readonly string[] {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 0 || last < first)
    throw new TmuxAddressError('capture rows are not usable');
  return ['capture-pane', '-e', '-p', '-S', String(first), '-E', String(last), '-t', sessionTarget(session)];
}

export function paneMetadataArguments(session: string): readonly string[] {
  return ['display-message', '-p', '-t', sessionTarget(session), paneMetadataFormat];
}

export function paneIdentityArguments(session: string): readonly string[] {
  return ['display-message', '-p', '-t', sessionTarget(session), '#{pane_id} #{pane_pid}'];
}

/** A pane id, `%<n>` exactly: the last thing between a sweep and an arbitrary kill target. */
function paneIdTarget(paneId: string): string {
  if (!/^%(?:0|[1-9][0-9]*)$/u.test(paneId)) throw new TmuxAddressError('pane id is not usable');
  return paneId;
}

export function killPaneArguments(paneId: string): readonly string[] {
  return ['kill-pane', '-t', paneIdTarget(paneId)];
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

/** How a listing of attached clients is read: whether each is a control client, and its name. */
export const attachedClientFormat = '#{client_control_mode} #{client_name}';

/** The clients attached to `session`. */
export function sessionClientsArguments(session: string): readonly string[] {
  return ['list-clients', '-t', sessionTarget(session), '-F', attachedClientFormat];
}

/** The clients attached to the session holding the pane `paneId` — tmux resolves a pane id to its session. */
export function paneSessionClientsArguments(paneId: string): readonly string[] {
  return ['list-clients', '-t', paneIdTarget(paneId), '-F', attachedClientFormat];
}

/** A tmux client name this daemon will address: `client-<pid>` for a control client. */
const CLIENT_NAME = /^[A-Za-z0-9_./-]{1,128}$/u;

/** The control clients in a {@link attachedClientFormat} listing, by name; any other line is not one. */
export function parseControlClients(stdout: string): readonly string[] {
  const clients: string[] = [];
  for (const line of stdout.split('\n')) {
    const [mode, name, ...rest] = line.trim().split(' ');
    if (mode === '1' && name !== undefined && rest.length === 0 && CLIENT_NAME.test(name)) clients.push(name);
  }
  return clients;
}

/**
 * `kill`, preceded IN THE SAME COMMAND LIST by dropping every subscription each of `clients` may hold.
 *
 * WHY, AND WHY ONE LIST. tmux 3.6a crashes the WHOLE SERVER — every pane on it — when a control client
 * with a `refresh-client -B` subscription outlives its session: destroying the session leaves the client
 * with no session while it is still exiting, and its subscription timer, once a second, reads the
 * windows of that missing session (`control_check_subs_timer`, fixed in 3.7). A session worker's client
 * holds exactly such a subscription, so every `kill-session` of a session, and every `kill-pane` of its
 * last pane, could take the fleet down — it did on 29 and 30 October 2026. A client with no
 * subscription is safe, and tmux runs one command list in one turn, so no tick can fall between the
 * release and the kill. Dropping a subscription a client does not hold is a no-op.
 */
export function releasedKillArguments(clients: readonly string[], kill: readonly string[]): readonly string[] {
  const release = clients.flatMap(client => {
    if (!CLIENT_NAME.test(client)) throw new TmuxAddressError('client name is not usable');
    return CONTROL_SUBSCRIPTION_NAMES.flatMap(name => ['refresh-client', '-t', client, '-B', name, ';']);
  });
  return [...release, ...kill];
}
