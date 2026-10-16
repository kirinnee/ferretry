/**
 * THE LIVE ACTIVITY LINE — the bottom of the conversation while an agent works.
 *
 * It says what the harness itself says: Claude's `Pontificating… 42s · ↓ 3.1k tokens`, Codex's
 * `Working… 6m52s`. Those words come off the agent's own pane (`lib/pane-activity.ts`), read while
 * the session is live and the page is visible, and never for a finished or parked one. A capture is
 * a local terminal read — it starts no turn and spends no tokens.
 *
 * THE SAME READ DECIDES WHETHER THE LINE SHOWS AT ALL. A frame with no status line is an agent at
 * its prompt, and `lib/session-activity.ts` turns that into "ready" — which is how a brand-new
 * session, `running` from the moment it launched, stops showing a spinner nobody started.
 *
 * WHEN THE PANE CANNOT BE READ the line still tells the truth, in fewer words: the daemon's own
 * activity sentence, or `Working…`. A failed read is not shown as an error. The line is a courtesy,
 * the transcript underneath is the record, and a red banner over a working session because one
 * capture failed would be a louder lie than a vaguer sentence.
 */

import { useEffect, useState } from 'react';
import { type PaneActivity, paneActivityDetail, parsePaneActivity } from '../lib/pane-activity.ts';
import { type PaneReading, UNREAD_PANE } from '../lib/session-activity.ts';
import { thinkingActivityLabel } from './thinking-indicator.tsx';

/** Reads the agent's pane as it is right now. */
export type PaneFrameReader = (signal: AbortSignal) => Promise<string>;

/** Often enough that the harness's own clock reads as moving, rarely enough to be cheap. */
const PANE_ACTIVITY_INTERVAL_MS = 2_500;

const documentHidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * The agent's pane as last read while `active`: whether a frame was read, and the harness's live
 * status line in it. Unread while inactive, before the first read lands, and after a failed read.
 *
 * One read in flight at a time: the next is scheduled only after the previous one settles, so a slow
 * daemon slows the line down rather than stacking captures behind it. Turning inactive aborts the
 * read in flight and clears the line in the same commit.
 */
export function usePaneActivity(
  read: PaneFrameReader | undefined,
  active: boolean,
  intervalMs = PANE_ACTIVITY_INTERVAL_MS,
): PaneReading {
  const [reading, setReading] = useState<PaneReading>(UNREAD_PANE);
  useEffect(() => {
    setReading(UNREAD_PANE);
    if (!active || read === undefined) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      if (!documentHidden()) {
        try {
          const frame = await read(controller.signal);
          if (!controller.signal.aborted) setReading({ read: true, activity: parsePaneActivity(frame) });
        } catch {
          if (!controller.signal.aborted) setReading(UNREAD_PANE);
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void tick(), intervalMs);
    };
    void tick();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, intervalMs, read]);
  return reading;
}

export interface LiveActivityLineProps {
  /** The harness's own line, when the pane showed one. */
  readonly activity: PaneActivity | null;
  /** The daemon's activity sentence, used when the pane said nothing readable. */
  readonly fallback?: string | null;
}

export function LiveActivityLine({ activity, fallback }: LiveActivityLineProps) {
  const verb = activity?.verb ?? thinkingActivityLabel(fallback);
  const detail = activity === null ? '' : paneActivityDetail(activity);
  return (
    <div
      className="fy-live-activity"
      data-activity-harness={activity?.harness ?? 'unknown'}
      data-transcript-density="chrome"
      role="status"
    >
      <span aria-hidden="true" className="fy-live-activity-spinner" />
      <span className="min-w-0 truncate">
        <b>{verb}</b>
        {detail === '' ? null : <span className="fy-live-activity-detail"> {detail}</span>}
      </span>
    </div>
  );
}
