/**
 * tmux CONTROL MODE (`tmux -C`), as the pure half of one long-lived client.
 *
 * WHY IT EXISTS. Every question this daemon asked tmux used to be a process: fork, exec, link tmux's
 * libraries, connect, ask, exit. A live fleet of forty sessions asked about twenty a second, and on a
 * Mac each one is an exec the endpoint-security agent inspects. A control-mode client is ONE child that
 * stays connected: a command is a line written to its stdin and its answer a block on its stdout, so a
 * question costs a pipe write instead of a fork and an exec.
 *
 * WHAT TMUX WRITES. A reply is framed `%begin <time> <number> <flags>`, the command's output lines, then
 * `%end` or `%error` with the same three fields. Between blocks tmux writes notifications — one line
 * each, starting with `%` (`%sessions-changed`, `%output %3 …`, `%exit`, …). tmux never writes a
 * notification inside a block.
 *
 * WHY EVERY COMMAND IS FOLLOWED BY A NONCE. tmux does NOT escape command output: a `capture-pane` reply
 * is the pane's text verbatim, and a pane can print `%end 1792626406 289 1` as easily as anything else.
 * A parser that ended a block at the first terminator-shaped line would let any agent truncate its own
 * capture, and inject what followed into the next reply. So each command is sent as TWO lines — the
 * command, then `display-message -p <nonce>` with a fresh unguessable nonce no pane ever shows — and a
 * reply is complete only when the nonce's own block arrives. The command's real terminator is then the
 * LAST line before that block's `%begin`, whatever terminator-shaped text came earlier, and everything
 * between the first `%begin` and it is the command's output, byte for byte.
 */

/** One `%begin` / `%end` / `%error` line. */
export interface ControlGuard {
  readonly edge: 'begin' | 'end' | 'error';
  /** `<time> <number>`: what pairs a terminator with its `%begin`. */
  readonly key: string;
  /** `1` for a command this client sent, `0` for one tmux ran on its behalf (the attach itself). */
  readonly flags: string;
}

const GUARD = /^%(begin|end|error) (\d+ \d+) (\d+)$/u;

/** The guard a line is, or `undefined` for any other line. */
export function parseControlGuard(line: string): ControlGuard | undefined {
  const match = GUARD.exec(line);
  if (match === null) return undefined;
  return { edge: match[1] as ControlGuard['edge'], key: match[2] as string, flags: match[3] as string };
}

/**
 * A notification, typed for the ones a watcher acts on and kept by name for the rest.
 *
 * Every id is tmux's own: `$n` a session, `@n` a window, `%n` a pane. They are what routing keys on —
 * a pane id outlives a rename, and a session NAME is reused by the next session given it.
 */
export type TmuxControlNotification =
  /**
   * Bytes a pane wrote, decoded from tmux's octal escapes. Only for panes in the attached session.
   * `%extended-output` — what a client attached with `pause-after` receives instead — arrives as this too.
   *
   * tmux (3.6a) has NO pane-exited notification: a pane kept by `remain-on-exit` dies silently, and a
   * watcher learns of it from a `refresh-client -B` subscription on `#{pane_dead}`.
   */
  | { readonly kind: 'output'; readonly paneId: string; readonly data: string }
  /** A session was created or destroyed anywhere on the server. */
  | { readonly kind: 'sessions-changed' }
  /** The client is now attached to this session. */
  | { readonly kind: 'session-changed'; readonly sessionId: string; readonly name: string }
  /** A window closed: in the attached session, or (`unlinked`) in any other. */
  | { readonly kind: 'window-close'; readonly windowId: string; readonly unlinked: boolean }
  | { readonly kind: 'pane-mode-changed'; readonly paneId: string }
  /** A `refresh-client -B` subscription's value changed for one pane. */
  | {
      readonly kind: 'subscription-changed';
      readonly name: string;
      readonly sessionId: string;
      readonly windowId: string;
      readonly paneId: string;
      readonly value: string;
    }
  /** The client is leaving: the server is going away, or its session was destroyed. */
  | { readonly kind: 'exit'; readonly reason?: string }
  | { readonly kind: 'other'; readonly name: string; readonly text: string };

/**
 * Decode `%output` data: tmux writes every byte below space, and the backslash, as `\ooo`.
 * An escape that is not three octal digits is left as it is rather than guessed at.
 */
