/**
 * TMUX COMMANDS THAT CARRY A PAYLOAD TRAVEL ON STDIN, NEVER IN ARGV.
 *
 * Every argument of a spawned `tmux` is in that process's `/proc/<pid>/cmdline`, and every account on
 * the host can read it. Some arguments are payloads rather than addresses: a pane's environment (`-e
 * NAME=VALUE` — the session's own board credential, a profile's provider key, an MCP access token) and
 * the bytes typed into a pane (`send-keys`, including a password typed after `terminal_ask_owner`). The
 * client is short-lived, but a process watcher catches it — and the client that starts the server is
 * worse: the server forks from it and keeps that argv for its whole life, so the FIRST session's
 * credential stayed readable for as long as the server ran.
 *
 * So such a command is written to `tmux source-file -` as one line of tmux's own command language, and
 * argv holds only `source-file -` (prefixed by `start-server ;` for `new-session`, which is how a server
 * is born with a clean argv). The line is quoted so that tmux parses it into exactly the argument vector
 * the argv path would have passed: each argument in single quotes, where tmux performs no `$`/`~`
 * expansion, no `#` comment and no `;` split, with a `'` written as `'"'"'` and a newline or carriage
 * return as a `"\n"`/`"\r"` segment — tmux joins adjacent quoted pieces into one argument. Measured
 * against tmux 3.6a: values with `$HOME`, quotes, backslashes, `#{…}`, `~`, `;`, newlines, unicode and
 * the empty string reach the pane byte-identical to the argv path.
 *
 * TWO DELIBERATE DIFFERENCES from argv. A lone `;` argument is still tmux's command separator and is
 * written bare. An argument that merely ENDS in `;` is carried literally, where argv would have split
 * the command there and silently dropped the `;` — `send-keys -l 'ls;'` now types the `;` it was asked to.
 */

/** Whether this command's arguments carry a payload that must not appear in a process listing. */
export function carriesPayload(arguments_: readonly string[]): boolean {
  const [command, ...rest] = arguments_;
  if (command === 'send-keys') return true;
  // `-F` is the guarded write: its branch is a `send-keys` carrying the value (docs/input-requests.md).
  if (command === 'if-shell') return rest.includes('-F');
  return command === 'new-session' && rest.includes('-e');
}

/**
 * The argv that runs a script from stdin. `new-session` may be the command that starts the server, so
 * it asks for one first; everything else needs a server already, and fails as it always did without one.
 */
export function scriptArguments(arguments_: readonly string[]): readonly string[] {
  return arguments_[0] === 'new-session' ? ['start-server', ';', 'source-file', '-'] : ['source-file', '-'];
}

/** The command as one line of tmux's command language, parsing back to exactly these arguments. */
export function scriptLine(arguments_: readonly string[]): string {
  if (arguments_.some(argument => argument.includes('\0'))) throw new Error('a tmux argument cannot carry a NUL byte');
  return `${arguments_.map(argument => (argument === ';' ? ';' : quoteScriptArgument(argument))).join(' ')}\n`;
}

function quoteScriptArgument(argument: string): string {
  if (argument === '') return "''";
  return argument
    .split(/(\r|\n)/u)
    .filter(piece => piece !== '')
    .map(piece => {
      if (piece === '\n') return '"\\n"';
      if (piece === '\r') return '"\\r"';
      return `'${piece.replaceAll("'", `'"'"'`)}'`;
    })
    .join('');
}
