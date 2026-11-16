/**
 * THE DANGEROUS-`rm` HOOK: a ferret's Bash call that Claude Code would stop on its "Dangerous rm operation detected"
 * prompt is DENIED UP FRONT, with the reason, instead of parking the ferret on a prompt until somebody notices (the
 * Warden's dialog look is the backstop for whatever this does not catch).
 *
 * ═══ WHY A `PreToolUse` HOOK, AND WHY ONLY THESE SHAPES ═══
 *
 * Read off the Claude Code 2.1.317 binary's strings (never by running it): the prompt comes from a shell PARSER inside
 * Claude that has a dozen branches (an `rm` on a possibly-empty variable path, on the output of a command substitution, in
 * a `bash -c` script, an `eval` trap, a parse it could not finish…). A shell script cannot reproduce that parser, so this
 * hook does not try: it denies the three shapes the owner named — an `rm` whose target BEGINS with a variable or a command
 * substitution, and an `rm` inside a `sh`/`bash -c` script — and says why, so the agent writes the explicit path. A hook's
 * `deny` is honoured before any permission prompt and in every permission mode, so the ferret never waits. Anything the
 * hook does not recognise still reaches Claude's own check and, if Claude stops on it, the Warden's rule declines it.
 *
 * NOT a `PermissionRequest` hook (it would answer a prompt Claude already drew) and NOT a Bash deny or ask permission
 * RULE (a rule matches on a command's literal prefix, and would block `rm` of a literal path the owner allows).
 *
 * The match is `grep -E` over the hook's raw JSON input, so it needs no `jq`, `bun` or Python in a ferret's environment. An
 * `rm` must stand where a command stands (after a quote, `;`, `&`, `|`, `(`, `{`, a backtick, a newline or `sudo`…), so
 * `git rm "$f"`, `docker rm $id` and `confirm $x` are left alone. It fails OPEN: any error is exit 0 with no output.
 */

/** What the agent is told when its command is denied. */
export const CLAUDE_DANGEROUS_RM_REASON =
  'use explicit absolute rm paths; never "$VAR", a $(cmd) variable or rm inside bash -c';

/** Where a command may start inside the hook's JSON: after a quote, an operator, a newline escape, or a wrapper word. */
const BACKTICK = '`';
const COMMAND_START = String.raw`(["${BACKTICK};&|(){]|\\n|(sudo|xargs|exec|command|time|then|do|else)[[:space:]]+)[[:space:]]*`;

/** `rm` / `rmdir`, then its flags, then a target that begins with `$`… or a backtick. */
const RM_OF_VARIABLE = String.raw`${COMMAND_START}rm(dir)?[[:space:]]+(-[^[:space:]]*[[:space:]]+)*[\\"]*[$${BACKTICK}]`;

/** A `sh` / `bash` / `zsh` / `dash` `-c` script that runs `rm`. */
const RM_IN_SHELL_SCRIPT = String.raw`${COMMAND_START}(ba|z|da)?sh[[:space:]]+(-[a-zA-Z]*[[:space:]]+)*-[a-zA-Z]*c[[:space:]].*(^|[^[:alnum:]_./-])rm(dir)?[[:space:]]`;

const DENY = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: CLAUDE_DANGEROUS_RM_REASON,
  },
});

/** The command the hook runs: it reads the call's JSON on stdin and prints a deny, or nothing. Always exits 0. */
export const CLAUDE_DANGEROUS_RM_HOOK_COMMAND = `in=$(cat 2>/dev/null); if printf '%s' "$in" | grep -Eq '${RM_OF_VARIABLE}|${RM_IN_SHELL_SCRIPT}' 2>/dev/null; then printf '%s\\n' '${DENY}'; fi; exit 0`;

/** The `PreToolUse` entry for Claude's Bash tool. */
export const CLAUDE_DANGEROUS_RM_HOOKS = {
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: CLAUDE_DANGEROUS_RM_HOOK_COMMAND }] }],
};
