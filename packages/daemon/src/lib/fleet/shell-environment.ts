/**
 * Reading the owner's LOGIN SHELL's environment, for the setup scan's env providers
 * (docs/provider-presets.md § Detect, docs/secrets.md "The setup scan reads your shell").
 *
 * A Bedrock or Vertex user's Claude Code is very often switched on by an `export` in `~/.zshrc`, which a
 * daemon under a service manager never sees: its own process environment is not the person's shell. So
 * the one way to know is to ask the shell, and the asking is fixed:
 *
 * - the shell is the one every terminal opens (`SystemLoginShell`), as a login and interactive shell
 *   (`-l -i`), so it reads exactly the rc files a terminal does;
 * - the command is a constant — {@link SHELL_ENVIRONMENT_COMMAND} — with nothing of anybody's in it;
 * - there is no terminal: stdin is `/dev/null`, `TERM=dumb`, and it is killed at
 *   {@link SHELL_ENVIRONMENT_TIMEOUT_MS};
 * - only what follows {@link SHELL_ENVIRONMENT_MARKER} is read, as NUL-separated `NAME=value` entries, so a
 *   banner an rc file prints, and a value that spans lines, cannot be mistaken for a variable;
 * - every entry is FILTERED THE MOMENT IT IS PARSED to the names a provider can be detected by; every
 *   other variable is dropped unread — never kept, never logged — and stderr is never read at all.
 *
 * A shell that does not answer in time, or answers with no marker, is `unavailable`, never an error:
 * the scan says it read `settings.json` and `config.toml` only.
 */
import type { ShellEnvironmentReading } from '@ferretry/fleet';

/** The marker printed before the environment. NUL-delimited, so no variable can contain it. */
export const SHELL_ENVIRONMENT_MARKER = '\u0000FY-ENV\u0000';

/** The one command the shell is asked to run. Fixed: no input of anybody's is ever part of it. */
export const SHELL_ENVIRONMENT_COMMAND = 'printf "\\0FY-ENV\\0"; command env -0';

/** How long an rc file may take (a slow `nvm`, a network mount) before the shell is killed. */
export const SHELL_ENVIRONMENT_TIMEOUT_MS = 5_000;

/** The most output read before the shell is treated as answering nonsense. */
export const SHELL_ENVIRONMENT_MAX_BYTES = 4 * 1024 * 1024;

/** Reading the login shell's environment, narrowed by `keep` as it is read. */
export interface ShellEnvironmentPort {
  read(keep: (name: string) => boolean): Promise<ShellEnvironmentReading>;
}

/** The argv the shell is started with: `<shell> -l -i -c <the fixed command>`. */
export function shellEnvironmentArgv(shell: string): readonly string[] {
  return [shell, '-l', '-i', '-c', SHELL_ENVIRONMENT_COMMAND];
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * The variables `keep` admits, out of what the shell printed: only the bytes after the LAST marker
 * (an rc file that printed one first cannot inject entries), only entries that end in a NUL (whatever a
 * logout file prints after `env` is never an entry), only `NAME=value` with a real variable name. A later
 * entry of the same name wins, as it does in an environment. `undefined` when there is no marker: the
 * shell never reached the command.
 */
export function parseShellEnvironment(
  output: string,
  keep: (name: string) => boolean,
): Readonly<Record<string, string>> | undefined {
  const at = output.lastIndexOf(SHELL_ENVIRONMENT_MARKER);
  if (at < 0) return undefined;
  const entries = output.slice(at + SHELL_ENVIRONMENT_MARKER.length).split('\u0000');
  // The last piece follows the last NUL: unterminated, so it is not an entry `env -0` wrote.
  entries.pop();
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const equals = entry.indexOf('=');
    if (equals <= 0) continue;
    const name = entry.slice(0, equals);
    if (!NAME.test(name) || !keep(name)) continue;
    env[name] = entry.slice(equals + 1);
  }
  return env;
}
