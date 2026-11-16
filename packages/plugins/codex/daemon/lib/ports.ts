/**
 * The IO seam picker cleanup needs, declared here so the decision layer never
 * learns what tmux is.
 */

import type { PickerPaneObservation } from './dismiss.ts';

export interface CodexPickerPanePort {
  /**
   * The id of the pane the session's picker is on. Resolved ONCE per cleanup, so
   * every later command addresses the same pane rather than whichever one is
   * active at the time.
   */
  resolvePaneId(session: string): Promise<string>;
  /** The visible pane and whether its cursor sits at an idle prompt. */
  observe(paneId: string): Promise<PickerPaneObservation>;
  /** Send one Escape to that exact pane. */
  sendEscape(paneId: string): Promise<void>;
}
