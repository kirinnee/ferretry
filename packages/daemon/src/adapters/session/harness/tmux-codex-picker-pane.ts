import {
  activePaneIdArguments,
  capturePaneIdArguments,
  dismissPaneIdArguments,
  paneIdCursorArguments,
  parsePaneCursor,
  type CodexPickerPanePort,
  type PickerPaneObservation,
} from '../../../lib/index.ts';
import { promptIsReady } from '../../../lib/tmux/pane.ts';
import type { TmuxCommandPort } from '../../../lib/tmux/contracts.ts';

/**
 * Pane-scoped tmux access for Codex picker cleanup.
 *
 * It goes through `TmuxCommandPort`, which is the only thing that guarantees an
 * absolute private socket — a bare `tmux` here would reach whatever server the
 * host already runs, and this adapter's whole job is sending keys into a pane.
 *
 * Every failure is thrown rather than swallowed: cleanup reads a failed
 * inspection as "not confirmed idle", which is the safe reading, and it cannot do
 * that if a broken command comes back looking like an empty screen.
 */
export class TmuxCodexPickerPane implements CodexPickerPanePort {
  constructor(private readonly commands: TmuxCommandPort) {}

  async resolvePaneId(session: string): Promise<string> {
    const result = await this.commands.execute(activePaneIdArguments(session));
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `tmux could not resolve a pane for session ${session}`);
    }
    return result.stdout.trim();
  }

  async observe(paneId: string): Promise<PickerPaneObservation> {
    const [captured, cursor] = await Promise.all([
      this.commands.execute(capturePaneIdArguments(paneId)),
      this.commands.execute(paneIdCursorArguments(paneId)),
    ]);
    if (captured.code !== 0) throw new Error(captured.stderr.trim() || `tmux could not capture pane ${paneId}`);
    if (cursor.code !== 0) throw new Error(cursor.stderr.trim() || `tmux could not inspect pane ${paneId}`);
    const position = parsePaneCursor(cursor.stdout);
    if (position === undefined) {
      throw new Error(`tmux reported an unreadable cursor position for pane ${paneId}: ${cursor.stdout.trim()}`);
    }
    return {
      visiblePane: captured.stdout,
      promptReady: promptIsReady(captured.stdout, position.y, position.x),
    };
  }

  async sendEscape(paneId: string): Promise<void> {
    const result = await this.commands.execute(dismissPaneIdArguments(paneId));
    if (result.code !== 0)
      throw new Error(result.stderr.trim() || `tmux could not dismiss the picker on pane ${paneId}`);
  }
}
