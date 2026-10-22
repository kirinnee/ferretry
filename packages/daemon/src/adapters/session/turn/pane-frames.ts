import type { ClockPort } from '../../../lib/ports.ts';
import { turnPaneEvidenceOf } from '../../../lib/session/observer/pane.ts';
import type { TurnPaneEvidence } from '../../../lib/session/turn/policy.ts';
import type { PaneActivity, PaneState } from '../../../lib/tmux/contracts.ts';
import { type CapturedFrame, capturedFrameIsCurrent, paneStateFrom } from '../../../lib/tmux/pane.ts';

/** The two terminal reads a look makes of one tmux session, as `TmuxController` answers them. */
export interface TurnPaneReader {
  /** Metadata and activity stamp in one question; `undefined` when the session is not there. */
  activity(tmuxSession: string): Promise<PaneActivity | undefined>;
  /** The visible frame; `undefined` when tmux could not capture it. */
  visible(tmuxSession: string): Promise<string | undefined>;
}

/**
 * A running pane's frames, captured only when they may have changed.
 *
 * ONE question a look asks for the pane's metadata and activity stamp, and the screen is captured again
 * only when that stamp says it may have changed (see {@link capturedFrameIsCurrent}). The scrollback is
 * never captured here: nothing a turn is decided from reads it. The main thread's turn ports and a
 * session worker read their panes through this one class, so a frame means the same on both.
 */
export class PaneFrames {
  /** The last frame captured of each running pane, by tmux session. */
  private readonly frames = new Map<string, CapturedFrame>();

  constructor(
    private readonly panes: TurnPaneReader,
    private readonly clock: ClockPort,
  ) {}

  /** The pane as captured now, or `undefined` when it is gone or dead. */
  async state(tmuxSession: string): Promise<PaneState | undefined> {
    const activity = await this.panes.activity(tmuxSession).catch(() => undefined);
    if (activity === undefined || activity.dead) {
      this.frames.delete(tmuxSession);
      return undefined;
    }
    const held = this.frames.get(tmuxSession);
    if (held !== undefined && capturedFrameIsCurrent(held, activity)) return paneStateFrom(activity, held.visible);
    const capturedAtSecond = Math.floor(Date.parse(this.clock.now()) / 1_000);
    const visible = await this.panes.visible(tmuxSession).catch(() => undefined);
    // A capture that failed reads as a blank live screen, as it always did — but is never held, so the
    // next look captures again instead of trusting a frame it never had.
    if (visible === undefined) this.frames.delete(tmuxSession);
    else this.frames.set(tmuxSession, { activity, visible, capturedAtSecond });
    return paneStateFrom(activity, visible ?? '');
  }

  /** The pane's turn evidence now, or `undefined` when there is no live pane to read. */
  async evidence(tmuxSession: string): Promise<TurnPaneEvidence | undefined> {
    const pane = await this.state(tmuxSession);
    return pane === undefined ? undefined : turnPaneEvidenceOf(pane);
  }

  /** Forgets a pane that is no longer watched. */
  forget(tmuxSession: string): void {
    this.frames.delete(tmuxSession);
  }
}
