import type { PaneParsers, PaneState } from '../peers/tmux.ts';
import type { TurnPaneEvidence } from '../peers/turn.ts';

/**
 * What one live frame of an agent's pane says about its turn, read by the daemon's pane parsers — the
 * same reading wherever the frame was captured (the main thread's tmux client or a session worker's own).
 * The parsers are the terminals plugin's, handed in by the host (Ferrets cannot import them).
 */
export function turnPaneEvidenceOf(pane: PaneState, parsers: PaneParsers): TurnPaneEvidence {
  const request = parsers.parsePermissionPrompt(pane.visible);
  const work = parsers.paneActiveWork(pane.visible);
  return {
    working: work !== undefined,
    ...(work === 'spinner' ? { spinnerOnly: true } : {}),
    // An idle composer holding a draft is still an idle prompt; `promptReady` (accepts a send) says no to it.
    atPrompt: pane.promptReady || (!pane.dead && parsers.idlePromptShown(pane.visible)),
    permission: request !== undefined || parsers.paneShowsPermissionPrompt(pane.visible),
    prompt: parsers.paneBlockingPrompt(pane.visible),
    request,
    dialog: parsers.parseHarnessDialog(pane.visible),
  };
}
