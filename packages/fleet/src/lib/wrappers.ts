/**
 * Wrapper rendering — turn one resolved account into the POSIX shell script that launches it.
 *
 * The rendering rules exist to keep credentials out of generated files:
 *
 * - A configured environment value of exactly `$NAME` or `${NAME}` is an **indirect reference**. It
 *   is emitted as a reference, so the secret lives in the configured secrets file and never in a
 *   generated script, a repository, or a test fixture.
 * - A value naming `${secret:NAME}` is **never emitted at all**. Ferretry's secret store holds it and
 *   the daemon puts it into the launch environment, so the script carries a REQUIREMENT — a guard
 *   naming the variable, the secret behind it, and what to do — and no value. See `./env-profiles.ts`
 *   for why a profile that authenticates an account is built this way.
 * - Every other value is a **literal**, emitted single-quoted so that no `$`, backtick or `$( )`
 *   inside it is ever interpreted. Configuration is trusted input, but a literal that silently
 *   became a command substitution would be a surprising way to find that out.
 * - The only file a wrapper sources is the configured secrets file. Absent means nothing is sourced.
 * - `home` and `wrapper` are taken from the account's declared attributes. Nothing is derived from,
 *   or parsed back out of, the generated text.
 *
 * Pure: every function here is string in, string out.
 */
import { type SecretName, secretReferencesIn } from '@ferretry/protocol';
import {
  CLAUDE_NO_QUESTIONS_FLAG,
  CLAUDE_PROMPTS_SEEN,
  CODEX_QUESTIONS_FEATURE,
  binaryName,
  FERRET_SECTIONS,
  SESSION_MODE_ENV,
  tomlString,
} from './account/fixed-layer.ts';
import type { HarnessKind } from './manifest.ts';
import { shellQuote } from './shell-quote.ts';

/** A generated executable that runs one runtime's wrapper with flags prepended. */
export interface ResolvedCommand {
  readonly wrapper: string;
  /** The runtime this command runs, by id. */
  readonly target: string;
  readonly flags: readonly string[];
  /** The alias that produced this command, when it was not declared explicitly. */
  readonly alias: string | undefined;
  /**
   * The absolute path the wrapper execs for its harness, as the daemon resolved it (docs/harness-paths.md).
   * Absent means the harness is not located on this host, and the wrapper then execs the bare name, which
   * is the one case where it can only fail or find what the person's own PATH holds.
   */
  readonly harnessCommand?: string | undefined;
}

/** Marks a script as generated, so provisioning can tell its own output from anything else. */
export const MANAGED_MARKER =
  "# ferretry-managed — regenerated when this machine's runtimes change; edits are overwritten";

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

export { shellQuote };

/**
 * Render a path that may be written relative to the user's home. `$HOME/x` and `~/x` become an
 * expanding `"$HOME/x"` so a generated script stays valid on another machine; anything else is an
 * inert literal.
 *
 * Only `$HOME` expands. A remainder holding anything a double-quoted word still interprets — a
 * `$(…)`, a `$var`, a backtick, a backslash or a quote — is single-quoted after the expanding prefix
 * instead, because inside `"$HOME/…"` it would run or substitute when the wrapper does. An ordinary
 * remainder keeps the one-word spelling, so the wrappers already on a host do not all change.
 */
export function shellPath(value: string): string {
  if (value === '~' || value === '$HOME') return '"$HOME"';
  for (const prefix of ['~/', '$HOME/']) {
    if (!value.startsWith(prefix)) continue;
    const rest = value.slice(prefix.length);
    return DOUBLE_QUOTE_ACTIVE.test(rest) ? `"$HOME"/${shellQuote(rest)}` : `"$HOME/${rest}"`;
  }
  return shellQuote(value);
}

