/**
 * WHAT A HARNESS TOOL SHELL'S COMMAND LINE SAYS — the ONE reading of it that the Processes tab and the move gate share.
 *
 * Both harnesses run a tool command through a shell of their own, so the kernel's command line is the wrapper, not what
 * the agent asked for:
 *
 * - Claude Code: `zsh -c source <snapshot> … && eval '<command>' < /dev/null && pwd -P >| /tmp/claude-…-cwd`
 * - Codex: `bash -lc <command>`
 *
 * Two readers need the command back, and they disagree about how sure they must be. The Processes tab only titles a
 * row, so a near miss costs a slightly odd label ({@link commandLabel}). The move gate decides whether a running
 * process may be killed, so it must be certain the argv is Claude's own boilerplate AROUND the payload and nothing else
 * ({@link claudeToolShellPayload}). Both live here so the wrapper's shape is owned once, in one package the terminals
 * plugin and the ferrets core may both import (fact-ownership: two programs must agree on one fact).
 *
 * Pure: no IO, no clock.
 */

const CLAUDE_EVAL = /\beval '((?:[^']|'"'"'|'\\'')*)'(?: < \/dev\/null)? && pwd -P >\| \S*claude-[0-9a-f]+-cwd\s*$/su;
const SHELL_DASH_C = /^(?:\S*\/)?-?(?:bash|zsh|sh|dash|ksh|fish) (?:-[a-zA-Z]*c) (.+)$/su;

/** Undoes the two ways a single quote is spelled inside a single-quoted word. */
function unescapeSingleQuotes(quoted: string): string {
  return quoted.replaceAll(`'"'"'`, `'`).replaceAll(`'\\''`, `'`);
}

/**
 * Claude Code 2.1.x's Bash tool shell, in full and to the character. Every fixed piece of the wrapper is spelled out so
 * that nothing but the payload is free text:
 *
 * - the shell is a path ending `zsh`, handed `-c source <snapshot>.sh`, with the snapshot a plain path under a
 *   `shell-snapshots` folder (no quote, `$`, backtick, `;`, `&`, `|`, `<`, `>` or space can occur in it);
 * - `setopt` takes only upper-case option words, and its redirect is the fixed `2>/dev/null || true`;
 * - each `\builtin unalias`/`unset -f` block names one plain identifier, twice, with the fixed `>/dev/null 2>&1 || true`;
 * - the payload is ONE single-quoted word — a raw `'` can only be one of the two escapes — and nothing follows it but
 *   the fixed stdin redirect, the fixed `pwd -P >| …claude-<hex>-cwd`, and the end of the line.
 *
 * Anything else — an extra word, a second command, a changed redirect — fails the match, and the caller keeps treating
 * the argv as the opaque shell it is.
 */
const CLAUDE_TOOL_SHELL = new RegExp(
  [
    String.raw`^[\w./+-]*zsh -c source [\w./+-]*shell-snapshots/[\w./+-]+\.sh 2>/dev/null \|\| true`,
    String.raw`(?: && setopt(?: [A-Z_]+)+ 2>/dev/null \|\| true)?`,
    String.raw`(?: && \{ \\builtin unalias -- '\w+'; \\builtin unset -f -- '\w+'; \} >/dev/null 2>&1 \|\| true)*`,
    String.raw` && eval '((?:[^']|'"'"'|'\\'')*)'(?: < /dev/null)?`,
    String.raw` && pwd -P >\| [\w./+-]*claude-[0-9a-f]+-cwd$`,
  ].join(''),
  'u',
);

/**
 * The command the agent wrote, when `argv` is EXACTLY Claude Code's Bash tool shell around it; otherwise `undefined`.
 *
 * Stricter than {@link commandLabel}, which is for display: this one is for a safety decision. The payload comes back
 * un-quoted but otherwise untouched, so its own redirects and expansions are still its own.
 */
export function claudeToolShellPayload(argv: string): string | undefined {
  const payload = CLAUDE_TOOL_SHELL.exec(argv.trim())?.[1];
  return payload === undefined ? undefined : unescapeSingleQuotes(payload).trim() || undefined;
}

/** The command the agent asked for, when `argv` is a harness's wrapper around it; otherwise `undefined`. */
export function commandLabel(argv: string): string | undefined {
  const claude = CLAUDE_EVAL.exec(argv);
  if (claude?.[1] !== undefined) {
    const command = unescapeSingleQuotes(claude[1]).trim();
    return command === '' || command === argv ? undefined : command;
  }
  const shell = SHELL_DASH_C.exec(argv);
  const command = shell?.[1]?.trim();
  return command === undefined || command === '' || command === argv ? undefined : command;
}
