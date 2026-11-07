import { sessionTarget } from '../session/peers/tmux-lifecycle.ts';

/**
 * The tmux command that prints a pane's text (today's `lib/tmux/commands.ts`, owned by Terminals; copied here beside the
 * `hasSessionArguments` the session peers already carry, because the preflight's codex footer read is the only caller in
 * Ferrets). `history` asks for the whole scrollback, not only the visible rows.
 */
export function capturePaneArguments(session: string, history: boolean): readonly string[] {
  return history
    ? ['capture-pane', '-p', '-S', '-', '-t', sessionTarget(session)]
    : ['capture-pane', '-p', '-t', sessionTarget(session)];
}