/** The characters a double-quoted shell word still interprets. */
const DOUBLE_QUOTE_ACTIVE = /[$`\\"]/u;

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
 * The guard for a variable this daemon's secret store supplies.
 *
 * It is a REQUIREMENT and never an export, because there is nothing here to export: the value is in
 * the store, the daemon puts it into the launch environment, and a generated script that could
 * produce it would be a generated script holding a credential. What the script can do is refuse
 * clearly, so somebody running the wrapper straight from a shell — where nothing injected anything —
 * is told which secret is missing instead of watching the harness fail to authenticate.
 *
 * The secrets are named. A NAME IS NOT A SECRET, and a guard that said only "a credential is
 * missing" would leave a reader unable to tell which of an account's two references was the one to
 * go and set.
 */
const secretGuardLine = (name: string, secrets: readonly SecretName[]): string => {
  const which = `${secrets.length === 1 ? 'secret' : 'secrets'} ${secrets.join(', ')}`;
  return `: "\${${name}:?ferretry: ${name} is not set — this account takes it from Ferretry's secret store (${which}). Launch it through the daemon, or run: fy secret set ${secrets[0] ?? name}}"`;
};

/** Set to `0` in the environment to launch without seeding the harness's first-run state. */
const FIRST_RUN_SEED_TOGGLE = 'FY_SEED_FIRST_RUN';

/**
 * The "already seen" leaves of {@link CLAUDE_PROMPTS_SEEN} as jq paths. A boolean is seen when it is
 * `true`; a number is a count the harness shows the screen until it reaches, so a larger one is kept.
 */
const PROMPTS_SEEN_LEAVES: readonly { readonly path: string; readonly value: boolean | number }[] = Object.entries(
  CLAUDE_PROMPTS_SEEN,
).flatMap(([key, value]) =>
  typeof value === 'object'
    ? Object.keys(value).map(inner => ({ path: `.[${JSON.stringify(key)}][${JSON.stringify(inner)}]`, value: true }))
    : [{ path: `.[${JSON.stringify(key)}]`, value }],
);

const seenAlready = ({ path, value }: (typeof PROMPTS_SEEN_LEAVES)[number]): string =>
  typeof value === 'number' ? `((${path} // 0) >= ${value})` : `(${path} == true)`;

const seedSeen = ({ path, value }: (typeof PROMPTS_SEEN_LEAVES)[number]): string =>
  typeof value === 'number' ? `${path} = ([(${path} // 0), ${value}] | max)` : `${path} = true`;

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
  ...PROMPTS_SEEN_LEAVES.map(leaf => `and ${seenAlready(leaf)}`),
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
  ...PROMPTS_SEEN_LEAVES.map(leaf => `| ${seedSeen(leaf)}`),
].join(' ');

/** A home with no `.claude.json` yet gets the same filter, applied to an empty document. */
const SEED_NEW_DOCUMENT = `{} | ${SEED_FILTER}`;

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
 * browser?" prompt, which shows while that key is null. Then every one-shot dialog the harness
 * records as seen ({@link CLAUDE_PROMPTS_SEEN}): the auto-mode default nudge that parked a bypass
 * agent with every message failing, the effort nudge and the fullscreen upsell. Then, when the account exports its own API
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
 * The guard and export lines for one launch environment, sorted by variable so re-rendering an
 * unchanged runtime is byte-identical. A value naming a `${secret:NAME}` is neither a literal nor an
 * environment reference: nothing in a script may produce it, so it reaches only the guards.
 */
function environmentLines(
  env: Readonly<Record<string, string>>,
  secretsFile: string | undefined,
): { readonly guards: readonly string[]; readonly exports: readonly string[] } {
  const entries = Object.entries(env).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const storeBacked = entries.flatMap(([name, value]) => {
    const secrets = secretReferencesIn(value);
    return secrets.length === 0 ? [] : [[name, secrets] as const];
  });
  const referenced = entries.flatMap(([, value]) => {
    if (secretReferencesIn(value).length > 0) return [];
    const name = envReferenceName(value);
    return name === undefined ? [] : [name];
  });
  const guards = [
    ...[...new Set(referenced)].map(name => guardLine(name, secretsFile)),
    ...storeBacked.map(([name, secrets]) => secretGuardLine(name, secrets)),
  ];
  const storeBackedNames = new Set(storeBacked.map(([name]) => name));
  const exports = entries.flatMap(([name, value]) => {
    if (storeBackedNames.has(name)) return [];
    const reference = envReferenceName(value);
    return [`export ${name}=${reference === undefined ? shellQuote(value) : `"\${${reference}}"`}`];
  });
  return { guards, exports };
}

// ── Account-model runtimes (docs/design/account-model.md §8.4) ──────────────────────────────────

/**
 * The exit status `fy history claim` reports when another live writer HOLDS the conversation, and the
 * one status a runtime wrapper turns into not launching (§9.3).
 *
 * It has to be distinct from every other way `fy` can fail. A lease bug, a damaged store or a missing
 * `fy` must never stop the person's own CLI from starting, so the wrapper launches anyway on any other
 * non-zero status — and it can only tell "refused" from "broken" if refused has a number of its own.
 * 75 is `EX_TEMPFAIL`: the conversation is busy now and will not be later.
 */
export const HISTORY_CLAIM_HELD_EXIT_CODE = 75;

/** The variable naming the runtime a wrapper launches, read by `fy history claim` for its refusal sentence. */
export const RUNTIME_NAME_ENV = 'FY_RUNTIME';

/** The variable naming Ferretry's state home, so a child `fy` reads the same state as the wrapper's daemon. */
export const STATE_HOME_ENV = 'FY_HOME';

/** One runtime's launch, as everything its wrapper needs and nothing it has to work out. */
export interface RuntimeWrapperInput {
  /** The runtime's name: the word a person types, and the wrapper's file name. */
  readonly name: string;
  readonly id: string;
  readonly harness: HarnessKind;
  /** "Ferretry launches this as an agent" (R3). */
  readonly agent: boolean;
  /** Absolute path of the runtime's config directory. */
  readonly configDirectory: string;
  /**
   * The launch environment beyond the config directory, each value a literal, a `$NAME` reference or a
   * `${secret:NAME}` reference. Never `HOME`: the person's real home is kept (credentials.ts).
   */
  readonly env: Readonly<Record<string, string>>;
  /** Launch arguments before the person's own: the profile's flags and, for an agent, the fixed layer. */
  readonly args: readonly string[];
  /** The model the runtime starts with when nobody names one. A later `--model` the caller passes wins. */
  readonly defaultModel?: string | undefined;
  /** Claude agent runtimes: re-assert the trust and onboarding keys before every launch (§8.4). */
  readonly seedFirstRun?: boolean;
  /** Codex agent runtimes: trust the launch folder with the measured `-c projects={…}` table. */
  readonly trustLaunchFolder?: boolean;
  /** The `fy` executable a wrapper runs to claim a conversation it is about to resume. */
  readonly fyCommand: string;
  /**
   * The absolute path the wrapper execs for its harness, as the daemon resolved it (docs/harness-paths.md).
   * Absent means the harness is not located on this host, and the wrapper then execs the bare name.
   */
  readonly harnessCommand?: string | undefined;
  readonly secretsFile?: string | undefined;
  /**
   * Why this runtime cannot launch at all, when it cannot (O4, G5). The wrapper then says so and exits
   * non-zero rather than starting a harness that is set up wrong.
   */
  readonly refusal?: string | undefined;
}

/**
 * The arguments that may name a conversation, per harness: the shell `case` patterns a wrapper looks
 * for before it pays for a `fy history claim`. Wider than what names one — `--resume` alone opens a
 * picker — because `fy` decides exactly (`conversationFromArguments` in `./shared-history.ts`);
 * this only keeps an ordinary launch from running it.
 */
const CONVERSATION_ARGUMENT_PATTERNS: Readonly<Record<HarnessKind, string>> = {
  claude: '--resume|--resume=*|-r|--session-id|--session-id=*',
  codex: 'resume',
};

/**
 * One live writer per conversation (§9.3): claim the conversation before `exec` hands this pid to the
 * harness. Exits ONLY when the claim is refused because somebody else is writing it. Every other
 * failure — no `fy`, a lease store that errors — prints one line and launches anyway, because a lease
 * bug must never stop the person's own CLI from starting.
 */
const historyClaimLines = (harness: HarnessKind, fyCommand: string): readonly string[] => {
  const fy = shellPath(fyCommand);
  return [
    '',
    '# One live writer per conversation: claim the one these arguments resume before handing this pid to',
    `# the harness. Only a refusal (exit ${HISTORY_CLAIM_HELD_EXIT_CODE}: another session is writing it) stops the launch; any other failure warns and launches anyway.`,
    '_fy_claim=0',
    'for _fy_arg in "$@"; do',
    `  case "$_fy_arg" in ${CONVERSATION_ARGUMENT_PATTERNS[harness]}) _fy_claim=1 ;; esac`,
    'done',
    'if [ "$_fy_claim" = 1 ]; then',
    `  if command -v ${fy} >/dev/null 2>&1; then`,
    `    ${fy} history claim --harness ${harness} --pid $$ --from-arguments -- "$@"`,
    '    _fy_status=$?',
    `    if [ "$_fy_status" -eq ${HISTORY_CLAIM_HELD_EXIT_CODE} ]; then exit ${HISTORY_CLAIM_HELD_EXIT_CODE}; fi`,
    '    if [ "$_fy_status" -ne 0 ]; then',
    '      echo "ferretry: could not check whether another session is writing this conversation (fy history claim exited $_fy_status), so launching anyway" >&2',
    '    fi',
    '  else',
    '    echo "ferretry: fy was not found, so this launch did not check whether another session is writing this conversation; launching anyway" >&2',
    '  fi',
    'fi',
  ];
};

/**
 * Codex's trust for the folder it is launched in, built at launch because only then is the folder
 * known — the measured TOML inline table `codexTrustOverride` (`./account/fixed-layer.ts`) produces, in shell.
 *
 * The folder is the PHYSICAL one (`pwd -P`), which is what Codex itself reads. Backslash and double
 * quote are the two characters a TOML basic string must escape; a folder holding a control character
 * would need `\uXXXX` escapes the shell cannot produce reliably, so it gets no override and says so —
 * a trust prompt, never a malformed `-c` that stops Codex starting.
 */
const codexTrustLines = (): readonly string[] => [
  '',
  '# Trust the launch folder (the measured -c projects={"<folder>"={trust_level="trusted"}} form).',
  '_fy_cwd="$(pwd -P 2>/dev/null)" || _fy_cwd="$PWD"',
  'case "$_fy_cwd" in',
  '  *[[:cntrl:]]*)',
  '    echo "ferretry: this folder\'s name holds a control character, so Codex may ask whether to trust it" >&2',
  '    ;;',
  '  *)',
  `    _fy_cwd="$(printf '%s' "$_fy_cwd" | sed 's/[\\\\"]/\\\\&/g')"`,
  '    set -- -c "projects={\\"$_fy_cwd\\"={trust_level=\\"trusted\\"}}" "$@"',
  '    ;;',
  'esac',
];

/** The launch arguments that start a runtime on its model set's default (§8.3). */
const defaultModelArgs = (harness: HarnessKind, model: string | undefined): readonly string[] => {
  if (model === undefined) return [];
  // Codex: a config override rather than `-m`, so a `-m` the caller passes still decides.
  return harness === 'claude' ? ['--model', model] : ['-c', `model=${tomlBasicString(model)}`];
};

/** A TOML basic string, for a value a Codex `-c` override carries. */
const tomlBasicString = (value: string): string => `"${value.replace(/[\\"]/gu, character => `\\${character}`)}"`;

/**
 * Render the launch script for one account-model runtime (§8.4).
 *
 * Both kinds of runtime export the config directory, the credential's variables and the `FY_*`
 * variables. An agent runtime's launch arguments carry the fixed layer, which outranks every file the
 * harness or the person can edit. Nothing here sets `HOME`: the person's real home is how both
 * harnesses find a `host` login, and on macOS how Claude finds the keychain at all.
 *
 * Order is fixed: refuse (when the runtime cannot launch), source secrets, guard, export, seed, claim
 * the conversation, trust the folder, exec. A non-agent runtime gets no permission mode and no seeding:
 * it behaves like the person's own CLI.
 */
export function renderRuntimeWrapperScript(input: RuntimeWrapperInput): string {
  const header = [
    '#!/bin/sh',
    MANAGED_MARKER,
    `# runtime ${input.name} ${input.id} (${input.harness}${input.agent ? ', agent' : ''})`,
    '',
  ];
  if (input.refusal !== undefined) {
    return [
      ...header,
      `echo ${shellQuote(`ferretry: ${input.name} cannot start: ${input.refusal}`)} >&2`,
      'exit 1',
      '',
    ].join('\n');
  }
  const environment = environmentLines(input.env, input.secretsFile);
  const sections = input.agent ? ferretSectionLines(input.harness, input.fyCommand) : [];
  const harness =
    input.harnessCommand === undefined ? HARNESS_BINARIES[input.harness] : shellPath(input.harnessCommand);
  const args = [...defaultModelArgs(input.harness, input.defaultModel), ...input.args]
    .filter(arg => arg !== CLAUDE_NO_QUESTIONS_FLAG)
    .map(arg => (sections.length > 0 ? instructionArgument(input.harness, arg) : undefined) ?? shellQuote(arg))
    .join(' ');
  return [
    ...header,
    ...sourceSecretsLines(input.secretsFile),
    ...(environment.guards.length > 0 ? [...environment.guards, ''] : []),
    `export ${HARNESS_HOME_ENV[input.harness]}=${shellPath(input.configDirectory)}`,
    ...environment.exports,
    ...(input.seedFirstRun === true ? firstRunSeedLines(input.harness) : []),
    ...historyClaimLines(input.harness, input.fyCommand),
    ...(input.trustLaunchFolder === true ? codexTrustLines() : []),
    ...(input.agent ? questionLines(input.harness) : []),
    ...sections,
    ...(sections.length > 0 ? promptSnapshotLines(input.harness, harness) : []),
    '',
    `exec ${harness}${args === '' ? '' : ` ${args}`} "$@"`,
    '',
  ].join('\n');
}

/** The shell variable the per-ferret sections are gathered into, already in the harness's own quoting. */
const SECTIONS_VARIABLE = '_fy_sections';

/**
 * The per-ferret sections of the appended system prompt (`FERRET_SECTIONS`, `./account/fixed-layer.ts`),
 * gathered at exec time from the switches the daemon wrote into this ferret's environment. Each is
 * appended after a blank line only when its variable is exactly `1`, so a wrapper run by hand — where
 * nothing set them — carries none.
 *
 * Codex's value is a TOML basic string, so each section is stored already escaped for one: escaping is
 * per character, so escaped pieces join into the escaped whole.
 */
function ferretSectionLines(harness: HarnessKind, fyCommand: string): string[] {
  const fy = binaryName(fyCommand);
  const quoted = (text: string): string => shellQuote(harness === 'codex' ? tomlString(text).slice(1, -1) : text);
  return [
    '',
    "# This ferret's own sections of the appended system prompt: each switch the daemon set to 1.",
    `${SECTIONS_VARIABLE}=''`,
    ...FERRET_SECTIONS(fy).map(
      section =>
        `if [ "\${${section.env}:-0}" = 1 ]; then ${SECTIONS_VARIABLE}="$${SECTIONS_VARIABLE}"${quoted(`\n\n${section.text}`)}; fi`,
    ),
  ];
}

/**
 * The instruction argument with this ferret's sections appended, as shell; `undefined` for any other
 * argument. The literal stays single-quoted and the variable is joined to it double-quoted, so neither
 * can be split or expanded: Claude's `--append-system-prompt=…`, and Codex's
 * `developer_instructions="…"` with the sections inside its closing quote.
 */
function instructionArgument(harness: HarnessKind, arg: string): string | undefined {
  if (harness === 'claude')
    return arg.startsWith('--append-system-prompt=') ? `${shellQuote(arg)}"$${SECTIONS_VARIABLE}"` : undefined;
  if (!arg.startsWith('developer_instructions="') || !arg.endsWith('"')) return undefined;
  return `${shellQuote(arg.slice(0, -1))}"$${SECTIONS_VARIABLE}"${shellQuote('"')}`;
}

/** Claude's switch for the system-prompt record a conversation keeps, spelled as one argument. */
const CLAUDE_PROMPT_SNAPSHOT_OFF = '--system-prompt-snapshot=off';

/**
 * A RESUMED CONVERSATION MUST HEAR THIS LAUNCH'S SECTIONS. Claude Code records a conversation's system
 * prompt at its first request and, by default, replays that record verbatim on every later request and
 * `--resume` — "even when a later launch passes different text" (`claude --help`,
 * `--system-prompt-snapshot`). Every Restart, migration, revive and import relaunches into the SAME
 * conversation, so without this the sections composed above would reach only a conversation's first
 * launch: a ferret started before a section existed, or with a switch off, would never be told, and the
 * owner's "takes effect at the next restart" would be false.
 *
 * Off is what Claude did before it recorded at all: the prompt is rendered on each request. Asked of the
 * installed Claude at exec time rather than assumed, because an older Claude refuses a flag it does not
 * know — and that refusal would be a ferret that cannot launch. Codex reads `developer_instructions` on
 * every launch, so it needs nothing.
 */
function promptSnapshotLines(harness: HarnessKind, command: string): string[] {
  if (harness !== 'claude') return [];
  // Bounded, and with no terminal to read: a launch must never wait on a harness that answers `--help`
  // by starting a session. Three seconds, then the probe is killed and no flag is added.
  return [
    `_fy_help="$({ ${command} --help </dev/null 2>/dev/null & _fy_p=$!; { sleep 3; kill "$_fy_p"; } >/dev/null 2>&1 & _fy_k=$!; wait "$_fy_p" 2>/dev/null; kill "$_fy_k" 2>/dev/null; })"`,
    `case "$_fy_help" in *--system-prompt-snapshot*) set -- ${CLAUDE_PROMPT_SNAPSHOT_OFF} "$@" ;; esac`,
  ];
}

/**
 * The question tool, per ferret (O3). Prepended to `"$@"` in the `=` / non-variadic spelling so the
 * prompt that follows is never swallowed as a tool name. A launch with no mode is unattended.
 */
function questionLines(harness: HarnessKind): string[] {
  const interactive = `[ "\${${SESSION_MODE_ENV}:-}" = interactive ]`;
  return harness === 'claude'
    ? [`${interactive} || set -- ${CLAUDE_NO_QUESTIONS_FLAG} "$@"`]
    : [`! ${interactive} || set -- --enable ${CODEX_QUESTIONS_FEATURE} "$@"`];
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
