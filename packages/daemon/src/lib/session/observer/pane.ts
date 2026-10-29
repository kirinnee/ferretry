import type { PaneState } from '../../tmux/contracts.ts';
import { parseHarnessDialog } from '../../tmux/harness-dialog.ts';
import { paneActiveWork, paneBlockingPrompt, paneShowsPermissionPrompt } from '../../tmux/pane.ts';
import { parsePermissionPrompt } from '../../tmux/permission-prompt.ts';
import type { TurnPaneEvidence } from '../turn/policy.ts';

/**
 * What one live frame of an agent's pane says about its turn, read by the daemon's pane parsers — the
 * same reading wherever the frame was captured (the main thread's tmux client or a session worker's own).
 */
export function turnPaneEvidenceOf(pane: PaneState): TurnPaneEvidence {
  const request = parsePermissionPrompt(pane.visible);
  const work = paneActiveWork(pane.visible);
  return {
    working: work !== undefined,
    ...(work === 'spinner' ? { spinnerOnly: true } : {}),
    atPrompt: pane.promptReady,
    permission: request !== undefined || paneShowsPermissionPrompt(pane.visible),
    prompt: paneBlockingPrompt(pane.visible),
    request,
    dialog: parseHarnessDialog(pane.visible),
  };
}
