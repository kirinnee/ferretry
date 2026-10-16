/**
 * IS THIS LIVE SESSION WORKING, OR SITTING AT ITS PROMPT?
 *
 * The daemon's `running` means the agent's terminal is LIVE — it is written the moment a session is
 * launched, whether or not anything was asked of it — and nothing in the daemon moves a session off
 * `running` when a turn ends. So `running` cannot answer "is it working", and every surface that read
 * it that way showed a brand-new session, idle at its prompt with nothing sent, as `Running` with a
 * `Working…` spinner under an empty conversation.
 *
 * The answer comes from evidence, strongest first:
 *
 *   1. THE PANE. Both harnesses paint a status line while a turn runs — Claude's `✽ Pontificating…`,
 *      Codex's `• Working (6m52s …)` — and paint none at an idle prompt. A frame that shows one is
 *      working; a frame read successfully that shows none is at its prompt.
 *   2. THE DAEMON'S OWN RECORD, when no frame has been read (not yet, or the read failed). A send that
 *      started a turn records `promptReady: false`, which stays until a frame says otherwise; a
 *      session that has never been handed a turn is on turn zero, and so is at its prompt.
 *   3. OTHERWISE UNKNOWN, which keeps the old reading: a live session is treated as working, so a
 *      pane this device cannot read never hides real work.
 *
 * Only a `running` session is ever called ready. Every other status already says what it is —
 * waiting, finished, starting — and this must never contradict one of them.
 */

import type { SessionView } from '@ferretry/protocol';
import type { PaneActivity } from './pane-activity.ts';

/** One read of the agent's pane: whether a frame was read at all, and the status line it showed. */
export interface PaneReading {
  /** A frame was read successfully. `false` before the first read lands and after a failed one. */
  readonly read: boolean;
  /** The harness's live status line in that frame, or `null` when it showed none. */
  readonly activity: PaneActivity | null;
}

export const UNREAD_PANE: PaneReading = Object.freeze({ read: false, activity: null });

/** Whether a live session is idle at its prompt, on the evidence above. */
export const sessionAtPrompt = (view: SessionView, pane: PaneReading): boolean => {
  const { state } = view;
  if (state.status !== 'running') return false;
  if (pane.activity !== null) return false;
  if (pane.read) return true;
  if (state.promptReady === false) return false;
  return state.promptReady === true || state.turn === 0;
};