export function decodeControlOutput(escaped: string): string {
  return escaped.replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** `%extended-output %pane <age-ms> … : <data>`: the payload follows the first ` : `. */
const EXTENDED_OUTPUT = /^(%\d+) \d+(?: [^:]*?)? : (.*)$/su;

const SUBSCRIPTION = /^(\S+) (\$\d+) (@\d+) \d+ (%\d+)(?: .*?)? : (.*)$/su;

/** The notification one line outside a block is, or `undefined` for a line that is not one. */
export function parseControlNotification(line: string): TmuxControlNotification | undefined {
  if (!line.startsWith('%') || parseControlGuard(line) !== undefined) return undefined;
  const space = line.indexOf(' ');
  const name = space === -1 ? line.slice(1) : line.slice(1, space);
  const text = space === -1 ? '' : line.slice(space + 1);
  if (name === '') return undefined;
  // The first word is the id the notification is about; the rest, when there is any, its payload.
  const id = text.split(' ', 1)[0] as string;
  const rest = text.slice(id.length + 1);
  if (name === 'output' && /^%\d+$/u.test(id)) return { kind: 'output', paneId: id, data: decodeControlOutput(rest) };
  if (name === 'extended-output') {
    const match = EXTENDED_OUTPUT.exec(text);
    if (match !== null)
      return { kind: 'output', paneId: match[1] as string, data: decodeControlOutput(match[2] as string) };
  }
  if (name === 'sessions-changed') return { kind: 'sessions-changed' };
  if (name === 'session-changed' && /^\$\d+$/u.test(id)) return { kind: 'session-changed', sessionId: id, name: rest };
  if ((name === 'window-close' || name === 'unlinked-window-close') && /^@\d+$/u.test(id))
    return { kind: 'window-close', windowId: id, unlinked: name === 'unlinked-window-close' };
  if (name === 'pane-mode-changed' && /^%\d+$/u.test(id)) return { kind: 'pane-mode-changed', paneId: id };
  if (name === 'subscription-changed') {
    const match = SUBSCRIPTION.exec(text);
    if (match !== null)
      return {
        kind: 'subscription-changed',
        name: match[1] as string,
        sessionId: match[2] as string,
        windowId: match[3] as string,
        paneId: match[4] as string,
        value: match[5] as string,
      };
  }
  if (name === 'exit') return text === '' ? { kind: 'exit' } : { kind: 'exit', reason: text };
  return { kind: 'other', name, text };
}

/**
 * The commands a control client may carry: questions only.
 *
 * Anything that changes the server — a key sent, a session created or killed, a buffer loaded — keeps
 * its own child. A control client that lost its connection mid-command cannot say whether tmux ran
 * it, and a READ asked again is harmless where a `send-keys` typed twice is not; so every command here
 * can be retried on the spawn path without anyone being able to tell. `display-message` and
 * `capture-pane` count only with `-p`: without it they write to a client or a buffer instead of answering.
 */
const READS: ReadonlySet<string> = new Set(['has-session', 'list-sessions', 'list-panes', 'list-windows']);
const PRINTING_READS: ReadonlySet<string> = new Set(['display-message', 'capture-pane']);

/** Quote one argument for tmux's command parser: single quotes are literal, so only `'` needs care. */
function quoteArgument(argument: string): string {
  return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

/**
 * The control-mode line for an argv, or `undefined` when the command must keep its own child.
 *
 * Refused: anything that is not a read, and any argument a line cannot carry exactly. A newline or
 * NUL would end or corrupt the line; an argument ending in `;` is a command SEPARATOR on tmux's argv
 * but a literal inside quotes, so the two paths would run different commands. Every other byte is
 * passed through single quotes, which tmux takes literally — no `$` or `~` expansion, no `#` comment,
 * no `;` split — and was measured to reach the command byte-identical to the spawned argv.
 */
export function controlCommandLine(arguments_: readonly string[]): string | undefined {
  const [command, ...rest] = arguments_;
  if (command === undefined) return undefined;
  if (!READS.has(command) && !(PRINTING_READS.has(command) && rest.includes('-p'))) return undefined;
  if (arguments_.some(argument => /[\n\r\0]/u.test(argument) || argument.endsWith(';'))) return undefined;
  return [command, ...rest.map(quoteArgument)].join(' ');
}

/** The line that follows every command: its answer is the only proof the command's reply is over. */
export function controlNonceLine(nonce: string): string {
  if (!/^[A-Za-z0-9]{16,}$/u.test(nonce)) throw new Error('a control nonce must be at least 16 letters or digits');
  return `display-message -p ${nonce}`;
}

/** One command's answer, in the shape a spawned tmux would have given it. */
export interface ControlReply {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Where a reply being collected stands after its latest line.
 *
 * `pending` — keep collecting. `complete` — the command's reply, with `closing` the key of the nonce's
 * block whose `%end` is still to come. `violation` — the stream is not what tmux writes, and nothing
 * already read from it can be trusted.
 */
export type ControlReplyProgress =
  | { readonly kind: 'pending' }
  | { readonly kind: 'complete'; readonly reply: ControlReply; readonly closing: string }
  | { readonly kind: 'violation'; readonly reason: string };

const lines = (values: readonly string[]): string => (values.length === 0 ? '' : `${values.join('\n')}\n`);

/**
 * Judge the lines collected since a reply's `%begin`, given the nonce that follows it.
 *
 * Constant time per call — only the tail and the head are read — so it can be asked after every line
 * of a capture tens of thousands of lines long.
 */
export function controlReplyProgress(collected: readonly string[], nonce: string): ControlReplyProgress {
  const count = collected.length;
  if (count < 4 || collected[count - 1] !== nonce) return { kind: 'pending' };
  const nonceBegin = parseControlGuard(collected[count - 2] as string);
  if (nonceBegin?.edge !== 'begin') return { kind: 'pending' };
  const begin = parseControlGuard(collected[0] as string);
  const terminator = parseControlGuard(collected[count - 3] as string);
  if (
    begin?.edge !== 'begin' ||
    terminator === undefined ||
    terminator.edge === 'begin' ||
    terminator.key !== begin.key
  )
    return { kind: 'violation', reason: 'a reply was not framed by its own %begin and terminator' };
  const output = collected.slice(1, count - 3);
  const reply =
    terminator.edge === 'end'
      ? { code: 0, stdout: lines(output), stderr: '' }
      : { code: 1, stdout: '', stderr: lines(spawnedErrorText(output)) };
  return { kind: 'complete', reply, closing: nonceBegin.key };
}

const PARSE_ERROR = 'parse error: ';

/**
 * An error as a spawned tmux prints it. The one difference measured between the two paths: a command
 * tmux could not PARSE is reported `parse error: command list-panes: unknown flag -Z` over control mode
 * and without the prefix on stderr.
 */
function spawnedErrorText(output: readonly string[]): readonly string[] {
  const [first, ...rest] = output;
  return first?.startsWith(PARSE_ERROR) === true ? [first.slice(PARSE_ERROR.length), ...rest] : output;
}

/** A session name a control client may attach to: the same alphabet `sessionTarget` admits. */
const ATTACHABLE = /^[a-z0-9][a-z0-9_.-]{0,127}$/u;

/** Whether a control client may attach to the session `name`. */
export const isControlAttachable = (name: string): boolean => ATTACHABLE.test(name);

const SUBSCRIPTION_NAME = /^[a-z][a-z0-9-]{0,31}$/u;

/**
 * The `refresh-client -B` line that subscribes THIS client to `format` for every pane of its session:
 * tmux then writes `%subscription-changed <name> …` whenever the value changes, checked once a second.
 *
 * A CLIENT command, not a server mutation: it changes only what this client is told, which is why a
 * client that refuses every mutation may still send it. The format is single-quoted — `#` would otherwise
 * start a comment in tmux's command parser — and refused when it holds a line break or a quote it could
 * not carry exactly.
 */
export function controlSubscriptionLine(name: string, format: string): string | undefined {
  if (!SUBSCRIPTION_NAME.test(name) || /[\n\r\0']/u.test(format)) return undefined;
  return `refresh-client -B '${name}:%*:${format}'`;
}

/** What a session worker watches each pane for: whether it died, and when its window last drew. */
export const PANE_WATCH_FORMAT = '#{pane_dead} #{window_activity}';

/** The value of a {@link PANE_WATCH_FORMAT} subscription, read; `undefined` for one that is not. */
export function parsePaneWatch(value: string): { readonly dead: boolean; readonly activityAt: number } | undefined {
  const match = /^([01]) (\d+)$/u.exec(value.trim());
  return match === null ? undefined : { dead: match[1] === '1', activityAt: Number(match[2]) };
}
