/**
 * The ONE rule for text that reaches a tmux argument tmux expands as a FORMAT.
 *
 * tmux runs `format_single` over the `-c <start-directory>` of `new-session`, `new-window` and
 * `split-window`, so a folder literally named `#(touch pwned)` runs that command inside the tmux server. `##`
 * is tmux's own spelling of a literal `#`: doubling every `#` leaves nothing for the expander to act on, and
 * the directory tmux opens is the one named.
 *
 * NAMES EXPAND TOO (verified on tmux 3.8): `new-session -s`, `-n`, `new-window -n`, `rename-session` and
 * `rename-window` all run the expander. Production is safe there for a different reason, not because tmux is
 * literal: every `-s` is validated by `sessionTarget` (`[a-z0-9_.-]`) or sanitised by `terminalTmuxSessionName`,
 * and no production code uses `-n` or a rename. Never claim a tmux name is intrinsically literal.
 *
 * NOT expanded: plain `set-option` values (only `-F` expands), `-e NAME=value`, the program argv, `send-keys`
 * payloads and `capture-pane -t` targets.
 */
export function escapeTmuxFormat(text: string): string {
  return text.replaceAll('#', '##');
}

/** A start directory made safe for tmux's `-c`. */
export function tmuxStartDirectory(directory: string): string {
  return escapeTmuxFormat(directory);
}
