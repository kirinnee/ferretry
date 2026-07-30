/**
 * Wrapper rendering — turn one resolved account into the POSIX shell script that launches it.
 *
 * The rendering rules exist to keep credentials out of generated files:
 *
 * - A configured environment value of exactly `$NAME` or `${NAME}` is an **indirect reference**. It
 *   is emitted as a reference, so the secret lives in the configured secrets file and never in a
 *   generated script, a repository, or a test fixture.
 * - Every other value is a **literal**, emitted single-quoted so that no `$`, backtick or `$( )`
 *   inside it is ever interpreted. Configuration is trusted input, but a literal that silently
 *   became a command substitution would be a surprising way to find that out.
 * - The only file a wrapper sources is the configured secrets file. Absent means nothing is sourced.
 * - `home` and `wrapper` are taken from the account's declared attributes. Nothing is derived from,
 *   or parsed back out of, the generated text.
 *
 * Pure: every function here is string in, string out.
 */
import type { HarnessKind } from './manifest.ts';
import type { ResolvedAccount, ResolvedCommand } from './profiles.ts';

/** Marks a script as generated, so provisioning can tell its own output from anything else. */
export const MANAGED_MARKER = '# ferretry-managed — do not edit; regenerate with `fy fleet apply`';

/** The executable each harness launches. */
export const HARNESS_BINARIES: Readonly<Record<HarnessKind, string>> = {
  claude: 'claude',
  codex: 'codex',
};

/** The variable each harness reads its configuration directory from. */
export const HARNESS_HOME_ENV: Readonly<Record<HarnessKind, string>> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
};

const ENV_REFERENCE = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/;

/**
 * The variable name a value indirectly references, or `undefined` when the value is a literal.
 * Only a value that is *entirely* a reference counts; `prefix-$NAME` is a literal.
 */
export function envReferenceName(value: string): string | undefined {
  const match = ENV_REFERENCE.exec(value);
  if (match === null) return undefined;
  return match[1] ?? match[2];
}

/**
 * Quote a value for POSIX shell as an inert literal: wrap in single quotes and close/reopen around
 * any embedded single quote. Nothing inside the result is expanded.
 */
export function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * Render a path that may be written relative to the user's home. `$HOME/x` and `~/x` become an
 * expanding `"$HOME/x"` so a generated script stays valid on another machine; anything else is an
 * inert literal.
 */
export function shellPath(value: string): string {
  if (value === '~' || value === '$HOME') return '"$HOME"';
  for (const prefix of ['~/', '$HOME/']) {
    if (value.startsWith(prefix)) return `"$HOME/${value.slice(prefix.length)}"`;
  }
  return shellQuote(value);
}

export interface WrapperRenderOptions {
  /**
   * Shell file sourced before any environment is exported, so indirect references resolve.
   * Absent means the wrapper sources nothing.
   */
  readonly secretsFile?: string | undefined;
  /**
   * Emit a guard that fails with an actionable message when a referenced variable is unset.
   * Without it an unset reference silently becomes an empty string and the harness reports a
   * confusing authentication error instead of a missing secret. Defaults to `true`.
   */
  readonly guardEnvReferences?: boolean | undefined;
}

const sourceSecretsLines = (secretsFile: string | undefined): readonly string[] => {
  if (secretsFile === undefined) return [];
  const quoted = shellPath(secretsFile);
  return [`if [ -r ${quoted} ]; then`, `  . ${quoted}`, 'fi', ''];
};

const guardLine = (name: string, secretsFile: string | undefined): string => {
  const origin = secretsFile === undefined ? 'the environment' : secretsFile;
  return `: "\${${name}:?ferretry: ${name} is not set — expected it from ${origin}}"`;
};

/**
 * Render the launch script for one account.
 *
 * Order matters and is fixed: source secrets, guard the references the account depends on, bind the
 * harness to its declared home, export the rest of the environment, then exec. Environment keys are
 * emitted in sorted order so re-rendering an unchanged account is byte-identical.
 */
export function renderWrapperScript(account: ResolvedAccount, options: WrapperRenderOptions = {}): string {
  const { secretsFile } = options;
  const guard = options.guardEnvReferences ?? true;
  const entries = Object.entries(account.env).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  const referenced = entries.flatMap(([, value]) => {
    const name = envReferenceName(value);
    return name === undefined ? [] : [name];
  });
  const uniqueReferenced = [...new Set(referenced)];

  const lines: string[] = [
    '#!/bin/sh',
    MANAGED_MARKER,
    `# account ${account.id} (${account.kind}, ${account.mode})`,
    '',
    ...sourceSecretsLines(secretsFile),
    ...(guard && uniqueReferenced.length > 0
      ? [...uniqueReferenced.map(name => guardLine(name, secretsFile)), '']
      : []),
    `export ${HARNESS_HOME_ENV[account.kind]}=${shellPath(account.home)}`,
  ];

  for (const [name, value] of entries) {
    const reference = envReferenceName(value);
    lines.push(`export ${name}=${reference === undefined ? shellQuote(value) : `"\${${reference}}"`}`);
  }

  const flags = account.flags.map(shellQuote).join(' ');
  lines.push('', `exec ${HARNESS_BINARIES[account.kind]}${flags === '' ? '' : ` ${flags}`} "$@"`, '');
  return lines.join('\n');
}

/** What {@link renderCommandScript} needs: the command plus its target's declared wrapper name. */
export interface CommandRenderInput {
  readonly command: ResolvedCommand;
  /** The target account's declared wrapper name, resolved from its id by the caller. */
  readonly targetWrapper: string;
  /** Directory the generated wrappers live in. */
  readonly binDir: string;
}

/**
 * Render a command: exec the target account's wrapper with the command's flags prepended. The
 * target is located through the account's id, so an alias-shaped name never has to be parsed.
 */
export function renderCommandScript(input: CommandRenderInput): string {
  const { command, targetWrapper, binDir } = input;
  const separator = binDir.endsWith('/') ? '' : '/';
  const target = shellPath(`${binDir}${separator}${targetWrapper}`);
  const flags = command.flags.map(shellQuote).join(' ');
  return [
    '#!/bin/sh',
    MANAGED_MARKER,
    `# runs account ${command.target}`,
    '',
    `exec ${target}${flags === '' ? '' : ` ${flags}`} "$@"`,
    '',
  ].join('\n');
}

/** Raised when a command names an account that does not exist. */
export class UnknownCommandTargetError extends Error {
  constructor(readonly wrapper: string, readonly target: string) {
    super(`command "${wrapper}" targets unknown account "${target}"`);
    this.name = 'UnknownCommandTargetError';
  }
}

/**
 * Pair each command with its target's wrapper name. Throws on an unknown target rather than
 * emitting a script that would fail only when someone ran it.
 */
export function resolveCommandTargets(
  commands: readonly ResolvedCommand[],
  accounts: readonly ResolvedAccount[],
  binDir: string,
): readonly CommandRenderInput[] {
  const wrapperById = new Map(accounts.map(account => [account.id, account.wrapper]));
  return commands.map(command => {
    const targetWrapper = wrapperById.get(command.target);
    if (targetWrapper === undefined) throw new UnknownCommandTargetError(command.wrapper, command.target);
    return { command, targetWrapper, binDir };
  });
}
