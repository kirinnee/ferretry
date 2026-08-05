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

/** Set to `0` in the environment to launch without seeding the harness's first-run state. */
export const FIRST_RUN_SEED_TOGGLE = 'FY_SEED_FIRST_RUN';

/**
 * jq filter proving every first-run flag is already what it needs to be, so the usual launch does
 * nothing at all. `$ENV` rather than `--arg`: the same mechanism carries the API key below, and one
 * way of passing a value into jq is easier to keep right than two.
 */
const SEEDED_ALREADY = [
  '((.projects[$ENV.FY_SEED_PWD].hasTrustDialogAccepted) == true)',
  'and (.hasCompletedOnboarding == true)',
  'and (.hasCompletedClaudeInChromeOnboarding == true)',
  'and (.claudeInChromeDefaultEnabled != null)',
].join(' ');

/**
 * The seeding filter. `claudeInChromeDefaultEnabled` is written **only when null**, because it is the
 * actual gate for the browser prompt and a home where somebody deliberately chose `true` must not be
 * silently turned off.
 */
const SEED_FILTER = [
  '.projects[$ENV.FY_SEED_PWD].hasTrustDialogAccepted = true',
  '| .hasCompletedOnboarding = true',
  '| .hasCompletedClaudeInChromeOnboarding = true',
  '| (if .claudeInChromeDefaultEnabled == null then .claudeInChromeDefaultEnabled = false else . end)',
].join(' ');

const SEED_NEW_DOCUMENT = [
  '{projects: {($ENV.FY_SEED_PWD): {hasTrustDialogAccepted: true}}',
  ', hasCompletedOnboarding: true',
  ', hasCompletedClaudeInChromeOnboarding: true',
  ', claudeInChromeDefaultEnabled: false}',
].join('');

/**
 * The one-time prompts that would otherwise stall a launch nobody is watching, seeded into the
 * account's own `.claude.json` before the harness starts.
 *
 * **Why the wrapper and not provisioning.** The state has to hold at *every* launch, not once at the
 * moment a fleet was applied. A home rebuilt, a preference reset, a harness upgrade that reintroduces
 * a prompt — each of those silently undoes an apply-time write, and the resulting failure is total
 * and invisible: a non-interactive session simply hangs at a question no one can see. A line in the
 * wrapper re-asserts on every invocation and cannot drift out from under the fleet.
 *
 * **What it seeds, and why each one.** Folder trust for the working directory, the onboarding flow,
 * the browser-onboarding step, and `claudeInChromeDefaultEnabled` — the actual gate for the "use my
 * browser?" prompt, which shows while that key is null. Then, when the account exports its own API
 * key, the key is recorded as approved: the harness's "detected a custom API key, use it?" dialog
 * defaults to **No** and blocks the session until somebody answers, and the wrapper exported that key
 * on purpose.
 *
 * **What it will not do.** It writes nothing when everything is already set, so an ordinary launch
 * costs one `jq` and no write. It never overwrites a deliberate choice. It cannot fail the launch:
 * every step is guarded, a failed rewrite discards its temporary file, and `exec` follows regardless.
 * Without `jq` it says so on stderr rather than skipping in silence — a launch that may stall for a
 * reason nobody was told about is exactly the failure this exists to prevent.
 *
 * The value reaches `jq` through the environment rather than `--arg`, so a key fragment never appears
 * in a process listing.
 */
