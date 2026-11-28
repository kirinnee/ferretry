/**
 * Claude's launch line: the lines and arguments a runtime's wrapper script adds for Claude Code. Moved from Runtimes'
 * `wrappers.ts` with the text unchanged (E-276 PR 8); Runtimes still owns the script's frame (secrets, environment, the
 * history claim, the `exec`) and calls these members where it used to branch on the harness.
 */
import type {
  KitAutonomousPreludeInput,
  KitInstructionArgument,
  RuntimesHarnessKit,
} from '@ferretry/plugin-runtimes/contract';
import { CLAUDE_PROMPTS_SEEN } from '../harness/fixed-layer.ts';
import { CLAUDE_NO_QUESTIONS_FLAG } from '../harness/launch.ts';

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
const firstRunSeedLines = (input: KitAutonomousPreludeInput): readonly string[] => {
  const home = `$${input.homeEnv}`;
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
 * The arguments that may name a conversation: the shell `case` patterns a wrapper looks for before it pays for a `fy
 * history claim`. Wider than what names one — `--resume` alone opens a picker — because `fy` decides exactly (Ferrets'
 * `fy history claim`, `conversationFromArguments` in `core/ferrets/contract/conversation-lease.ts`); this only keeps an
 * ordinary launch from running it.
 */
const CONVERSATION_ARGUMENT_PATTERNS = '--resume|--resume=*|-r|--session-id|--session-id=*';

/** The launch arguments that start a runtime on its model set's default (§8.3). */
const modelArgs = (model: string): readonly string[] => ['--model', model];

/** A per-ferret section as Claude's own argument carries it: as written. */
const quoteSection = (text: string): string => text;

/**
 * The instruction argument, which takes this ferret's sections after its text: Claude's `--append-system-prompt=…`;
 * `undefined` for any other argument.
 */
const instructionArgument = (arg: string): KitInstructionArgument | undefined =>
  arg.startsWith('--append-system-prompt=') ? { before: arg, after: '' } : undefined;

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
const promptSnapshotLines = (command: string): readonly string[] => [
  // Bounded, and with no terminal to read: a launch must never wait on a harness that answers `--help`
  // by starting a session. Three seconds, then the probe is killed and no flag is added.
  `_fy_help="$({ ${command} --help </dev/null 2>/dev/null & _fy_p=$!; { sleep 3; kill "$_fy_p"; } >/dev/null 2>&1 & _fy_k=$!; wait "$_fy_p" 2>/dev/null; kill "$_fy_k" 2>/dev/null; })"`,
  `case "$_fy_help" in *--system-prompt-snapshot*) set -- ${CLAUDE_PROMPT_SNAPSHOT_OFF} "$@" ;; esac`,
];

/**
 * The question tool (owner !A527): withheld from EVERY agent ferret, an interactive one included, so none stops on a form
 * only the pane shows; it asks through the agenda. Prepended to `"$@"` in the `=` / non-variadic spelling so the prompt
 * that follows is never swallowed as a tool name.
 */
const questionLines = (): readonly string[] => [`set -- ${CLAUDE_NO_QUESTIONS_FLAG} "$@"`];

/** Claude's launch line. */
export const claudeWrapperKit: RuntimesHarnessKit = {
  wrapper: {
    conversationArgs: CONVERSATION_ARGUMENT_PATTERNS,
    modelArgs,
    quoteSection,
    instructionArgument,
    questionLines,
    // The wrapper prepends this flag itself (`questionLines`), so the exec line drops the copy the fixed layer carries.
    suppliedArguments: [CLAUDE_NO_QUESTIONS_FLAG],
    autonomousPrelude: firstRunSeedLines,
    promptSnapshotLines,
  },
};
