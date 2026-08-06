import {
  activePaneIdArguments,
  capturePaneIdArguments,
  CodexPickerDriveError,
  type CodexPickerDrivePort,
  type CodexPickerFrame,
  type CodexPickerKeyExpectation,
  isAddressablePaneId,
  isAddressablePickerKey,
  type InjectionOutcome,
  pickerKeyPaneIdArguments,
  pickerStillShows,
  type TmuxController,
} from '../../../lib/index.ts';
import type { TmuxCommandPort } from '../../../lib/tmux/contracts.ts';
import type { TmuxPaneDelivery } from '../../tmux/pane-delivery.ts';

/**
 * Driving one session's Codex picker over the daemon's own private tmux socket.
 *
 * THE PICKER IS OPENED THROUGH THE ORDINARY DELIVERY PATH, not by typing keys at a pane. That path
 * already proves the payload reached the composer and left it, and it already classifies the result
 * — a `/model` Codex consumed itself is `handled-local`, and one it read as a message is
 * `turn-started`. Re-implementing either judgement here would give the daemon a second opinion about
 * whether it had just started a paid turn.
 *
 * EVERY KEY GOES TO A PANE ID, NEVER TO A SESSION NAME, and the id is re-resolved and re-verified
 * immediately before each one. Two independent reasons, and both have bitten this code's ancestor: a
 * session name resolves to whichever pane is active at the moment the command runs, and the picker
 * is asynchronous, so a digit aimed at a row that has since moved selects its replacement.
 *
 * THE VERIFICATION IS NOT ADVISORY. If the pane no longer shows the exact row the driver named, the
 * key is not sent at all — the drive fails and the caller's cleanup closes whatever is open. A "send
 * it anyway, it is probably still right" branch is how a model switch becomes a different model.
 */
export class TmuxCodexPickerDrive implements CodexPickerDrivePort {
  constructor(
    private readonly commands: TmuxCommandPort,
    private readonly tmux: TmuxController,
    private readonly delivery: TmuxPaneDelivery,
    /** The tmux session this driver is bound to. One instance drives one session. */
    private readonly session: string,
    /** The command that opens the harness's native picker. */
    private readonly openCommand: string,
  ) {}

  async openPicker(): Promise<InjectionOutcome> {
    return await this.delivery.deliver(this.session, this.openCommand);
  }

  async readPane(): Promise<CodexPickerFrame> {
    const state = await this.tmux.state(this.session);
    return { alive: state.alive, dead: state.dead, promptReady: state.promptReady, visible: state.visible };
  }

  async sendKey(key: string, expected: CodexPickerKeyExpectation): Promise<void> {
    if (!isAddressablePickerKey(key)) throw new CodexPickerDriveError(`refusing to send ${key} into a Codex picker`);
    if (expected.row.number !== Number(key))
      throw new CodexPickerDriveError('the Codex picker shortcut no longer matches the verified row');

    const resolved = await this.commands.execute(activePaneIdArguments(this.session));
    const paneId = resolved.stdout.trim();
    if (resolved.code !== 0 || !isAddressablePaneId(paneId))
      throw new CodexPickerDriveError(resolved.stderr.trim() || 'the Codex picker pane could not be resolved');

    const captured = await this.commands.execute(capturePaneIdArguments(paneId));
    if (captured.code !== 0)
      throw new CodexPickerDriveError(captured.stderr.trim() || `tmux could not capture pane ${paneId}`);
    if (!pickerStillShows(captured.stdout, expected))
      throw new CodexPickerDriveError('the Codex picker changed before the verified shortcut could be sent');

    const sent = await this.commands.execute(pickerKeyPaneIdArguments(paneId, key));
    if (sent.code !== 0) throw new CodexPickerDriveError(sent.stderr.trim() || 'tmux could not drive the Codex picker');
  }
}