const firstRunSeedLines = (kind: HarnessKind): readonly string[] => {
  if (kind !== 'claude') return [];
  const home = `$${HARNESS_HOME_ENV.claude}`;
  return [
    '',
    '# Seed the one-time prompts that would otherwise stall a launch nobody is watching. Re-asserted',
    '# every run, because an apply-time write drifts when a home is rebuilt or a harness upgrades, and',
    `# the failure is silent and total. Set ${FIRST_RUN_SEED_TOGGLE}=0 to launch without it.`,
    `if [ "\${${FIRST_RUN_SEED_TOGGLE}:-1}" = "1" ]; then`,
    '  if command -v jq >/dev/null 2>&1; then',
    `    _fy_seed_cfg="${home}/.claude.json"`,
    '    FY_SEED_PWD="$PWD"',
    '    export FY_SEED_PWD',
    `    if ! jq -e '${SEEDED_ALREADY}' "$_fy_seed_cfg" >/dev/null 2>&1; then`,
    `      mkdir -p "${home}"`,
    // Alongside the destination so the rename is atomic, and 0600 from mktemp itself.
    `      _fy_seed_tmp="$(mktemp "${home}/.claude.json.fy-XXXXXX" 2>/dev/null)"`,
    '      if [ -n "$_fy_seed_tmp" ]; then',
    '        if [ -f "$_fy_seed_cfg" ]; then',
    `          _fy_seed_ok="$(jq '${SEED_FILTER}' "$_fy_seed_cfg" > "$_fy_seed_tmp" 2>/dev/null && echo y)"`,
    '        else',
    `          _fy_seed_ok="$(jq -n '${SEED_NEW_DOCUMENT}' > "$_fy_seed_tmp" 2>/dev/null && echo y)"`,
    '        fi',
    '        if [ "$_fy_seed_ok" = y ]; then',
    '          mv "$_fy_seed_tmp" "$_fy_seed_cfg"',
    '        else',
    '          rm -f "$_fy_seed_tmp"',
    '        fi',
    '      fi',
    '    fi',
    // The account exported this key deliberately; the harness still asks, and defaults to No.
    '    if [ -n "${ANTHROPIC_API_KEY:-}" ]; then',
    '      FY_SEED_KEY="$ANTHROPIC_API_KEY"',
    '      if [ "${#FY_SEED_KEY}" -gt 20 ]; then',
    '        FY_SEED_KEY="$(printf %s "$ANTHROPIC_API_KEY" | tail -c 20)"',
    '      fi',
    '      export FY_SEED_KEY',
    `      if ! jq -e '(.customApiKeyResponses.approved // []) | index($ENV.FY_SEED_KEY) != null' "$_fy_seed_cfg" >/dev/null 2>&1; then`,
    `        mkdir -p "${home}"`,
    `        _fy_seed_tmp="$(mktemp "${home}/.claude.json.fy-XXXXXX" 2>/dev/null)"`,
    '        if [ -n "$_fy_seed_tmp" ]; then',
    '          if [ -f "$_fy_seed_cfg" ]; then',
    `            _fy_seed_ok="$(jq '.customApiKeyResponses.approved = (((.customApiKeyResponses.approved // []) + [$ENV.FY_SEED_KEY]) | unique)' "$_fy_seed_cfg" > "$_fy_seed_tmp" 2>/dev/null && echo y)"`,
    '          else',
    `            _fy_seed_ok="$(jq -n '{customApiKeyResponses: {approved: [$ENV.FY_SEED_KEY]}}' > "$_fy_seed_tmp" 2>/dev/null && echo y)"`,
    '          fi',
    '          if [ "$_fy_seed_ok" = y ]; then',
    '            mv "$_fy_seed_tmp" "$_fy_seed_cfg"',
    '          else',
    '            rm -f "$_fy_seed_tmp"',
    '          fi',
    '        fi',
    '      fi',
    '      unset FY_SEED_KEY',
    '    fi',
    '    unset FY_SEED_PWD',
    '  else',
    `    echo "ferretry: jq is not installed, so this account's first-run prompts were not seeded — a launch nobody is watching may stall at one. Install jq, or set ${FIRST_RUN_SEED_TOGGLE}=0 to silence this." >&2`,
    '  fi',
    'fi',
  ];
};

/**
 * Render the launch script for one account.
 *
 * Order matters and is fixed: source secrets, guard the references the account depends on, bind the
 * harness to its declared home, export the rest of the environment, seed the harness's first-run
 * state, then exec. Environment keys are emitted in sorted order so re-rendering an unchanged account
 * is byte-identical.
 *
 * Seeding comes last because it reads what the exports above decided — the account's home, and the
 * API key it chose to export.
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

  lines.push(...firstRunSeedLines(account.kind));

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
  constructor(
    readonly wrapper: string,
    readonly target: string,
  ) {
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
