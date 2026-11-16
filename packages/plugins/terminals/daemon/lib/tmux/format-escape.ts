/**
 * The ONE rule for text that reaches a tmux argument tmux expands as a FORMAT.
 *
 * tmux runs `format_single` over the `-c <start-directory>` of `new-session`, `new-window` and
 * `split-window` (and over `-n`/`-s` names), so a folder literally named `#(touch pwned)` runs that command
 * inside the tmux server. `##` is tmux's own spelling of a literal `#`: doubling every `#` leaves nothing for
 * the expander to act on, and the directory tmux opens is the one named.
 *
 * Plain `set-option` values are NOT expanded (only `-F` does it), and `-e NAME=value` and the program argv
 * are not either, so this is for start directories and names only.
 */
export function escapeTmuxFormat(text: string): string {
  return text.replaceAll('#', '##');
}

/** A start directory made safe for tmux's `-c`. */
export function tmuxStartDirectory(directory: string): string {
  return escapeTmuxFormat(directory);
}
