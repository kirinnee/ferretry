/**
 * THE CHILD-SIDE API-KEY SEED: the one `.claude.json` key the daemon cannot write, because it never holds the value.
 *
 * Claude Code asks "detected a custom API key, use it?" when `ANTHROPIC_API_KEY` is set and its last 20 characters
 * are not in `.claude.json`'s `customApiKeyResponses.approved`; the dialog defaults to **No** and blocks the session
 * until somebody answers, so an unwatched ferret on an API-key runtime would stall there. The runtime exported that key
 * on purpose, so the launch records it as approved — today's wrapper seed (`fleet/src/lib/wrappers.ts`,
 * `firstRunSeedLines`), copied.
 *
 * The launch is `sh -c <this script> <name> <claude> <flags…>`: the child's own shell reads the key from its own
 * environment, so the value is never in an argv (jq reads it as `$ENV.FY_SEED_KEY`, never `--arg`), never read by the
 * daemon, never in a log. The script is a fixed constant: nothing a ferret or a person supplies is interpolated into
 * it; the home is the `CLAUDE_CONFIG_DIR` the launch sets, and the command is the script's own positional arguments.
 *
 * Today's semantics, step by step:
 * - no key in the environment, or no `jq`, or no home: nothing is written (a missing `jq` is said on stderr, the way
 *   today's wrapper said it, because a launch that may stall for a reason nobody was told about is the failure this
 *   prevents);
 * - at most the last 20 characters are recorded;
 * - already approved: nothing is written (one `jq` read per launch);
 * - otherwise the tail is appended (`unique`, so never twice) to a temporary file made by `mktemp` (0600) beside the
 *   document, which then replaces it with `mv` (atomic, same folder); a home with no document gets one holding only
 *   the approval;
 * - a document `jq` cannot read is LEFT AS IT IS: the failed rewrite discards its temporary file;
 * - the document is never followed through a link (the launch writes only that ferret's own home);
 * - the key's copy is unset, and `exec` runs claude whatever happened above.
 */

/** `$0` of the seed shell: what a process listing shows for the moment before `exec`. */
export const API_KEY_SEED_NAME = 'claude-code-api-key-seed';

/** The shell the seed runs in: POSIX, at the same path on Linux and macOS. */
export const API_KEY_SEED_SHELL = '/bin/sh';

/** The longest tail Claude Code compares a key by. */
const API_KEY_TAIL_LENGTH = 20;

const APPROVED = `(.customApiKeyResponses.approved // [])`;

export const API_KEY_SEED_SCRIPT = [
  // A shell trace (SHELLOPTS=xtrace imported by a bash /bin/sh) would print the key into the pane: switch it off first.
  'set +x',
  'if [ -n "${ANTHROPIC_API_KEY:-}" ] && [ -n "${CLAUDE_CONFIG_DIR:-}" ] && [ -d "$CLAUDE_CONFIG_DIR" ]; then',
  '  if command -v jq >/dev/null 2>&1; then',
  '    _seed_cfg="$CLAUDE_CONFIG_DIR/.claude.json"',
  '    FY_SEED_KEY="$ANTHROPIC_API_KEY"',
  `    if [ "\${#FY_SEED_KEY}" -gt ${API_KEY_TAIL_LENGTH} ]; then`,
  `      FY_SEED_KEY="$(printf %s "$ANTHROPIC_API_KEY" | tail -c ${API_KEY_TAIL_LENGTH})"`,
  '    fi',
  '    export FY_SEED_KEY',
  '    if [ ! -L "$_seed_cfg" ] && ! jq -e \'' +
    `${APPROVED} | index($ENV.FY_SEED_KEY) != null` +
    '\' "$_seed_cfg" >/dev/null 2>&1; then',
  '      _seed_tmp="$(mktemp "$CLAUDE_CONFIG_DIR/.claude.json.fy-XXXXXX" 2>/dev/null)"',
  '      if [ -n "$_seed_tmp" ]; then',
  '        _seed_ok=',
  '        if [ -f "$_seed_cfg" ]; then',
  '          _seed_ok="$(jq \'' +
    `.customApiKeyResponses.approved = ((${APPROVED} + [$ENV.FY_SEED_KEY]) | unique)` +
    '\' "$_seed_cfg" > "$_seed_tmp" 2>/dev/null && echo y)"',
  '        elif [ ! -e "$_seed_cfg" ]; then',
  '          _seed_ok="$(jq -n \'{customApiKeyResponses: {approved: [$ENV.FY_SEED_KEY]}}\' > "$_seed_tmp" 2>/dev/null && echo y)"',
  '        fi',
  '        if [ "$_seed_ok" = y ]; then',
  '          mv -f "$_seed_tmp" "$_seed_cfg" 2>/dev/null || rm -f "$_seed_tmp"',
  '        else',
  '          rm -f "$_seed_tmp"',
  '        fi',
  '      fi',
  '    fi',
  '    unset FY_SEED_KEY _seed_cfg _seed_tmp _seed_ok',
  '  else',
  '    echo "claude-code: jq is not installed, so this API key was not recorded as approved; a launch nobody is watching may stall at Claude\'s use-this-API-key prompt. Install jq." >&2',
  '  fi',
  'fi',
  'exec "$@"',
].join('\n');

/** `argv` → the same argv run through the seed: the seed's positional arguments ARE the command it execs. */
export function seededCommand(command: readonly string[]): readonly string[] {
  return [API_KEY_SEED_SHELL, '-c', API_KEY_SEED_SCRIPT, API_KEY_SEED_NAME, ...command];
}
